/*
 * File: playwright.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let currentHeaders: Record<string, string> = {};

export async function initPlaywright(headless = true) {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const profilePath = path.resolve('deepseek_profile');

  context = await chromium.launchPersistentContext(profilePath, {
    headless,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--exclude-switches=enable-automation',
      '--disable-infobars',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  // Keep an active page to fetch PoW headers on demand
  const pages = context.pages();
  activePage = pages.length > 0 ? pages[0] : await context.newPage();
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    await context.close();
    context = null;
    activePage = null;
    powQueue = Promise.resolve();
  }
}

let powQueue: Promise<any> = Promise.resolve();

/**
 * Ensures the session is valid and extracts headers, PoW, and session ID.
 * Serialized through powQueue to avoid browser state corruption from concurrent calls.
 */
export function getDeepSeekHeaders(forceNew = false): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: number | null }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    // Generate a unique session ID if requested for testing isolation
    const mockSessionId = process.env.TEST_SESSION_ID || 'mock-session';
    return Promise.resolve({ headers: { authorization: 'Bearer MOCK' }, chatSessionId: mockSessionId, parentMessageId: null });
  }

  const next = powQueue.catch(() => {}).then(() => _getDeepSeekHeadersInternal(forceNew));
  powQueue = next;
  return next;
}

async function _getDeepSeekHeadersInternal(forceNew = false): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: number | null }> {
  if (!activePage) {
    throw new Error('Playwright not initialized');
  }

  // Navigate to deepseek chat home page if not already there, or if forceNew is true.
  // Modern DeepSeek URLs use UUIDs like /a/chat/s/<uuid>; staying on a specific chat
  // after an aborted turn breaks subsequent submissions.
  const currentUrl = activePage.url();
  const isOnHomePage = currentUrl === 'https://chat.deepseek.com/' || currentUrl === 'https://chat.deepseek.com';

  if (!isOnHomePage || forceNew) {
    await activePage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
  }

  // Wait for the chat input. Keep this timeout short: when DeepSeek shows an
  // account/login/suspension banner there is no input, and retrying the same
  // browser state just makes OpenAI clients look hung.
  const chatInputSelector = 'textarea, [role="textbox"], [contenteditable="true"]';
  const chatInputTimeoutMs = Number(process.env.DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS || '8000');
  await activePage.waitForSelector(chatInputSelector, { timeout: chatInputTimeoutMs }).catch(async () => {
    const pageState = await activePage!.evaluate(() => {
      const fullBodyText = document.body?.innerText || '';
      const bodyText = fullBodyText.slice(0, 5000);
      const suspensionMatch = fullBodyText.match(/Due to violation of user policies, your account has been suspended until\s+([^\.\n]+)\.\s*If you have any questions, please Contact us\./i);
      const suspendedUntil = suspensionMatch?.[1]?.trim() || null;
      const suspensionOriginal = suspensionMatch?.[0]?.trim() || null;
      return {
        url: location.href,
        title: document.title,
        bodyText,
        textareaCount: document.querySelectorAll('textarea').length,
        inputCount: document.querySelectorAll('input, textarea, [role="textbox"], [contenteditable]').length,
        suspended: /suspended until|violation of user policies|account has been suspended/i.test(fullBodyText),
        suspendedUntil,
        suspensionOriginal,
        loginRequired: /log in|login|sign in|entrar/i.test(fullBodyText),
      };
    }).catch((e: any) => ({ evaluateError: e?.message || String(e) }));

    const state: any = pageState;
    if (state?.suspended) {
      const until = typeof state.suspendedUntil === 'string' && state.suspendedUntil.trim() ? state.suspendedUntil.trim() : '';
      const original = typeof state.suspensionOriginal === 'string' && state.suspensionOriginal.trim() ? state.suspensionOriginal.trim() : '';
      const detail = original || (until ? `Due to violation of user policies, your account has been suspended until ${until}.` : 'DeepSeek reported an account suspension.');
      throw new Error(`DeepSeek account is suspended; chat input is unavailable. Original DeepSeek message: ${detail}`);
    }
    if (state?.loginRequired) {
      throw new Error('DeepSeek login is required; chat input is unavailable.');
    }
    throw new Error('DeepSeek chat input unavailable; page did not expose an input box.');
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      activePage?.unroute('**/api/v0/chat/completion', routeHandler).catch(() => {});
      reject(new Error('Timeout waiting for PoW headers'));
    }, 20000);

    const routeHandler = async (route: any, request: any) => {
      clearTimeout(timeout);
      try {
        const reqHeaders = request.headers();
        let uiSessionId = '';
        let uiParentMessageId: number | null = null;

        const postData = request.postData();
        if (postData) {
          try {
            const payload = JSON.parse(postData);
            if (payload.chat_session_id) {
              uiSessionId = payload.chat_session_id;
            }
            if (payload.parent_message_id !== undefined) {
              uiParentMessageId = payload.parent_message_id;
            }
          } catch (e) {
            // ignore parsing error
          }
        }

        const extractedHeaders = {
          'x-ds-pow-response': reqHeaders['x-ds-pow-response'] || '',
          'x-hif-dliq': reqHeaders['x-hif-dliq'] || '',
          'x-hif-leim': reqHeaders['x-hif-leim'] || '',
          'authorization': reqHeaders['authorization'] || '',
          'cookie': reqHeaders['cookie'] || ''
        };

        currentHeaders = extractedHeaders;

        // Abort to prevent polluting chat history
        await route.abort('aborted').catch(() => {});

        // Cleanup route
        await activePage!.unroute('**/api/v0/chat/completion', routeHandler).catch(() => {});

        resolve({ headers: extractedHeaders, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId });
      } catch (err) {
        reject(err);
      }
    };

    activePage!.route('**/api/v0/chat/completion', routeHandler).then(async () => {
      try {
        const input = await activePage!.waitForSelector(chatInputSelector, { timeout: 5000 });
        if (input) {
          await input.fill('a');
          await activePage!.keyboard.press('Enter');
        } else {
          throw new Error('Chat input not found');
        }
      } catch (err) {
        clearTimeout(timeout);
        await activePage?.unroute('**/api/v0/chat/completion', routeHandler).catch(() => {});
        reject(err);
      }
    }).catch((err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
