/**
 * Online activation. The property that matters most is negative: a paying
 * customer's deployment must never stop working because OUR licence service is
 * unreachable, and nothing here may throw on any path.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  activatedEntitlement, refreshEntitlement, refreshDue, serial, instanceId,
  _resetActivationForTests,
} from './licence-activation.js';

// A throwaway issuer, so tests never touch the real key material.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Mint a token exactly as the licence service would. */
function token(opts: { features?: string[]; seats?: number; expSecondsFromNow?: number } = {}): string {
  const payload = {
    holder: 'ACME', features: opts.features ?? ['team', 'findings'],
    iat: Math.floor(Date.now() / 1000),
    ...(opts.seats ? { seats: opts.seats } : {}),
    exp: Math.floor(Date.now() / 1000) + (opts.expSecondsFromNow ?? 14 * 24 * 3600),
  };
  const seg = b64url(JSON.stringify(payload));
  return `CR1.${seg}.${b64url(sign(null, Buffer.from(seg, 'utf8'), privateKey))}`;
}

let dir: string;
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}
const cacheFile = () => join(dir, 'licence-entitlement.json');
const seed = (t: string, fetchedAt = Date.now()) =>
  writeFileSync(cacheFile(), JSON.stringify({ token: t, fetchedAt }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-act-'));
  setEnv('CHAT_RECALL_DATA_DIR', dir);
  setEnv('CHAT_RECALL_LICENSE_PUBKEY', PUB);
  setEnv('CHAT_RECALL_LICENSE_SERIAL', 'CRS-TEST-0001');
  setEnv('CHAT_RECALL_LICENCE_SERVER', 'https://licence.invalid');
  _resetActivationForTests();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
  _resetActivationForTests();
});

describe('reading the cached entitlement', () => {
  test('no cache → no entitlement, no throw', () => {
    expect(activatedEntitlement()).toBeNull();
  });

  test('a valid cached token grants its features', () => {
    seed(token({ features: ['team', 'findings'] }));
    const p = activatedEntitlement();
    expect(p?.features).toEqual(['team', 'findings']);
  });

  test('an EXPIRED token degrades to no entitlement — free tier, not broken', () => {
    seed(token({ expSecondsFromNow: -60 }));
    expect(activatedEntitlement()).toBeNull();
  });

  test('a token signed by the WRONG issuer is rejected', () => {
    const other = generateKeyPairSync('ed25519');
    const payload = { holder: 'X', features: ['team'], iat: 1, exp: Math.floor(Date.now() / 1000) + 999 };
    const seg = b64url(JSON.stringify(payload));
    seed(`CR1.${seg}.${b64url(sign(null, Buffer.from(seg, 'utf8'), other.privateKey))}`);
    expect(activatedEntitlement()).toBeNull();
  });

  test('a corrupt cache file is treated as not activated, not as an error', () => {
    writeFileSync(cacheFile(), 'not json at all');
    expect(() => activatedEntitlement()).not.toThrow();
    expect(activatedEntitlement()).toBeNull();
  });
});

describe('refresh — never throws, never clears a good token', () => {
  test('no serial → reports it and does nothing', async () => {
    setEnv('CHAT_RECALL_LICENSE_SERIAL', undefined);
    expect(await refreshEntitlement()).toEqual({ ok: false, reason: 'no-serial' });
  });

  test('UNREACHABLE service leaves a valid cached token in force', async () => {
    // The failure that must never cost a customer their features.
    const good = token();
    seed(good);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await refreshEntitlement({ timeoutMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unreachable');
    _resetActivationForTests();
    expect(activatedEntitlement()?.features).toBeTruthy();      // still entitled
    expect(JSON.parse(readFileSync(cacheFile(), 'utf8')).token).toBe(good);
  });

  test('a 4xx does NOT clear a valid cached token', async () => {
    // Even a revoked serial must not strip features mid-window: the window is what
    // protects the customer against our mistakes as well as our downtime.
    const good = token();
    seed(good);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const r = await refreshEntitlement();
    expect(r.reason).toBe('http-403');
    _resetActivationForTests();
    expect(activatedEntitlement()).not.toBeNull();
  });

  test('a token that fails verification is NOT cached over the good one', async () => {
    const good = token();
    seed(good);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ token: 'CR1.garbage.garbage' }),
    }));
    const r = await refreshEntitlement();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^rejected-/);
    expect(JSON.parse(readFileSync(cacheFile(), 'utf8')).token).toBe(good);
  });

  test('a fresh valid token replaces the cache', async () => {
    seed(token({ features: ['team'] }));
    const next = token({ features: ['team', 'findings', 'alerts'] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ token: next }),
    }));
    expect(await refreshEntitlement()).toEqual({ ok: true });
    expect(activatedEntitlement()?.features).toEqual(['team', 'findings', 'alerts']);
  });

  test('the request carries the serial and a stable instance id', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ token: token() }) });
    vi.stubGlobal('fetch', spy);
    await refreshEntitlement();
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body.serial).toBe('CRS-TEST-0001');
    expect(body.instanceId).toMatch(/^[0-9a-f]{16}$/);
    expect(body.instanceId).toBe(instanceId());     // stable across calls
    expect(spy.mock.calls[0][0]).toBe('https://licence.invalid/api/licence/activate');
  });
});

describe('refreshDue — refresh EARLY so one failed call is survivable', () => {
  test('due when there is no cache at all', () => {
    expect(refreshDue()).toBe(true);
  });

  test('not due immediately after a successful fetch', () => {
    seed(token({ expSecondsFromNow: 14 * 24 * 3600 }), Date.now());
    expect(refreshDue()).toBe(false);
  });

  test('due once past the halfway point of the token life', () => {
    const life = 14 * 24 * 3600;
    seed(token({ expSecondsFromNow: life }), Date.now());
    // Look ahead past halfway rather than manipulating the clock.
    expect(refreshDue(Date.now() + (life / 2 + 60) * 1000)).toBe(true);
  });

  test('never due without a serial', () => {
    setEnv('CHAT_RECALL_LICENSE_SERIAL', undefined);
    expect(refreshDue()).toBe(false);
  });
});

describe('serial + instanceId', () => {
  test('serial is trimmed and empty means none', () => {
    setEnv('CHAT_RECALL_LICENSE_SERIAL', '  CRS-X  ');
    expect(serial()).toBe('CRS-X');
    setEnv('CHAT_RECALL_LICENSE_SERIAL', '   ');
    expect(serial()).toBeNull();
  });

  test('instanceId is a hash, so a hostname is never sent in the clear', () => {
    setEnv('CHAT_RECALL_INSTANCE_ID', 'my-secret-host.internal');
    const id = instanceId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toContain('my-secret-host');
  });
});
