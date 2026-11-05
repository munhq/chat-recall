/**
 * #11: the cached conversation body moves to object storage.
 *
 * `content_cache.content_json` held about 82 KB per row in TOAST and every byte
 * went through the WAL and every replica. With a bucket configured, the body is
 * a gzipped object and the row keeps the key, the digest and the size; the
 * column stays for deployments with no bucket and for rows written before one
 * existed. These cases drive the real store against a real Postgres, as the RLS
 * role, with an in-memory object store that records every operation.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createStore } from './index.js';
import {
  ObjectNotFound, gunzipText, readCachedBody, resetObjectStore, setObjectStoreForTests, type RawObjectStore,
} from './object-store.js';
import { runWithAuthor } from './tenant-context.js';
import { pgAdminUrl, pgTestUrl } from '../../test-support/pg-urls.js';

const PG_URL = pgTestUrl();
const AUTHOR = { sub: 'content-cache-author', device: 'dev-1' };

class MemoryObjects implements RawObjectStore {
  readonly bucket = 'memory';
  readonly objects = new Map<string, Buffer>();
  failPuts = false;
  async put(key: string, body: Buffer) {
    if (this.failPuts) throw new Error('bucket unavailable');
    this.objects.set(key, Buffer.from(body));
  }
  async get(key: string) {
    const b = this.objects.get(key);
    if (!b) throw new ObjectNotFound(key);
    return b;
  }
  async delete(key: string) { this.objects.delete(key); }
}

(PG_URL ? describe : describe.skip)('content_cache bodies in object storage (#11)', () => {
  let admin: any;
  let store: any;
  let objects: MemoryObjects;
  const tenant = `content_cache_obj_${process.pid}`;

  const asAuthor = <T>(fn: () => Promise<T>) => runWithAuthor(AUTHOR, fn);
  const useObjects = () => { objects = new MemoryObjects(); setObjectStoreForTests(objects); };
  const row = async (id: string) => (await admin.query(
    `SELECT content_json, object_key, content_hash, content_bytes, mtime
       FROM content_cache WHERE tenant=$1 AND id=$2 AND source_type='session'`, [tenant, id])).rows[0];
  const session = (id: string) => asAuthor(() => store.setItem({
    id, sourceType: 'session', title: id, projectPath: '/home/user/code/example',
    projectId: 'example-app', filePath: '', mtime: 1, contentPreview: id,
  }));

  beforeAll(async () => {
    const pg = (await import('pg')).default;
    admin = new pg.Pool({ connectionString: pgAdminUrl(), max: 2 });
    store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant } as any);
  }, 60000);

  afterAll(async () => {
    try { await admin.query(`DELETE FROM content_cache WHERE tenant=$1`, [tenant]); } catch { /* best effort */ }
    resetObjectStore();
    await store?.close();
    await admin?.end();
  });
  afterEach(() => resetObjectStore());

  test('a write stores the body as an object and keeps only metadata in the row', async () => {
    useObjects();
    const id = 's-object';
    const body = JSON.stringify({ v: 1, messages: [{ line: 1, role: 'user', content: 'hello' }] });
    await session(id);
    await asAuthor(() => store.setCachedContent(id, 'session', 1000, body));

    const r = await row(id);
    expect(r.content_json).toBe('');
    expect(r.object_key).toMatch(new RegExp(`^content/${tenant}/session/${id}\\.[0-9a-f]{64}\\.json\\.gz$`));
    expect(Number(r.content_bytes)).toBe(Buffer.byteLength(body));
    expect(gunzipText(objects.objects.get(r.object_key)!)).toBe(body);

    expect(await asAuthor(() => store.getCachedContent(id, 'session', 1000))).toBe(body);
    expect(await asAuthor(() => store.getCachedContentStale(id, 'session'))).toEqual({ content: body, mtime: 1000 });
  }, 30000);

  test('a row written before the bucket existed still reads from the column', async () => {
    // No object store configured for this case, which is exactly a deployment
    // that has none: the write keeps the body in the column.
    const id = 's-legacy';
    const body = JSON.stringify({ v: 1, messages: [{ line: 1, role: 'user', content: 'old' }] });
    await session(id);
    await asAuthor(() => store.setCachedContent(id, 'session', 1000, body));
    const r = await row(id);
    expect(r.object_key).toBe('');
    expect(r.content_json).toBe(body);
    expect(await readCachedBody(r)).toBe(body);
    expect(await asAuthor(() => store.getCachedContent(id, 'session', 1000))).toBe(body);
  }, 30000);

  test('a changed body writes a new object and deletes the superseded one', async () => {
    useObjects();
    const id = 's-rewrite';
    await session(id);
    await asAuthor(() => store.setCachedContent(id, 'session', 1000, JSON.stringify({ v: 1, tag: 'one' })));
    const first = (await row(id)).object_key;
    await asAuthor(() => store.setCachedContent(id, 'session', 2000, JSON.stringify({ v: 1, tag: 'two' })));
    const second = (await row(id)).object_key;
    expect(second).not.toBe(first);
    expect(objects.objects.has(first)).toBe(false);
    expect(gunzipText(objects.objects.get(second)!)).toBe(JSON.stringify({ v: 1, tag: 'two' }));
  }, 30000);

  test('a rewrite that rolls back keeps the committed object its row names', async () => {
    useObjects();
    const id = 's-rollback';
    await session(id);
    await asAuthor(() => store.setCachedContent(id, 'session', 1000, JSON.stringify({ tag: 'committed' })));
    const committed = (await row(id)).object_key;

    await expect(asAuthor(() => store.withTransaction(async () => {
      await store.setCachedContent(id, 'session', 2000, JSON.stringify({ tag: 'uncommitted' }));
      throw new Error('a later step of the ingest failed');
    }))).rejects.toThrow('a later step');

    expect((await row(id)).object_key).toBe(committed);
    expect(objects.objects.has(committed)).toBe(true);
    expect(await asAuthor(() => store.getCachedContent(id, 'session', 1000))).toBe(JSON.stringify({ tag: 'committed' }));
  }, 30000);

  test('a purge deletes the envelope object', async () => {
    useObjects();
    const id = 's-purge';
    await session(id);
    await asAuthor(() => store.setCachedContent(id, 'session', 1000, JSON.stringify({ tag: 'purge' })));
    const key = (await row(id)).object_key;
    expect(objects.objects.has(key)).toBe(true);
    await asAuthor(() => store.purgeSessionsMany([id]));
    expect(await row(id)).toBeUndefined();
    expect(objects.objects.has(key)).toBe(false);
  }, 30000);

  test('a failed object write falls back to the column instead of losing the body', async () => {
    useObjects();
    objects.failPuts = true;
    const id = 's-fallback';
    await session(id);
    await asAuthor(() => store.setCachedContent(id, 'session', 1000, JSON.stringify({ tag: 'kept' })));
    const r = await row(id);
    expect(r.object_key).toBe('');
    expect(r.content_json).toBe(JSON.stringify({ tag: 'kept' }));
    expect(await asAuthor(() => store.getCachedContent(id, 'session', 1000))).toBe(JSON.stringify({ tag: 'kept' }));
  }, 30000);
});
