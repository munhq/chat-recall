/**
 * Tail segments against a real Postgres, as the role that row-level security
 * applies to (issue #27).
 *
 * Every Postgres path of the segments ran in production before any test drove it,
 * and the first one failed there: a segment row has an id that no `memory_metadata`
 * row carries, so the `author_visibility` policy refused the insert (HTTP 500,
 * 2026-11-16). These cases write, read, seed, compact and purge segments through
 * the real store, with an author context, the way the sync route does.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createStore } from './index.js';
import { ObjectNotFound, resetObjectStore, setObjectStoreForTests, type RawObjectStore } from './object-store.js';
import { runWithAuthor } from './tenant-context.js';
import { markerTail, tailRowId, TAIL_SOURCE_TYPE } from './session-tails.js';
import { pgAdminUrl, pgTestUrl } from '../../test-support/pg-urls.js';

const PG_URL = pgTestUrl();
const AUTHOR = { sub: 'tail-author', device: 'dev-1' };

class MemoryObjects implements RawObjectStore {
  readonly bucket = 'memory';
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) { this.objects.set(key, Buffer.from(body)); }
  gets = 0;
  async get(key: string) {
    this.gets++;
    const b = this.objects.get(key);
    if (!b) throw new ObjectNotFound(key);
    return b;
  }
  async delete(key: string) { this.objects.delete(key); }
}

const msg = (line: number, content = `m${line}`) => ({ line, role: line % 2 ? 'user' : 'assistant', content });
const base = (n: number, o: number) => JSON.stringify({ v: 6, messages: Array.from({ length: n }, (_, i) => msg(i + 1)), subagents: [], o });

(PG_URL ? describe : describe.skip)('tail segments in Postgres', () => {
  let admin: any;
  let store: any;
  let objects: MemoryObjects;
  const tenant = `tails_${process.pid}`;

  const asAuthor = <T>(fn: () => Promise<T>) => runWithAuthor(AUTHOR, fn);
  const session = (id: string) => asAuthor(() => store.setItem({
    id, sourceType: 'session', title: id, projectPath: '/home/user/code/example',
    projectId: 'example-app', filePath: '', mtime: 1, contentPreview: id,
  }));
  /** Rows of the session's segments, read past row-level security. */
  const segmentRows = async (id: string) => (await admin.query(
    `SELECT id, content_json, object_key FROM content_cache WHERE tenant=$1 AND source_type=$2 AND left(id,-11)=$3 ORDER BY id`,
    [tenant, TAIL_SOURCE_TYPE, id])).rows;
  const seed = async (id: string, n: number, o: number, mtime = 1000) => {
    await session(id);
    await asAuthor(() => store.setCachedContent(id, 'session', mtime, base(n, o)));
  };

  beforeAll(async () => {
    const pg = (await import('pg')).default;
    admin = new pg.Pool({ connectionString: pgAdminUrl(), max: 2 });
    store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant } as any);
  }, 60000);

  afterAll(async () => {
    try {
      await admin.query(`DELETE FROM content_cache WHERE tenant=$1`, [tenant]);
      await admin.query(`DELETE FROM memory_metadata WHERE tenant=$1`, [tenant]);
    } catch { /* best effort */ }
    resetObjectStore();
    await store?.close();
    await admin?.end();
  });
  afterEach(() => resetObjectStore());

  test('an ingest batch writes a segment as the member, which the visibility policy used to refuse', async () => {
    const id = 'tail-batch';
    await seed(id, 3, 100);
    await asAuthor(() => store.writeIngestBatch({
      sessionTails: [{ sessionId: id, seq: 0, mtime: 1000, tail: markerTail(6, 100, 3) }],
    }));
    await asAuthor(() => store.writeIngestBatch({
      sessionTails: [{ sessionId: id, seq: 1, mtime: 2000, tail: { v: 6, base: 100, o: 160, lastLine: 5, messages: [msg(4), msg(5)] } }],
    }));
    const rows = await segmentRows(id);
    expect(rows.map((r: any) => r.id)).toEqual([tailRowId(id, 0), tailRowId(id, 1)]);
    const state = (await asAuthor(() => store.getSessionTailStates([id]))).get(id);
    expect(state).toMatchObject({ seq: 1, o: 160, lastLine: 5 });
  });

  test('a reader gets base plus segments in order', async () => {
    const id = 'tail-batch';
    const content = (await asAuthor(() => store.getCachedContentStale(id, 'session'))).content;
    const env = JSON.parse(content);
    expect(env.messages.map((m: any) => m.line)).toEqual([1, 2, 3, 4, 5]);
    expect(env.o).toBe(160);
    const page = await asAuthor(() => store.getSessionPage(id, { offset: 2, limit: 2 }));
    expect(page.total).toBe(5);
    expect(page.messages.map((m: any) => m.line)).toEqual([3, 4]);
  });

  test('a segment above 32 KB goes to the object store and a small one stays in its row', async () => {
    objects = new MemoryObjects();
    setObjectStoreForTests(objects);
    const id = 'tail-objects';
    await seed(id, 2, 50);
    const big = Array.from({ length: 40 }, (_, i) => msg(3 + i, 'x'.repeat(2000)));
    await asAuthor(() => store.writeIngestBatch({
      sessionTails: [
        { sessionId: id, seq: 0, mtime: 1000, tail: markerTail(6, 50, 2) },
        { sessionId: id, seq: 1, mtime: 2000, tail: { v: 6, base: 50, o: 90, lastLine: 42, messages: big } },
      ],
    }));
    const [marker, segment] = await segmentRows(id);
    expect(marker.object_key).toBe('');
    expect(marker.content_json).not.toBe('');
    expect(segment.object_key).not.toBe('');
    expect(segment.content_json).toBe('');
    const env = JSON.parse((await asAuthor(() => store.getCachedContentStale(id, 'session'))).content);
    expect(env.messages).toHaveLength(42);
  });

  test('a new base deletes the segments and their objects', async () => {
    const id = 'tail-objects';
    setObjectStoreForTests(objects);   // the afterEach of the previous case reset it
    const rows = await segmentRows(id);
    expect(rows.length).toBe(2);
    const segmentKey = rows.find((r: any) => r.object_key)!.object_key as string;
    expect(objects.objects.has(segmentKey)).toBe(true);
    await asAuthor(() => store.setCachedContent(id, 'session', 3000, base(7, 500)));
    expect(await segmentRows(id)).toEqual([]);
    // The objects go after the commit, in the background.
    for (let i = 0; i < 40 && objects.objects.has(segmentKey); i++) await new Promise((r) => setTimeout(r, 25));
    expect(objects.objects.has(segmentKey)).toBe(false);
    expect((await asAuthor(() => store.getSessionTailStates([id]))).has(id)).toBe(false);
  });

  test('a session with no state is seeded from the end of its base, reading no more than the text', async () => {
    const id = 'tail-seed';
    await seed(id, 4, 777);
    expect((await asAuthor(() => store.getSessionTailStates([id]))).has(id)).toBe(false);
    const seeded = await asAuthor(() => store.seedSessionTailStates([id]));
    expect(seeded.get(id)).toMatchObject({ seq: 0, o: 777, lastLine: 4 });
    expect((await asAuthor(() => store.getSessionTailStates([id]))).get(id)).toMatchObject({ seq: 0, o: 777, lastLine: 4 });
  });

  test('compaction merges the segments into the base and leaves the marker', async () => {
    const id = 'tail-compact';
    await seed(id, 3, 100);
    await asAuthor(() => store.writeIngestBatch({
      sessionTails: [
        { sessionId: id, seq: 0, mtime: 1000, tail: markerTail(6, 100, 3) },
        { sessionId: id, seq: 1, mtime: 2000, tail: { v: 6, base: 100, o: 150, lastLine: 5, messages: [msg(4), msg(5)] } },
        { sessionId: id, seq: 2, mtime: 2500, tail: { v: 6, base: 150, o: 200, lastLine: 6, messages: [msg(6)] } },
      ],
    }));
    const before = JSON.parse((await asAuthor(() => store.getCachedContentStale(id, 'session'))).content);
    const result = await store.compactSessionTails(id);
    expect(result).toEqual({ segments: 3, messages: 6 });
    const after = JSON.parse((await asAuthor(() => store.getCachedContentStale(id, 'session'))).content);
    expect(after.messages).toEqual(before.messages);
    expect(after.o).toBe(200);
    expect((await segmentRows(id)).map((r: any) => r.id)).toEqual([tailRowId(id, 0)]);
    expect((await asAuthor(() => store.getSessionTailStates([id]))).get(id)).toMatchObject({ seq: 0, o: 200, lastLine: 6 });
    expect(await store.compactSessionTails(id)).toBeNull();
  });

  test('only an idle session with enough segments is a candidate for compaction', async () => {
    const id = 'tail-candidate';
    await seed(id, 2, 10);
    const tails = Array.from({ length: 20 }, (_, i) => ({
      sessionId: id, seq: i, mtime: Date.now() - 3_600_000, tail: i === 0 ? markerTail(6, 10, 2) : { v: 6, base: 10, o: 10 + i, lastLine: 2 + i, messages: [msg(2 + i)] },
    }));
    await asAuthor(() => store.writeIngestBatch({ sessionTails: tails }));
    expect(await store.sessionsNeedingCompaction({ limit: 50 })).toContain(id);
    // A segment written a moment ago makes the session active, so it is left alone.
    await asAuthor(() => store.writeIngestBatch({
      sessionTails: [{ sessionId: id, seq: 20, mtime: Date.now(), tail: { v: 6, base: 30, o: 31, lastLine: 23, messages: [msg(23)] } }],
    }));
    expect(await store.sessionsNeedingCompaction({ limit: 50 })).not.toContain(id);
  });

  test('a purge removes the segments with the session', async () => {
    const id = 'tail-purge';
    await seed(id, 2, 10);
    await asAuthor(() => store.writeIngestBatch({
      sessionTails: [{ sessionId: id, seq: 0, mtime: 1000, tail: markerTail(6, 10, 2) }],
    }));
    expect((await segmentRows(id)).length).toBe(1);
    await asAuthor(() => store.purgeSessionsMany([id]));
    expect(await segmentRows(id)).toEqual([]);
  });

  test('a large session is compacted into pages, and a page read reads only the rows that hold it', async () => {
    objects = new MemoryObjects();
    setObjectStoreForTests(objects);
    const id = 'tail-pages';
    const N = 3000;
    const messages = Array.from({ length: N }, (_, i) => msg(i + 1, `body ${i} ` + 'y'.repeat(1000)));
    await session(id);
    await asAuthor(() => store.writeIngestBatch({
      cachedContent: [{ id, sourceType: 'session', mtime: 1000, content: JSON.stringify({ v: 6, messages, subagents: [], o: 9000 }), messageCount: N }],
      sessionTails: [{ sessionId: id, seq: 0, mtime: 1000, tail: markerTail(6, 9000, N) }],
    }));
    // Before the compaction the base holds all 3,000 messages: one row, counted.
    expect(await store.sessionsNeedingCompaction({ limit: 50, idleMs: 0 })).toContain(id);

    const result = await store.compactSessionTails(id);
    expect(result?.messages).toBe(N);
    expect(result?.pages).toBeGreaterThan(3);
    const rows = await segmentRows(id);
    expect(rows.length).toBe((result!.pages as number) + 1);          // the marker and the pages
    const baseCount = (await admin.query(`SELECT msg_count FROM content_cache WHERE tenant=$1 AND id=$2 AND source_type='session'`, [tenant, id])).rows[0].msg_count;
    expect(Number(baseCount)).toBe(0);                                  // the base keeps no messages
    expect(await store.sessionsNeedingCompaction({ limit: 50, idleMs: 0 })).not.toContain(id);

    // The first five messages: the base and one page, not the whole conversation.
    objects.gets = 0;
    const first = await asAuthor(() => store.getSessionPage(id, { offset: 0, limit: 5 }));
    expect(first.total).toBe(N);
    expect(first.messages.map((m: any) => m.line)).toEqual([1, 2, 3, 4, 5]);
    expect(objects.gets).toBeLessThanOrEqual(2);

    // The last five: the base and the last page.
    objects.gets = 0;
    const last = await asAuthor(() => store.getSessionPage(id, { offset: N - 5, limit: 5 }));
    expect(last.messages.map((m: any) => m.line)).toEqual([N - 4, N - 3, N - 2, N - 1, N]);
    expect(objects.gets).toBeLessThanOrEqual(2);

    // A window across two pages reads those two and the base.
    const pages = result!.pages as number;
    const perPage = Math.ceil(N / pages);
    objects.gets = 0;
    const across = await asAuthor(() => store.getSessionPage(id, { offset: perPage - 2, limit: 4 }));
    expect(across.messages).toHaveLength(4);
    expect(across.messages.map((m: any) => m.line)).toEqual([perPage - 1, perPage, perPage + 1, perPage + 2]);
    expect(objects.gets).toBeLessThanOrEqual(3);

    // The merged read still gives the whole conversation, and the state is the last page's.
    const merged = JSON.parse((await asAuthor(() => store.getCachedContentStale(id, 'session'))).content);
    expect(merged.messages.map((m: any) => m.line)).toEqual(messages.map((m) => m.line));
    expect(merged.o).toBe(9000);
    expect((await asAuthor(() => store.getSessionTailStates([id]))).get(id)).toMatchObject({ o: 9000, lastLine: N });
  });

  test('an append after the pages goes into the last page and the page read still counts every message', async () => {
    const id = 'tail-pages';
    setObjectStoreForTests(objects);
    const state = (await asAuthor(() => store.getSessionTailStates([id]))).get(id)!;
    await asAuthor(() => store.writeIngestBatch({
      sessionTails: [{ sessionId: id, seq: state.seq + 1, mtime: 5000, tail: { v: 6, base: 9000, o: 9100, lastLine: 3002, messages: [msg(3001), msg(3002)] } }],
    }));
    const page = await asAuthor(() => store.getSessionPage(id, { offset: 2998, limit: 10 }));
    expect(page.total).toBe(3002);
    expect(page.messages.map((m: any) => m.line)).toEqual([2999, 3000, 3001, 3002]);
  });

  test('a session whose rows were written before the count existed is still read whole', async () => {
    const id = 'tail-uncounted';
    await seed(id, 6, 60);
    await admin.query(`UPDATE content_cache SET msg_count=-1 WHERE tenant=$1 AND id=$2 AND source_type='session'`, [tenant, id]);
    const page = await asAuthor(() => store.getSessionPage(id, { offset: 1, limit: 3 }));
    expect(page.total).toBe(6);
    expect(page.messages.map((m: any) => m.line)).toEqual([2, 3, 4]);
  });

  test('a session with a staged rebuild is left as it is and not listed again', async () => {
    const id = 'tail-rebuild';
    await session(id);
    const staged = { v: 6, messages: Array.from({ length: 1200 }, (_, i) => msg(i + 1, 'z'.repeat(900))), subagents: [], o: 500, rebuild: { v: 6, messages: [msg(1)], subagents: [], o: 100 } };
    await asAuthor(() => store.setCachedContent(id, 'session', 1000, JSON.stringify(staged)));
    await admin.query(`UPDATE content_cache SET msg_count=-1, content_bytes=$3 WHERE tenant=$1 AND id=$2 AND source_type='session'`, [tenant, id, 5 * 1024 * 1024]);
    expect(await store.sessionsNeedingCompaction({ limit: 50, idleMs: 0 })).toContain(id);
    expect(await store.compactSessionTails(id)).toBeNull();
    const kept = JSON.parse((await asAuthor(() => store.getCachedContentStale(id, 'session'))).content);
    expect(kept.messages).toHaveLength(1200);
    expect(kept.rebuild).toBeDefined();
    expect(await store.sessionsNeedingCompaction({ limit: 50, idleMs: 0 })).not.toContain(id);
  });

  test('a session without a stored conversation is listed for a resend', async () => {
    await session('tail-empty');
    const ids = await asAuthor(() => store.listSessionsWithoutContent());
    expect(ids).toContain('tail-empty');
    expect(ids).not.toContain('tail-batch');
  });
});
