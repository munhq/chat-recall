/**
 * #10: the `has_vector` flag must follow the vector rows.
 *
 * The pending-vectors gauge (and therefore KEDA) trusts memory_chunks.has_vector
 * instead of checking memory_vectors per chunk. If the embedder writes a vector
 * without setting the flag, work is re-done forever; if it sets the flag without
 * a row, a chunk is never embedded. This test drives both write paths — the
 * synchronous re-embed (addChunks) and the backfill claim (embedMissing) — and
 * reads the column back.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { MemoryChunk } from '../../types/memory.js';
import { pgAdminUrl } from '../../test-support/pg-urls.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const T = 'chunk_has_vector';

const chunk = (id: string, text: string): MemoryChunk => ({
  chunkId: id,
  itemId: 's1',
  sourceType: 'session',
  title: 'a session',
  text,
  chunkType: 'user',
  projectPath: '/home/user/code/example',
  filePath: '/home/user/code/example/s1.jsonl',
  mtime: Date.now(),
} as MemoryChunk);

(PG_URL ? describe : describe.skip)('memory_chunks.has_vector (#10)', () => {
  let sudo: any; let vectors: any; let fts: any;

  async function flag(chunkId: string): Promise<boolean | undefined> {
    const r = await sudo.query(
      `SELECT has_vector FROM memory_chunks WHERE tenant=$1 AND chunk_id=$2`, [T, chunkId]);
    return r.rows[0]?.has_vector;
  }

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: pgAdminUrl() });
    const { PgVectorStore } = await import('./vector.js');
    const { PgStore } = await import('./pg.js');
    const embedder = {
      dimension: 8,
      embed: (texts: string[]) => Promise.resolve(texts.map(() => Array(8).fill(0.1))),
      embedQuery: () => Promise.resolve(Array(8).fill(0.1)),
    } as any;
    vectors = new PgVectorStore(embedder, PG_URL, T);
    await vectors.init();
    fts = new PgStore(PG_URL!, T);
    await fts.init();
    await sudo.query(`DELETE FROM memory_chunks WHERE tenant=$1`, [T]);
    await sudo.query(`DELETE FROM memory_vectors WHERE tenant=$1`, [T]);
  }, 60000);

  afterAll(async () => {
    try {
      await sudo.query(`DELETE FROM memory_chunks WHERE tenant=$1`, [T]);
      await sudo.query(`DELETE FROM memory_vectors WHERE tenant=$1`, [T]);
    } catch { /* best effort */ }
    await fts?.close(); await sudo?.end();
  });

  test('the synchronous embed sets the flag', async () => {
    const c = chunk('a', 'the failover loop started');
    await vectors.addChunks([c]);
    expect(await flag('a')).toBe(true);
  }, 30000);

  test('the backfill claim sets the flag', async () => {
    const c = chunk('b', 'the search index and vector backlog');
    await fts.addChunksFTS([c]);
    expect(await flag('b')).toBe(false);            // in FTS, no vector yet
    const r = await vectors.embedMissing(10);
    expect(r.embedded).toBeGreaterThanOrEqual(1);
    expect(await flag('b')).toBe(true);
  }, 30000);

  test('a failed embed leaves the flag false so the backfill retries', async () => {
    const { PgVectorStore } = await import('./vector.js');
    const failing = new PgVectorStore({
      dimension: 8,
      embed: () => Promise.reject(new Error('gateway down')),
      embedQuery: () => Promise.resolve(Array(8).fill(0.1)),
    } as any, PG_URL, T);
    await failing.init();
    await failing.addChunks([chunk('c', 'the deploy needs a retry')]);
    expect(await flag('c')).toBe(false);
  }, 30000);
});
