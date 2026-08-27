/**
 * The three things that turned one macOS install failure into a long round trip:
 * the cause was unnamed, the Node floor was unenforced, and nothing reported it.
 *
 * `npx chat-recall init --server https://chatrecall.dev` printed "No OIDC issuer
 * configured for SSO login" on a machine with no SSO. The probe had failed, the
 * failure was swallowed, and the fallback branch's error was the one the user
 * saw. What made it expensive was not the bug — it was that "fetch failed" names
 * no cause, so nobody could tell a DNS problem from a proxy from a stale binary.
 *
 * These tests pin the diagnosis, not the plumbing.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyUnreachable, describeCause, probeServer, probeAdvice } from './server-probe.js';
import { reportInstallFailure } from './install-report.js';

/** A fetch that fails the way undici does: the message is useless, the truth is
 *  in `cause.code`. Reproducing that shape is the whole point. */
function failingFetch(code: string | undefined, name?: string): typeof fetch {
  return (async () => {
    const err = new Error('fetch failed') as Error & { cause?: unknown };
    if (name) err.name = name;
    if (code) err.cause = Object.assign(new Error('underlying'), { code });
    throw err;
  }) as unknown as typeof fetch;
}

describe('classifyUnreachable — naming what "fetch failed" hides', () => {
  const cases: Array<[string, string]> = [
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['ECONNREFUSED', 'refused'],
    ['ECONNRESET', 'reset'],
    ['EPIPE', 'reset'],
    ['ETIMEDOUT', 'timeout'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'],
  ];
  for (const [code, expected] of cases) {
    test(`${code} → ${expected}`, () => {
      const err = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });
      expect(classifyUnreachable(err)).toBe(expected);
    });
  }

  test('an abort/timeout signal is a timeout even with no code', () => {
    const err = new Error('The operation was aborted'); err.name = 'TimeoutError';
    expect(classifyUnreachable(err)).toBe('timeout');
  });

  test('an unrecognised failure is "unknown" — never guessed into a category', () => {
    expect(classifyUnreachable(new Error('something else'))).toBe('unknown');
  });

  test('the code is dug out of a NESTED cause, not just the top level', () => {
    const deep = Object.assign(new Error('inner'), { code: 'ENOTFOUND' });
    const mid = Object.assign(new Error('middle'), { cause: deep });
    expect(classifyUnreachable(Object.assign(new Error('fetch failed'), { cause: mid }))).toBe('dns');
  });

  test('describeCause keeps the code, because "fetch failed" alone is worthless', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    expect(describeCause(err)).toContain('ECONNREFUSED');
  });
});

describe('probeAdvice — one actionable sentence per cause', () => {
  test('DNS advice names the URL and DNS, not SSO', async () => {
    const r = await probeServer('https://nope.example', { fetchImpl: failingFetch('ENOTFOUND') });
    const advice = probeAdvice(r, 'https://nope.example');
    expect(advice).toMatch(/resolve/i);
    expect(advice).not.toMatch(/OIDC|issuer|SSO/i);
  });

  test('TLS advice mentions the certificate and the proxy case', async () => {
    const r = await probeServer('https://x.example', { fetchImpl: failingFetch('CERT_HAS_EXPIRED') });
    expect(probeAdvice(r, 'https://x.example')).toMatch(/certificate/i);
    expect(probeAdvice(r, 'https://x.example')).toMatch(/proxy/i);
  });

  test('a silent drop is described as one, since it is indistinguishable locally', async () => {
    const r = await probeServer('https://x.example', { fetchImpl: failingFetch(undefined, 'TimeoutError') });
    expect(probeAdvice(r, 'https://x.example')).toMatch(/did not answer in time/i);
  });

  test('NO advice for any failure mentions OIDC — the red herring is gone', async () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'ETIMEDOUT', undefined]) {
      const r = await probeServer('https://x.example', { fetchImpl: failingFetch(code) });
      expect(probeAdvice(r, 'https://x.example')).not.toMatch(/OIDC|issuer/i);
    }
  });
});

describe('reportInstallFailure', () => {
  let dir = '';
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.CHAT_RECALL_DATA_DIR;
    dir = mkdtempSync(join(tmpdir(), 'cr-report-'));
    process.env.CHAT_RECALL_DATA_DIR = dir;
    delete process.env.CHAT_RECALL_TELEMETRY;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
    else process.env.CHAT_RECALL_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test('posts the step, the reason and the environment — and nothing else', async () => {
    let seen: Record<string, unknown> | null = null;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen = JSON.parse(String(init.body));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const ok = await reportInstallFailure('https://srv.example', {
      step: 'cli_login_probe', reason: 'dns', message: 'fetch failed: ENOTFOUND',
    }, { fetchImpl });

    expect(ok).toBe(true);
    expect(Object.keys(seen!).sort()).toEqual(['cliVersion', 'message', 'node', 'os', 'reason', 'step']);
    expect(seen!.step).toBe('cli_login_probe');
    expect(seen!.reason).toBe('dns');
  });

  test('THE SERVER URL IS NOT IN THE PAYLOAD — a self-hoster\'s hostname is theirs', () => {
    // Asserted on the body shape above; restated here as the rule it protects.
    expect(['cliVersion', 'message', 'node', 'os', 'reason', 'step']).not.toContain('serverUrl');
  });

  test('a network failure is swallowed — a diagnostic must not break an install', async () => {
    const fetchImpl = (async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;
    await expect(reportInstallFailure('https://srv.example', { step: 'cli_first_sync' }, { fetchImpl }))
      .resolves.toBe(false);
  });

  test('opting out silences it completely — no request is made', async () => {
    process.env.CHAT_RECALL_TELEMETRY = '0';
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    await reportInstallFailure('https://srv.example', { step: 'cli_login_probe' }, { fetchImpl });
    expect(called).toBe(false);
  });

  test('no server URL means no report, rather than a request to nowhere', async () => {
    await expect(reportInstallFailure('', { step: 'cli_login_probe' })).resolves.toBe(false);
  });
});
