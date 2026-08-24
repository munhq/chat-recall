/**
 * Server probe classification.
 *
 * The bug: `fetch(url).then(r => r.json())` with no `r.ok` check, inside one
 * try/catch. A renamed host served an HTML 404 page, `.json()` threw on `<!DO`,
 * and a stale token, a moved server and a dead server all surfaced as
 * "unreachable: Unexpected non-whitespace character after JSON at position 4".
 *
 * Each test below is one of the responses that used to collapse into that.
 */

import { describe, expect, test } from 'vitest';

import { probeServer, probeOk, probeAdvice, type ProbeResult } from './server-probe.js';

const BASE = 'https://recall.example.com';

/** A fetch that returns exactly one canned response. */
function fakeFetch(init: { status: number; body: string; ok?: boolean }): typeof fetch {
  return (async () => ({
    status: init.status,
    ok: init.ok ?? (init.status >= 200 && init.status < 300),
    text: async () => init.body,
  })) as unknown as typeof fetch;
}

function throwingFetch(message: string): typeof fetch {
  return (async () => { throw new Error(message); }) as unknown as typeof fetch;
}

describe('probeServer', () => {
  test('a real server is ok, and carries its version through', async () => {
    const r = await probeServer(BASE, {
      fetchImpl: fakeFetch({ status: 200, body: JSON.stringify({ apiVersion: 2, edition: 'cloud', cli: { version: '0.5.6' } }) }),
    });
    expect(r.kind).toBe('ok');
    expect(probeOk(r)).toBe(true);
    if (r.kind === 'ok') expect(r.cliVersion).toBe('0.5.6');
  });

  test('THE BUG: an HTML 404 is "moved", not a JSON parse error', async () => {
    // This is the renamed-host response, byte for byte the shape that broke it.
    const r = await probeServer(BASE, {
      fetchImpl: fakeFetch({ status: 404, body: '<!DOCTYPE html><html><body>404 page not found</body></html>' }),
    });
    expect(r.kind).toBe('moved');
    expect(probeOk(r)).toBe(false);
    // And the advice names the fix rather than the symptom.
    const advice = probeAdvice(r, BASE);
    expect(advice).toContain('nothing is served');
    expect(advice).toContain('chat-recall login');
    expect(advice).not.toMatch(/JSON|position/i);
  });

  test('401 and 403 are the credential case — the only one where re-login is the fix', async () => {
    for (const status of [401, 403]) {
      const r = await probeServer(BASE, { fetchImpl: fakeFetch({ status, body: 'nope' }) });
      expect(r.kind).toBe('unauthorized');
      expect(probeAdvice(r, BASE)).toContain('rejected the credential');
    }
  });

  test('a 5xx is the server being broken, not the user being wrong', async () => {
    const r = await probeServer(BASE, { fetchImpl: fakeFetch({ status: 502, body: 'bad gateway' }) });
    expect(r.kind).toBe('server_error');
    expect(probeAdvice(r, BASE)).toContain('Nothing to fix locally');
  });

  test('a 200 that is not our API — parked domain, proxy, captive portal', async () => {
    const r = await probeServer(BASE, {
      fetchImpl: fakeFetch({ status: 200, body: '<html><title>Domain for sale</title></html>' }),
    });
    expect(r.kind).toBe('not_api');
    if (r.kind === 'not_api') expect(r.snippet).toContain('<html>');
    expect(probeAdvice(r, BASE)).toContain('not the chat-recall API');
  });

  test('a 200 of valid JSON that is not capabilities is also not our API', async () => {
    // A proxy that answers every path with {"ok":true} must not read as healthy.
    const r = await probeServer(BASE, { fetchImpl: fakeFetch({ status: 200, body: '{"ok":true}' }) });
    expect(r.kind).toBe('not_api');
  });

  test('no HTTP response at all is unreachable, with the cause kept', async () => {
    const r = await probeServer(BASE, { fetchImpl: throwingFetch('getaddrinfo ENOTFOUND recall.example.com') });
    expect(r.kind).toBe('unreachable');
    expect(probeAdvice(r, BASE)).toContain('ENOTFOUND');
    expect(probeAdvice(r, BASE)).toContain('DNS');
  });

  test('an API too old to sync with is reported as old, not as unreachable', async () => {
    const r = await probeServer(BASE, { fetchImpl: fakeFetch({ status: 200, body: '{"apiVersion":1}' }) });
    expect(r.kind).toBe('ok');
    expect(probeOk(r)).toBe(false);          // usable? no
    expect(probeAdvice(r, BASE)).toContain('too old');
  });

  test('every branch gives advice that names the server, and never a bare stack trace', async () => {
    const all: ProbeResult[] = [
      { kind: 'moved', status: 404 },
      { kind: 'unauthorized', status: 401 },
      { kind: 'server_error', status: 500 },
      { kind: 'not_api', status: 200, snippet: 'x' },
      { kind: 'unreachable', error: 'boom' },
    ];
    for (const r of all) expect(probeAdvice(r, BASE)).toContain(BASE);
  });
});
