/**
 * What the device flow does with a response that is not a device-code response.
 *
 * `await startRes.json()` was the whole of it, and two different hosts got
 * through that line:
 *
 *   1. a 200 carrying HTML — a login wall, a parked domain, a captive portal —
 *      threw `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, which
 *      names neither the host nor the fix;
 *
 *   2. a 200 carrying somebody ELSE'S JSON parsed cleanly, every field read
 *      `undefined`, and the CLI printed
 *
 *          To log in, open:
 *            undefined
 *            (if prompted, enter code: undefined at undefined)
 *          Waiting for approval…
 *
 *      then polled that stranger's host until its (undefined → NaN) deadline
 *      expired and reported "the code expired before approval". A person sat
 *      waiting for an approval link that never existed.
 *
 * Case 2 is the one a schema check catches and a try/catch does not, which is
 * why the fields are asserted rather than just the parse.
 */
import { describe, expect, test, vi, afterEach } from 'vitest';

import { betterAuthDeviceLogin } from './device-auth.js';

const HOST = 'https://recall.example.com';

/** One canned response for POST /api/auth/device/code. */
function serverAnswers(status: number, body: string, contentType = 'application/json'): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': contentType }),
    text: async () => body,
    json: async () => JSON.parse(body),
  })) as unknown as typeof fetch);
}

/** Fails the test if it is ever called: no prompt may reach a human. */
const neverPrompt = () => { throw new Error('a prompt was shown for a non-device-code response'); };

afterEach(() => vi.unstubAllGlobals());

describe('betterAuthDeviceLogin against a host that is not chat-recall', () => {
  test('HTML on a 200 names the host, not a JSON token offset', async () => {
    serverAnswers(200, '<!DOCTYPE html><html><body>Sign in</body></html>', 'text/html');
    await expect(betterAuthDeviceLogin(HOST, neverPrompt)).rejects.toThrow(/not serving the chat-recall API/);
    serverAnswers(200, '<!DOCTYPE html><html><body>Sign in</body></html>', 'text/html');
    await expect(betterAuthDeviceLogin(HOST, neverPrompt)).rejects.not.toThrow(/Unexpected token/);
  });

  test("THE `undefined` PROMPT: valid JSON without the device fields is refused, not shown", async () => {
    serverAnswers(200, JSON.stringify({ service: 'something-else', version: 9 }));
    // neverPrompt throws if reached, so this also asserts nothing was printed.
    await expect(betterAuthDeviceLogin(HOST, neverPrompt)).rejects.toThrow(/not a device-code response/);
  });

  test('a device-code response missing ONE mandatory field is still refused', async () => {
    // RFC 8628 §3.2 makes device_code, user_code, verification_uri and
    // expires_in mandatory. A partial answer produced a partial prompt.
    serverAnswers(200, JSON.stringify({ device_code: 'd', user_code: 'ABCD-EFGH', expires_in: 600 }));
    await expect(betterAuthDeviceLogin(HOST, neverPrompt)).rejects.toThrow(/not a device-code response/);
  });

  test('a complete response is accepted and prompts exactly once', async () => {
    // expires_in: 0 puts the deadline in the past, so the poll loop never runs
    // and this rejects at once with the expiry error. The prompt fires BEFORE
    // the loop, which is the half under test.
    serverAnswers(200, JSON.stringify({
      device_code: 'dev-code', user_code: 'ABCD-EFGH',
      verification_uri: `${HOST}/device`, verification_uri_complete: `${HOST}/device?code=ABCD-EFGH`,
      expires_in: 0,
    }));
    const prompts: Array<{ url: string; userCode: string }> = [];
    await expect(betterAuthDeviceLogin(HOST, (p) => { prompts.push(p); })).rejects.toThrow(/expired/i);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].url).toBe(`${HOST}/device?code=ABCD-EFGH`);
    expect(prompts[0].userCode).toBe('ABCD-EFGH');
  });

  test('a non-2xx keeps naming its status — that path already worked', async () => {
    serverAnswers(404, '404 page not found', 'text/plain');
    await expect(betterAuthDeviceLogin(HOST, neverPrompt)).rejects.toThrow(/HTTP 404/);
  });
});
