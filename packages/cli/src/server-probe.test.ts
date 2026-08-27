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

import {
  probeServer, probeOk, probeAdvice, classifyUnreachable, describeCause, describeUnreachable,
  type ProbeResult,
} from './server-probe.js';

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

/**
 * THE CROSS-PLATFORM HOLE. The classifier walked `err.cause` and nothing else.
 *
 * When a host name resolves to both an A and an AAAA record — which `localhost`
 * does on a default macOS and Windows install — undici tries both addresses and
 * reports the pair as an `AggregateError`. Its own `code` is undefined and the
 * real codes sit in `.errors`, so a refused connection classified as 'unknown'
 * and printed the five characters "fetch failed" on those two platforms while
 * printing "connection refused" on Linux CI. Same product, same bug, only one
 * platform able to describe it.
 */
describe('classifyUnreachable across the shapes fetch actually throws', () => {
  /** How undici reports a dual-stack failure: TypeError → AggregateError → members. */
  function dualStack(code: string): Error {
    const members = [
      Object.assign(new Error(`connect ${code} ::1:443`), { code }),
      Object.assign(new Error(`connect ${code} 127.0.0.1:443`), { code }),
    ];
    const agg = new AggregateError(members, '');
    return Object.assign(new TypeError('fetch failed'), { cause: agg });
  }

  test('a refused connection inside an AggregateError is refused, not unknown', () => {
    expect(classifyUnreachable(dualStack('ECONNREFUSED'))).toBe('refused');
    expect(describeCause(dualStack('ECONNREFUSED'))).toMatch(/ECONNREFUSED/);
  });

  test('DNS and timeout survive the same wrapping', () => {
    expect(classifyUnreachable(dualStack('ENOTFOUND'))).toBe('dns');
    expect(classifyUnreachable(dualStack('ETIMEDOUT'))).toBe('timeout');
  });

  test('the single-cause shape still classifies — the old walk is not lost', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }),
    });
    expect(classifyUnreachable(err)).toBe('refused');
  });

  test('a port on the WHATWG bad-port list is named, not left as "fetch failed"', () => {
    // undici refuses ports 1, 7, 9, … 6697 before opening a socket and throws a
    // bare `Error: bad port` with no code, so every code-based branch missed it.
    const err = Object.assign(new TypeError('fetch failed'), { cause: new Error('bad port') });
    expect(classifyUnreachable(err)).toBe('bad_port');
    expect(probeAdvice({ kind: 'unreachable', error: 'fetch failed', reason: 'bad_port' }, BASE))
      .toMatch(/refuse to open/);
  });

  test('describeUnreachable leads with the reason, because that is the actionable half', () => {
    expect(describeUnreachable(dualStack('ECONNREFUSED'))).toMatch(/^the connection was refused/);
    expect(describeUnreachable(Object.assign(new TypeError('fetch failed'), {}))).not.toBe('fetch failed');
  });
});

/** The sync client reads `limits` off the probe rather than issuing a second,
 *  unclassified request — which is where its own JSON-parse bug lived. */
describe('the ok result carries the whole document', () => {
  test('raw holds the fields no other caller has to re-fetch', async () => {
    const r = await probeServer(BASE, {
      fetchImpl: fakeFetch({
        status: 200,
        body: JSON.stringify({ apiVersion: 3, authProvider: 'better-auth', limits: { ingestConcurrencyPerTenant: 2 } }),
      }),
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect((r.raw as { authProvider?: string }).authProvider).toBe('better-auth');
      expect((r.raw as { limits?: { ingestConcurrencyPerTenant?: number } }).limits?.ingestConcurrencyPerTenant).toBe(2);
    }
  });
});
