import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app, assertSafeListenConfig } from './index.ts';

function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('chat.deepseek.com')) return handler(url, init);
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

function upstream(messageId: number, content = 'ok'): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: ready\ndata: {"response_message_id":${messageId}}\n\n`));
      controller.enqueue(new TextEncoder().encode(`data: {"p":"response/content","v":${JSON.stringify(content)}}\n\n`));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    }
  }), { status: 200 });
}

async function request(body: Record<string, unknown>): Promise<Response> {
  return await app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

test('OpenAI user does not act as a conversation identifier', async () => {
  const payloads: any[] = [];
  const restore = setupFetchMock((_url, init) => {
    payloads.push(JSON.parse(init?.body as string || '{}'));
    return upstream(13000 + payloads.length);
  });
  try {
    process.env.TEST_SESSION_ID = 'user-semantics-session-a';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', user: 'same-end-user', messages: [{ role: 'user', content: 'one' }], stream: false })).status, 200);
    process.env.TEST_SESSION_ID = 'user-semantics-session-b';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', user: 'same-end-user', messages: [{ role: 'user', content: 'two' }], stream: false })).status, 200);
    assert.strictEqual(payloads[1].chat_session_id, 'user-semantics-session-b');
    assert.strictEqual(payloads[1].parent_message_id, null);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('opaque session_id explicitly continues a conversation', async () => {
  const payloads: any[] = [];
  const restore = setupFetchMock((_url, init) => {
    payloads.push(JSON.parse(init?.body as string || '{}'));
    return upstream(14000 + payloads.length);
  });
  try {
    process.env.TEST_SESSION_ID = 'opaque-session-a';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', session_id: 'opaque-conversation-key', messages: [{ role: 'user', content: 'one' }], stream: false })).status, 200);
    process.env.TEST_SESSION_ID = 'opaque-session-b';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', session_id: 'opaque-conversation-key', messages: [{ role: 'user', content: 'two' }], stream: false })).status, 200);
    assert.strictEqual(payloads[1].chat_session_id, 'opaque-session-a');
    assert.strictEqual(payloads[1].parent_message_id, 14001);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('explicit incremental turns do not publish incomplete lineage aliases', async () => {
  const payloads: any[] = [];
  const restore = setupFetchMock((_url, init) => {
    payloads.push(JSON.parse(init?.body as string || '{}'));
    return upstream(15000 + payloads.length, payloads.length === 2 ? 'short answer' : 'ok');
  });
  try {
    process.env.TEST_SESSION_ID = 'hidden-history-session-a';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', session_id: 'hidden-history-key', messages: [{ role: 'user', content: 'original hidden turn' }], stream: false })).status, 200);
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', session_id: 'hidden-history-key', messages: [{ role: 'user', content: 'short current turn' }], stream: false })).status, 200);

    process.env.TEST_SESSION_ID = 'hidden-history-session-b';
    assert.strictEqual((await request({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: 'short current turn' },
        { role: 'assistant', content: 'short answer' },
        { role: 'user', content: 'must not attach to hidden history' },
      ],
      stream: false,
    })).status, 200);
    assert.strictEqual(payloads[2].chat_session_id, 'hidden-history-session-b');
    assert.strictEqual(payloads[2].parent_message_id, null);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('upstream streams have a deadline and release with 504', async () => {
  const restore = setupFetchMock(() => {
    let timer: ReturnType<typeof setTimeout>;
    return new Response(new ReadableStream({
      start(controller) {
        timer = setTimeout(() => controller.close(), 100);
      },
      cancel() {
        clearTimeout(timer);
      }
    }), { status: 200 });
  });
  process.env.DEEPSPROXY_UPSTREAM_TIMEOUT_MS = '20';
  try {
    const started = Date.now();
    const response = await request({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'timeout' }], stream: false });
    assert.strictEqual(response.status, 504);
    assert.ok(Date.now() - started < 250);
  } finally {
    delete process.env.DEEPSPROXY_UPSTREAM_TIMEOUT_MS;
    restore();
  }
});

test('streaming timeout emits an OpenAI-compatible SSE error and releases cleanly', async () => {
  const restore = setupFetchMock(() => {
    let timer: ReturnType<typeof setTimeout>;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"response_message_id":17001}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"partial"}\n\n'));
        timer = setTimeout(() => controller.close(), 100);
      },
      cancel() {
        clearTimeout(timer);
      }
    }), { status: 200 });
  });
  process.env.DEEPSPROXY_UPSTREAM_TIMEOUT_MS = '20';
  try {
    const response = await request({ model: 'deepseek-v4-pro', session_id: 'stream-timeout-key', messages: [{ role: 'user', content: 'timeout stream' }], stream: true });
    assert.strictEqual(response.status, 200);
    const text = await response.text();
    assert.match(text, /upstream_timeout/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    delete process.env.DEEPSPROXY_UPSTREAM_TIMEOUT_MS;
    restore();
  }
});

test('non-loopback binding requires API_KEY', () => {
  assert.throws(() => assertSafeListenConfig('0.0.0.0', undefined), /API_KEY/);
  assert.doesNotThrow(() => assertSafeListenConfig('127.0.0.1', undefined));
  assert.doesNotThrow(() => assertSafeListenConfig('0.0.0.0', 'secret'));
});
