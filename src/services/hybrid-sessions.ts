import crypto from 'node:crypto';

interface HybridSession {
  chatSessionId: string;
  parentMessageId: number;
  updatedAt: number;
  matchedLength?: number;
}

const lineageSessions = new Map<string, HybridSession>();
const explicitSessions = new Map<string, HybridSession>();
const MAX_LINEAGE_ENTRIES = 2_000;
const MAX_EXPLICIT_ENTRIES = 2_000;
const MAX_SESSION_KEY_LENGTH = 256;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Per-key mutex: only one in-flight continuation per explicit session key.
 * Without it, a client retry while the first request is still streaming can
 * append twice from the same parent and corrupt the server-side thread.
 */
const sessionLocks = new Map<string, Promise<unknown>>();

/**
 * Wait for exclusive ownership of a session key and return an idempotent
 * release callback. Unlike acquireSessionLock, callers can transfer ownership
 * to a response stream and release only after the stream is fully consumed.
 */
export async function acquireSessionLease(key: string): Promise<() => void> {
  const previous = sessionLocks.get(key) || Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>(resolve => { resolveCurrent = resolve; });
  const queued = previous.catch(() => {}).then(() => current);
  sessionLocks.set(key, queued);

  await previous.catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    resolveCurrent();
    void queued.finally(() => {
      if (sessionLocks.get(key) === queued) sessionLocks.delete(key);
    });
  };
}

export function acquireSessionLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  return (async () => {
    const release = await acquireSessionLease(key);
    try {
      return await task();
    } finally {
      release();
    }
  })();
}

function canonicalMessage(message: any): Record<string, unknown> {
  return {
    role: message?.role ?? '',
    content: message?.content ?? null,
    reasoning_content: message?.reasoning_content ?? null,
    tool_calls: message?.tool_calls ?? null,
    name: message?.name ?? null,
    tool_call_id: message?.tool_call_id ?? null,
  };
}

export function fingerprintMessages(messages: any[]): string {
  const canonical = messages.map(canonicalMessage);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function pruneLineages(): void {
  if (lineageSessions.size <= MAX_LINEAGE_ENTRIES) return;
  const oldest = [...lineageSessions.entries()]
    .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
    .slice(0, lineageSessions.size - MAX_LINEAGE_ENTRIES);
  for (const [fingerprint] of oldest) lineageSessions.delete(fingerprint);
}

function validSessionKey(sessionKey?: string): sessionKey is string {
  return !!sessionKey && sessionKey.length <= MAX_SESSION_KEY_LENGTH;
}

function pruneExplicitSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, session] of explicitSessions) {
    if (session.updatedAt < cutoff) explicitSessions.delete(key);
  }
  if (explicitSessions.size < MAX_EXPLICIT_ENTRIES) return;
  const oldest = [...explicitSessions.entries()]
    .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
    .slice(0, explicitSessions.size - MAX_EXPLICIT_ENTRIES + 1);
  for (const [key] of oldest) explicitSessions.delete(key);
}

export function findLineageSession(messages: any[]): HybridSession | undefined {
  if (!messages.some(message => message?.role === 'assistant' || message?.role === 'tool' || message?.role === 'function')) {
    return undefined;
  }

  for (let end = messages.length - 1; end > 0; end--) {
    const session = lineageSessions.get(fingerprintMessages(messages.slice(0, end)));
    if (session) {
      if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
        continue;
      }
      session.updatedAt = Date.now();
      return { ...session, matchedLength: end };
    }
  }
  return undefined;
}

export function findExplicitSession(sessionKey?: string): HybridSession | undefined {
  if (!validSessionKey(sessionKey)) return undefined;
  const session = explicitSessions.get(sessionKey);
  if (!session) return undefined;
  if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
    explicitSessions.delete(sessionKey);
    return undefined;
  }
  session.updatedAt = Date.now();
  return session;
}

export function registerLineageSession(messages: any[], chatSessionId: string, parentMessageId: number): void {
  if (!chatSessionId || messages.length === 0) return;
  lineageSessions.set(fingerprintMessages(messages), {
    chatSessionId,
    parentMessageId,
    updatedAt: Date.now(),
  });
  pruneLineages();
}

export function registerExplicitSession(sessionKey: string | undefined, chatSessionId: string, parentMessageId: number): void {
  if (!validSessionKey(sessionKey) || !chatSessionId) return;
  pruneExplicitSessions();
  explicitSessions.set(sessionKey, { chatSessionId, parentMessageId, updatedAt: Date.now() });
}

export function incrementalMessages(messages: any[]): any[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'assistant') {
      const tail = messages.slice(index + 1);
      if (tail.length > 0) return tail;
      break;
    }
  }
  return messages;
}

export function resetHybridSessionsForTests(): void {
  lineageSessions.clear();
  explicitSessions.clear();
  sessionLocks.clear();
}
