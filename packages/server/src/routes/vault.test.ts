/**
 * /api/vault/salt — publish once, read from every device.
 *
 * This endpoint exists to delete a setup step that nobody completed: copying a
 * 64-hex salt off device one by hand. What it must never do is let a second
 * device silently REPLACE the salt, which would orphan every blob already
 * encrypted under the first one.
 *
 * No secret is served here: the salt is a KDF salt, and keyId is a fingerprint
 * of the derived key, not the key.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prevDataDir: string | undefined;

beforeAll(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-vault-salt-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});
afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const SALT_A = 'a'.repeat(64);
const SALT_B = 'b'.repeat(64);

async function app() {
  const router = (await import('./vault.js')).default;
  const a = express();
  // Stand in for tenantAuth — every request here is already authenticated.
  a.use((req, _res, next) => { req.tenant = 'acme'; next(); });
  a.use('/api/vault', router);
  return a;
}

describe('/api/vault/salt', () => {
  test('unset workspace reads as null, not 404 — "no vault yet" is a normal state', async () => {
    const res = await request(await app()).get('/api/vault/salt');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saltHex: null, keyId: null });
  });

  test('publish → every later device reads the same salt back', async () => {
    const a = await app();
    const post = await request(a).post('/api/vault/salt').send({ saltHex: SALT_A, keyId: 'kid-1' });
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ ok: true, created: true, saltHex: SALT_A });

    const get = await request(a).get('/api/vault/salt');
    expect(get.body).toEqual({ saltHex: SALT_A, keyId: 'kid-1' });
  });

  test('republishing the SAME salt is idempotent, not a conflict', async () => {
    const res = await request(await app()).post('/api/vault/salt').send({ saltHex: SALT_A, keyId: 'kid-1' });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
  });

  test('a DIFFERENT salt is refused — overwriting orphans existing blobs', async () => {
    const res = await request(await app()).post('/api/vault/salt').send({ saltHex: SALT_B });
    expect(res.status).toBe(409);
    // The response carries the authoritative values so the client can adopt them.
    expect(res.body.saltHex).toBe(SALT_A);
    expect(res.body.keyId).toBe('kid-1');

    // And the stored salt is untouched.
    expect((await request(await app()).get('/api/vault/salt')).body.saltHex).toBe(SALT_A);
  });

  test('malformed salts are rejected before anything is stored', async () => {
    const a = await app();
    for (const bad of ['', 'xyz', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 42, null]) {
      const res = await request(a).post('/api/vault/salt').send({ saltHex: bad as never });
      expect(res.status).toBe(400);
    }
  });

  test('no tenant → 401, never a cross-workspace read', async () => {
    const router = (await import('./vault.js')).default;
    const a = express();
    a.use('/api/vault', router);      // no tenant attached
    expect((await request(a).get('/api/vault/salt')).status).toBe(401);
    expect((await request(a).post('/api/vault/salt').send({ saltHex: SALT_A })).status).toBe(401);
  });
});
