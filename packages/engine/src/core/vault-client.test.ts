/**
 * End-to-end Vault client test.
 *
 * Stands up a fake team-server in-process (Express on a random port +
 * an in-memory map for blob bytes) so the client's encrypt → presign →
 * PUT → commit → list → presign → GET → decrypt path is exercised
 * fully against the actual fetch() code.
 *
 * The fake server does NOT use the real auth or DB — it's the smallest
 * thing that satisfies the client's contract. Real-server tests live
 * in team-server/test/endpoints.test.ts (gated on DATABASE_URL_TEST).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

import {
  vaultEnable, vaultSync, vaultRestore, vaultStatus,
  VaultConfigError,
} from './vault-client.js';
import { ARGON2_TEST } from './vault-crypto.js';
import { _resetSourceSettingsCache } from './tool-paths.js';
import { loadSettings, saveSettings } from './settings.js';

let tmp: string;
let serverPort: number;
let server: Server;
let serverState: {
  blobs: Array<{
    id: string; sessionId: string; tool: string; bucket: string; objectKey: string;
    sha256Cipher: string; keyId: string; bytes: number; mtimeSourceMs: number; uploadedAt: number;
    body: Buffer;
  }>;
  pendingUploads: Map<string, { bucket: string; objectKey: string; expectedBytes: number; expectedSha: string }>;
  pendingDownloads: Map<string, string>;  // token → blob id
};

const ORIG_ENV: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in ORIG_ENV)) ORIG_ENV[k] = process.env[k];
  if (v == null) delete process.env[k];
  else            process.env[k] = v;
}

beforeAll(async () => {
  // Fake server.
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.raw({ type: 'application/octet-stream', limit: '2mb' }));

  serverState = { blobs: [], pendingUploads: new Map(), pendingDownloads: new Map() };

  app.post('/api/team/:teamId/blobs/presign-upload', (req, res) => {
    const token = createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 24);
    const objectKey = `team/${req.params.teamId}/${req.body.tool}/${req.body.sessionId}/${req.body.sha256Cipher.slice(0, 16)}.enc`;
    serverState.pendingUploads.set(token, {
      bucket: 'vault', objectKey, expectedBytes: req.body.bytes, expectedSha: req.body.sha256Cipher,
    });
    res.json({
      url: `http://127.0.0.1:${serverPort}/storage/upload/${token}`,
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      bucket: 'vault', objectKey, expiresAt: Date.now() + 60_000,
    });
  });

  app.put('/storage/upload/:token', (req, res) => {
    const entry = serverState.pendingUploads.get(req.params.token);
    if (!entry) { res.status(401).json({ error: 'token_unknown' }); return; }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    if (body.length !== entry.expectedBytes) {
      res.status(400).json({ error: 'size_mismatch' }); return;
    }
    serverState.pendingUploads.delete(req.params.token);
    // Stash for later commit.
    serverState.blobs.push({
      id: '', sessionId: '', tool: '', bucket: entry.bucket, objectKey: entry.objectKey,
      sha256Cipher: entry.expectedSha, keyId: '', bytes: body.length, mtimeSourceMs: 0,
      uploadedAt: 0, body,
    });
    res.json({ ok: true });
  });

  app.post('/api/team/:teamId/blobs/commit', (req, res) => {
    const idx = serverState.blobs.findIndex(b =>
      b.bucket === req.body.bucket && b.objectKey === req.body.objectKey && !b.id);
    if (idx === -1) { res.status(409).json({ error: 'object_not_found' }); return; }
    const id = createHash('sha256').update(req.body.objectKey + Date.now()).digest('hex').slice(0, 16);
    serverState.blobs[idx] = {
      ...serverState.blobs[idx],
      id, sessionId: req.body.sessionId, tool: req.body.tool, keyId: req.body.keyId,
      mtimeSourceMs: req.body.mtimeSourceMs, uploadedAt: Date.now(),
    };
    res.status(201).json({ blob: { id, uploadedAt: Date.now() } });
  });

  app.get('/api/team/:teamId/blobs', (req, res) => {
    const since = Number(req.query.since ?? 0);
    const blobs = serverState.blobs
      .filter(b => b.id && b.uploadedAt > since)
      .map(b => ({
        id: b.id, sessionId: b.sessionId, tool: b.tool, projectPath: null,
        bucket: b.bucket, objectKey: b.objectKey, sha256Cipher: b.sha256Cipher,
        keyId: b.keyId, bytes: b.bytes, mtimeSourceMs: b.mtimeSourceMs,
        uploadedAt: b.uploadedAt, ownerUserId: 'fake-user',
      }));
    res.json({ blobs, serverNow: Date.now() });
  });

  app.get('/api/team/:teamId/blobs/:id/presign-download', (req, res) => {
    const b = serverState.blobs.find(x => x.id === req.params.id);
    if (!b) { res.status(404).json({ error: 'not_found' }); return; }
    const token = createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 24);
    serverState.pendingDownloads.set(token, b.id);
    res.json({
      url: `http://127.0.0.1:${serverPort}/storage/download/${token}`,
      method: 'GET', headers: {}, expiresAt: Date.now() + 60_000,
    });
  });

  app.get('/storage/download/:token', (req, res) => {
    const blobId = serverState.pendingDownloads.get(req.params.token);
    if (!blobId) { res.status(401).end(); return; }
    const b = serverState.blobs.find(x => x.id === blobId);
    if (!b) { res.status(404).end(); return; }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(b.body.length));
    res.end(b.body);
  });

  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  serverPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v == null) delete process.env[k];
    else            process.env[k] = v;
  }
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cr-vault-client-'));
  setEnv('CHAT_RECALL_DATA_DIR',    join(tmp, 'data'));
  setEnv('CHAT_RECALL_CLAUDE_HOME', join(tmp, 'claude'));
  setEnv('CHAT_RECALL_GEMINI_HOME', join(tmp, 'gemini'));
  setEnv('CHAT_RECALL_CODEX_HOME',  join(tmp, 'codex'));
  setEnv('CHAT_RECALL_OPENCODE_DB', join(tmp, 'opencode', 'opencode.db'));
  setEnv('VAULT_TEST_TOKEN', 'fake-bearer-for-test');

  // Mark Claude as installed and seed a session JSONL.
  mkdirSync(join(tmp, 'claude', 'projects', '-home-user-foo'), { recursive: true });
  writeFileSync(
    join(tmp, 'claude', 'projects', '-home-user-foo', 'aaaa-bbbb.jsonl'),
    '{"role":"user","text":"hi"}\n{"role":"assistant","text":"hello"}\n',
  );

  _resetSourceSettingsCache();

  // Configure team settings to point at the fake server.
  const s = loadSettings();
  s.team = {
    ...s.team,
    enabled: true,
    serverUrl: `http://127.0.0.1:${serverPort}`,
    teamId: 'team-fake',
    tokenRef: 'VAULT_TEST_TOKEN',
  };
  saveSettings(s);

  // Reset fake server state per test.
  serverState.blobs = [];
  serverState.pendingUploads = new Map();
  serverState.pendingDownloads = new Map();
});

describe('vault-client end-to-end', () => {
  test('vaultEnable persists salt + keyId to settings', () => {
    const r = vaultEnable('correct-horse-battery', { existingSaltHex: '00'.repeat(32) });
    expect(r.saltHex).toBe('00'.repeat(32));
    expect(r.keyId).toMatch(/^[0-9a-f]{24}$/);

    const s = vaultStatus();
    expect(s.enabled).toBe(true);
    expect(s.saltHex).toBe('00'.repeat(32));
    expect(s.keyId).toBe(r.keyId);
  });

  test('rejects too-short passphrase via underlying KDF guard', () => {
    expect(() => vaultEnable('short')).toThrow(/8 characters/);
  });

  test('full sync → restore on a fresh data dir round-trips the source bytes', async () => {
    // Use ARGON2_TEST? vaultEnable uses ARGON2_PROD always. For test
    // speed we'd ideally use TEST params, but the orchestration code
    // always reaches for PROD. Accept the ~5s penalty for one-time
    // KDF here — the round-trip is the point.
    vaultEnable('correct-horse-battery', { existingSaltHex: '11'.repeat(32) });

    const sync = await vaultSync('correct-horse-battery');
    expect(sync.uploaded.length).toBe(1);
    expect(sync.uploaded[0].sessionId).toBe('aaaa-bbbb');
    expect(sync.failures).toEqual([]);

    // Wipe the imported dir + run restore on the same machine —
    // simulates the "second device" without needing a second tmp tree.
    const importedRoot = join(tmp, 'data', 'imported');
    if (existsSync(importedRoot)) rmSync(importedRoot, { recursive: true, force: true });
    const restore = await vaultRestore('correct-horse-battery');
    expect(restore.restored.length).toBe(1);
    expect(restore.failures).toEqual([]);

    const restoredPath = restore.restored[0].path;
    const original = readFileSync(join(tmp, 'claude', 'projects', '-home-user-foo', 'aaaa-bbbb.jsonl'));
    const restored = readFileSync(restoredPath);
    expect(Buffer.compare(original, restored)).toBe(0);
  }, 30_000);

  test('second sync skips unchanged files (idempotent)', async () => {
    vaultEnable('correct-horse-battery', { existingSaltHex: '22'.repeat(32) });
    await vaultSync('correct-horse-battery');
    const r2 = await vaultSync('correct-horse-battery');
    expect(r2.uploaded).toEqual([]);
    expect(r2.skipped.find(s => s.reason === 'unchanged')).toBeDefined();
  }, 30_000);

  test('wrong passphrase on sync after enable fails fast', async () => {
    vaultEnable('correct-horse-battery', { existingSaltHex: '33'.repeat(32) });
    await expect(vaultSync('different-passphrase')).rejects.toThrow(/Wrong passphrase/);
  }, 20_000);

  test('vaultStatus reports disabled before enable, enabled after', () => {
    expect(vaultStatus().enabled).toBe(false);
    vaultEnable('correct-horse-battery', { existingSaltHex: '44'.repeat(32) });
    expect(vaultStatus().enabled).toBe(true);
  });

  test('vaultSync without team config throws VaultConfigError', async () => {
    const s = loadSettings();
    s.team = { ...s.team, enabled: false };
    saveSettings(s);
    await expect(vaultSync('correct-horse-battery')).rejects.toThrow(VaultConfigError);
  });
});
