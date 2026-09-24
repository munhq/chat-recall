/**
 * The batched chunk cursor must agree with the single-session one, exactly.
 *
 * The caller numbers new tail chunks from this cursor. A batched reader that
 * parses `:sync:<n>` even slightly differently reports a lower maximum, the
 * caller re-issues ids that already exist, and `appendChunksFTS` upserts over
 * real chunks — silent data loss. The first version of maxSyncChunkIndexMany
 * split on the separator where the original anchors `/:sync:(\d+)$/`, which
 * disagrees on any id with a suffix after the number.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { MemoryChunk } from '../../types/memory.js';
import { pgAdminUrl } from '../../test-support/pg-urls.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const T = 'chunk_cursor_team';

const chunk = (item: string, id: string): MemoryChunk => ({
  chunkId: id, itemId: item, sourceType: 'session', title: 't', text: 'x',
  chunkType: 'user', projectPath: '/home/user/code/example', projectId: 'git:github.com/owner/example',
  filePath: '/home/user/code/example/t.jsonl', mtime: 1,
} as MemoryChunk);

(PG_URL ? describe : describe.skip)('the tail-append chunk cursor', () => {
  let store: any; let sudo: any;

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: pgAdminUrl() });
    const { createStore } = await import('./index.js');
    store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: T } as any);
    await sudo.query(`DELETE FROM memory_chunks WHERE tenant=$1`, [T]);
    await store.addChunksFTS([
      chunk('s1', 's1_user_0'),                 // no cursor at all
      chunk('s1', 's1:sync:3'),
      chunk('s1', 's1:sync:11'),                // the max, and not 3 by string order
      chunk('s2', 's2:sync:7'),
      chunk('s3', 's3:sync:2_suffix'),          // NOT a cursor: digits must end it
      chunk('s4', 's4_user_0'),                 // no cursor → 0
    ]);
  }, 40000);

  afterAll(async () => {
    try { await sudo.query(`DELETE FROM memory_chunks WHERE tenant=$1`, [T]); } catch { /* best effort */ }
    await store?.close(); await sudo?.end();
  });

  test('THE POINT: batched and single-session agree on every item', async () => {
    const ids = ['s1', 's2', 's3', 's4'];
    const many = await store.maxSyncChunkIndexMany(ids);
    for (const id of ids) {
      expect(many.get(id) ?? 0, `cursor for ${id}`).toBe(await store.maxSyncChunkIndex(id));
    }
  }, 30000);

  test('the maximum is numeric, not lexical', async () => {
    expect((await store.maxSyncChunkIndexMany(['s1'])).get('s1')).toBe(11);
  });

  test('an id with a suffix after the number is not a cursor', async () => {
    expect((await store.maxSyncChunkIndexMany(['s3'])).get('s3') ?? 0).toBe(0);
  });

  test('an item with no cursor reads 0, not undefined-shaped nonsense', async () => {
    expect((await store.maxSyncChunkIndexMany(['s4'])).get('s4') ?? 0).toBe(0);
  });

  test('an empty request asks the database nothing', async () => {
    expect((await store.maxSyncChunkIndexMany([])).size).toBe(0);
  });
});
