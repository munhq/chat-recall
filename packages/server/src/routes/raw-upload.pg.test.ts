/**
 * A raw archive uploaded in parts straight to object storage, end to end:
 * the real routes as a named device author on Postgres with RLS enforced,
 * and a real S3 server that checks every signature.
 *
 * THE FAILURE: the client sent an archive only when it gzipped to 8 MB or
 * less, so a larger session kept an archive of 6.6 MB against 54 MB on disk.
 *
 * Gated on DATABASE_URL and RAW_ARCHIVE_S3_ENDPOINT.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { pgAdminUrl, pgTestUrl } from '@chat-recall/engine/test-support/pg-urls.js';

const PG_URL = pgTestUrl();
const S3 = !!process.env.RAW_ARCHIVE_S3_ENDPOINT && !!process.env.RAW_ARCHIVE_S3_BUCKET;
const TENANT = `raw_upload_${process.pid}`;
const OTHER = `raw_upload_other_${process.pid}`;
const SESSION = '44444444-5555-6666-7777-888888888888';

(PG_URL && S3 ? describe : describe.skip)('raw archive in parts (RLS enforced, real S3)', () => {
  const saved = { storage: process.env.CHAT_RECALL_STORAGE, auth: process.env.AUTH_PROVIDER };
  let admin: pg.Pool;
  let app: express.Express;
  let token: string;
  let otherToken: string;

  async function clean(): Promise<void> {
    for (const t of ['kv_store', 'raw_sessions', 'content_cache', 'memory_chunks', 'session_metadata', 'memory_metadata', 'agent_tokens']) {
      try { await admin.query(`DELETE FROM "${t}" WHERE tenant = ANY($1)`, [[TENANT, OTHER]]); } catch { /* table absent */ }
    }
  }

  beforeAll(async () => {
    process.env.CHAT_RECALL_STORAGE = 'postgres';
    process.env.AUTH_PROVIDER = 'keycloak';
    admin = new pg.Pool({ connectionString: pgAdminUrl(), max: 2 });
    const { createControlPlane } = await import('../imports.js');
    const { resetObjectStore } = await import('@chat-recall/engine/core/store/object-store.js');
    resetObjectStore();
    const syncRouter = (await import('./sync.js')).default;
    app = express();
    app.use(express.json({ limit: '32mb' }));
    app.use('/api/sync', syncRouter);
    await clean();
    const cp = await createControlPlane();
    try {
      token = await cp.mintAgentToken(TENANT, 'raw-upload-laptop', 'raw-upload-author');
      otherToken = await cp.mintAgentToken(OTHER, 'other-laptop', 'other-author');
    } finally { await cp.close(); }
    // The client uploads an archive after the session's full sync, so the
    // session row exists; raw_sessions is visible only through it (RLS).
    const conv = await request(app).post('/api/sync').set('authorization', `Bearer ${token}`).send({ conversations: [{
      session_id: SESSION, tool: 'claude', project_path: '/home/user/code/example', mtime: 1000,
      envelope: { v: (await import('@chat-recall/engine/transcript/index.js')).TRANSCRIPT_VERSION, messages: [{ line: 1, role: 'user', content: 'hello' }], subagents: [] },
      redacted_text: 'hello',
    }] });
    expect(conv.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    try { await clean(); } finally { await admin?.end(); }
    if (saved.storage === undefined) delete process.env.CHAT_RECALL_STORAGE; else process.env.CHAT_RECALL_STORAGE = saved.storage;
    if (saved.auth === undefined) delete process.env.AUTH_PROVIDER; else process.env.AUTH_PROVIDER = saved.auth;
  });

  /** A container that gzips to a little over two 8 MiB parts (random bytes do not compress). */
  function archive(): { gz: Buffer; size: number } {
    const text = randomBytes(9 * 1024 * 1024).toString('base64');
    const json = JSON.stringify({ v: 1, tool: 'claude', mtime: 1000, files: [{ name: `${SESSION}.jsonl`, text }] });
    return { gz: gzipSync(json, { level: 1 }), size: Buffer.byteLength(json) };
  }

  const start = (tok: string, body: object) => request(app).post('/api/sync/raw-upload/start').set('authorization', `Bearer ${tok}`).send(body);
  const complete = (tok: string, body: object) => request(app).post('/api/sync/raw-upload/complete').set('authorization', `Bearer ${tok}`).send(body);

  async function putParts(urls: string[], gz: Buffer, partBytes: number) {
    const parts: Array<{ part_number: number; etag: string }> = [];
    for (const [i, url] of urls.entries()) {
      const r = await fetch(url, { method: 'PUT', body: gz.subarray(i * partBytes, (i + 1) * partBytes) });
      expect(r.status).toBe(200);
      parts.push({ part_number: i + 1, etag: r.headers.get('etag')! });
    }
    return parts;
  }

  test('THE FAILURE: an archive over 8 MB gzipped is stored whole, and reads back byte for byte', async () => {
    const { gz, size } = archive();
    expect(gz.length).toBeGreaterThan(8 * 1024 * 1024);
    const s = await start(token, { session_id: SESSION, tool: 'claude', mtime: 2000, size, gz_size: gz.length });
    expect(s.status).toBe(200);
    expect(s.body.urls).toHaveLength(Math.ceil(gz.length / s.body.part_bytes));
    const parts = await putParts(s.body.urls, gz, s.body.part_bytes);

    // Another tenant cannot complete it: the open upload is tenant-scoped.
    expect((await complete(otherToken, { session_id: SESSION, upload_id: s.body.upload_id, parts })).status).toBe(404);
    // Nor can a request that names another session.
    expect((await complete(token, { session_id: 'another', upload_id: s.body.upload_id, parts })).status).toBe(400);

    const c = await complete(token, { session_id: SESSION, upload_id: s.body.upload_id, parts });
    expect(c.status).toBe(200);
    expect(c.body.result).toBe('stored');

    const { createStore, runWithTenant } = await import('../imports.js');
    const raw = await runWithTenant(TENANT, async () => {
      const store = await createStore();
      try { return await store.getRawSession(SESSION); } finally { await store.close(); }
    });
    expect(raw!.size).toBe(size);
    expect(Buffer.compare(gunzipSync(raw!.gz), gunzipSync(gz))).toBe(0);
  }, 120_000);

  test('a smaller archive is refused before any byte moves', async () => {
    const r = await start(token, { session_id: SESSION, tool: 'claude', mtime: 3000, size: 10, gz_size: 10 });
    expect(r.body).toEqual({ result: 'shrink-protected' });
  });

  test('a part list that does not match the upload is refused', async () => {
    const { gz, size } = archive();
    const s = await start(token, { session_id: SESSION, tool: 'claude', mtime: 4000, size: size + 1, gz_size: gz.length });
    expect(s.status).toBe(200);
    const c = await complete(token, { session_id: SESSION, upload_id: s.body.upload_id, parts: [{ part_number: 1, etag: 'x' }] });
    expect(c.status).toBe(400);
  });

  test('the client streams a session from disk and uploads it through a live server', async () => {
    const { writeArchiveFile, uploadArchiveFile } = await import('../../../cli/src/raw-archive-parts.js');
    const { redactSecrets } = await import('@chat-recall/engine/core/secret-redactor.js');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'cr-raw-e2e-'));
    const server = app.listen(0);
    try {
      // ~20 MB of transcript that does not compress below two parts.
      const lines = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ type: 'user', i, message: { content: randomBytes(7000).toString('base64') } }));
      lines.push(JSON.stringify({ type: 'user', message: { content: 'the key is AKIAIOSFODNN7EXAMPLE' } }));
      const path = join(dir, `${SESSION}.jsonl`);
      writeFileSync(path, lines.join('\n') + '\n');
      const file = await writeArchiveFile({ kind: 'disk', files: [{ name: `${SESSION}.jsonl`, path }] }, { tool: 'claude', mtime: 9000 },
        (t) => redactSecrets(t, { force: true, count: { redactions: 0 } }), dir);
      expect(file.gzSize).toBeGreaterThan(8 * 1024 * 1024);
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      expect(await uploadArchiveFile(base, token, { sessionId: SESSION, tool: 'claude', mtime: 9000, file })).toBe('stored');

      const { createStore, runWithTenant } = await import('../imports.js');
      const raw = await runWithTenant(TENANT, async () => {
        const store = await createStore();
        try { return await store.getRawSession(SESSION); } finally { await store.close(); }
      });
      const text = JSON.parse(gunzipSync(raw!.gz).toString('utf-8')).files[0].text as string;
      expect(text.split('\n').filter(Boolean)).toHaveLength(2001);
      expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(raw!.size).toBe(file.size);
      // The same archive again is unchanged, and no byte moves.
      expect(await uploadArchiveFile(base, token, { sessionId: SESSION, tool: 'claude', mtime: 9000, file })).toBe('unchanged');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('no token, no upload', async () => {
    expect((await request(app).post('/api/sync/raw-upload/start').send({})).status).toBe(401);
  });
});
