/**
 * vaultEnableWithRemote — device two needs the passphrase and nothing else.
 *
 * Two behaviours matter more than the happy path:
 *
 *  1. A WRONG PASSPHRASE MUST FAIL LOUDLY. Previously device two derived a
 *     different key, saved it, and started producing blobs that no other device
 *     could ever open — with no error at any point. The published keyId (a
 *     fingerprint of the derived key, never the key) turns that into an
 *     immediate refusal.
 *  2. Being offline must not brick setup. The vault still enables locally and
 *     publishes on a later run.
 *
 * Uses ARGON2 as configured by vaultEnable (PROD params), so these are slow by
 * design — a fast KDF would be the bug.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.CHAT_RECALL_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'cr-vault-remote-'));
  process.env.CHAT_RECALL_DATA_DIR = dir;
  vi.resetModules();
});
afterEach(() => {
  if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const REMOTE = { baseUrl: 'https://example.test', token: 'ct_x' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('vaultEnableWithRemote', () => {
  test('device one generates a salt and publishes it', async () => {
    const { vaultEnableWithRemote } = await import('./vault-client.js');
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string });
      if (!init?.method || init.method === 'GET') return json({ saltHex: null, keyId: null });
      return json({ ok: true, created: true });
    }) as unknown as typeof fetch;

    const r = await vaultEnableWithRemote('correct-horse-battery', REMOTE, { fetchImpl });
    expect(r.saltSource).toBe('local');
    expect(r.saltHex).toMatch(/^[0-9a-f]{64}$/);
    // It published exactly what it derived — salt AND the key fingerprint.
    const posted = JSON.parse(calls.find((c) => c.method === 'POST')!.body!);
    expect(posted.saltHex).toBe(r.saltHex);
    expect(posted.keyId).toBe(r.keyId);
  }, 30_000);

  test('device two adopts the published salt — no --existing-salt, same key', async () => {
    const { vaultEnableWithRemote, vaultEnable } = await import('./vault-client.js');
    // What device one would have produced.
    const one = vaultEnable('correct-horse-battery', { existingSaltHex: 'ab'.repeat(32) });

    const fetchImpl = (async () => json({ saltHex: one.saltHex, keyId: one.keyId })) as unknown as typeof fetch;
    const two = await vaultEnableWithRemote('correct-horse-battery', REMOTE, { fetchImpl });

    expect(two.saltSource).toBe('server');
    expect(two.saltHex).toBe(one.saltHex);
    expect(two.keyId).toBe(one.keyId);       // same passphrase + salt ⇒ same key
    expect(two.keyIdMatches).toBe(true);
  }, 30_000);

  test('a WRONG passphrase is refused instead of silently making unreadable blobs', async () => {
    const { vaultEnableWithRemote, vaultEnable, VaultPassphraseMismatchError } = await import('./vault-client.js');
    const one = vaultEnable('correct-horse-battery', { existingSaltHex: 'cd'.repeat(32) });

    const fetchImpl = (async () => json({ saltHex: one.saltHex, keyId: one.keyId })) as unknown as typeof fetch;
    await expect(vaultEnableWithRemote('a-different-passphrase', REMOTE, { fetchImpl }))
      .rejects.toThrow(VaultPassphraseMismatchError);
  }, 60_000);

  test('offline still enables locally — setup is never bricked by a down server', async () => {
    const { vaultEnableWithRemote } = await import('./vault-client.js');
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const r = await vaultEnableWithRemote('correct-horse-battery', REMOTE, { fetchImpl });
    expect(r.saltSource).toBe('local');
    expect(r.saltHex).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  test('lost the publish race → adopts the winner rather than keeping an orphan salt', async () => {
    const { vaultEnableWithRemote, vaultEnable } = await import('./vault-client.js');
    const winner = vaultEnable('correct-horse-battery', { existingSaltHex: 'ef'.repeat(32) });

    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return json({ saltHex: null, keyId: null });   // race window
      return json({ error: 'conflict', saltHex: winner.saltHex, keyId: winner.keyId }, 409);
    }) as unknown as typeof fetch;

    const r = await vaultEnableWithRemote('correct-horse-battery', REMOTE, { fetchImpl });
    expect(r.saltSource).toBe('server');
    expect(r.saltHex).toBe(winner.saltHex);
    expect(r.keyId).toBe(winner.keyId);
  }, 60_000);
});
