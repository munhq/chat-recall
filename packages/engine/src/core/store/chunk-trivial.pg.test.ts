/**
 * #10 follow-up: the `trivial` flag must follow the parent session.
 *
 * The pending-vectors count and the embed worker no longer run a per-chunk
 * EXISTS against memory_metadata to decide whether a chunk belongs to a trivial
 * session; they read memory_chunks.trivial, which is in the partial index
 * predicate. If the writer leaves a trivial chunk unflagged, the count and the
 * queue include work that will never run. If it never clears the flag when a
 * session grows past the threshold, that session's chunks are never embedded.
 * This test drives both directions through the real write paths and reads the
 * column back.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { MemoryChunk, MemoryItem } from '../../types/memory.js';
import { pgAdminUrl } from '../../test-support/pg-urls.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const T = 'chunk_trivial';

const item = (id: string, extra: Record<string, unknown>, sourceType: MemoryItem['sourceType'] = 'session'): MemoryItem => ({
  id,
  sourceType,
  title: 'a session',
  projectPath: '/home/user/code/example',
  filePath: `/home/user/code/example/${id}.jsonl`,
  mtime: Date.now(),
  extra,
});

const chunk = (id: string, itemId: string, text: string): MemoryChunk => ({
  chunkId: id,
  itemId,
  sourceType: 'session',
  title: 'a session',
  text,
  chunkType: 'user',
  projectPath: '/home/user/code/example',
  filePath: `/home/user/code/example/${itemId}.jsonl`,
  mtime: Date.now(),
} as MemoryChunk);

(PG_URL ? describe : describe.skip)('memory_chunks.trivial (#10)', () => {
  let sudo: any; let fts: any;

  async function flag(chunkId: string): Promise<boolean | undefined> {
    const r = await sudo.query(
      `SELECT trivial FROM memory_chunks WHERE tenant=$1 AND chunk_id=$2`, [T, chunkId]);
    return r.rows[0]?.trivial;
  }

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: pgAdminUrl() });
    const { PgStore } = await import('./pg.js');
    fts = new PgStore(PG_URL!, T);
    await fts.init();
    await sudo.query(`DELETE FROM memory_chunks WHERE tenant=$1`, [T]);
    await sudo.query(`DELETE FROM memory_metadata WHERE tenant=$1`, [T]);
  }, 60000);

  afterAll(async () => {
    try {
      await sudo.query(`DELETE FROM memory_chunks WHERE tenant=$1`, [T]);
      await sudo.query(`DELETE FROM memory_metadata WHERE tenant=$1`, [T]);
    } catch { /* best effort */ }
    await fts?.close(); await sudo?.end();
  });

  test('a chunk of a trivial session is flagged', async () => {
    await fts.setItems([item('s-trivial', { messageCount: 2, outputTokens: 100 })]);
    await fts.addChunksFTS([chunk('t1', 's-trivial', 'one short turn')]);
    expect(await flag('t1')).toBe(true);
  }, 30000);

  test('a chunk of a normal session is not flagged', async () => {
    await fts.setItems([item('s-normal', { messageCount: 12, outputTokens: 9000 })]);
    await fts.addChunksFTS([chunk('n1', 's-normal', 'a long conversation')]);
    expect(await flag('n1')).toBe(false);
  }, 30000);

  test('a session that grows past the threshold releases its old chunks', async () => {
    await fts.setItems([item('s-grow', { messageCount: 2, outputTokens: 100 })]);
    await fts.addChunksFTS([chunk('g1', 's-grow', 'the first short exchange')]);
    expect(await flag('g1')).toBe(true);

    // The same session now has many turns and a lot of output. writeItemRows
    // must clear the flag on rows written before it crossed the line.
    await fts.setItems([item('s-grow', { messageCount: 12, outputTokens: 9000 })]);
    expect(await flag('g1')).toBe(false);

    // A chunk written after the growth is unflagged too.
    await fts.addChunksFTS([chunk('g2', 's-grow', 'the conversation continued')]);
    expect(await flag('g2')).toBe(false);
  }, 30000);

  test('a non-session chunk is never flagged', async () => {
    await fts.setItems([item('plan-1', { messageCount: 1, outputTokens: 10 }, 'plan')]);
    await fts.addChunksFTS([{ ...chunk('p1', 'plan-1', 'a plan step'), sourceType: 'plan' }]);
    expect(await flag('p1')).toBe(false);
  }, 30000);
});
