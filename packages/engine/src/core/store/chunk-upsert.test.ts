/**
 * Re-syncing a session must not rewrite the chunks that did not change.
 *
 * Acceptance criteria 2 and 3 of docs/SYNC-BATCH-WRITES.md, measured by `ctid`.
 * A row's ctid is its physical location: rewriting a row moves it, leaving it
 * alone does not. `pg_stat_user_tables` cannot be used here — its counters are
 * flushed per backend, and the writer's backend is not the one doing the
 * reading, so a test reads zeroes and passes whatever the code does.
 *
 * `addChunksFTS` used to DELETE every chunk of every affected item and re-insert
 * the lot. A session that gained one turn wrote 440 rows to store one, and an
 * identical re-sync wrote all 220 again for nothing. Chunk ids are positional
 * and deterministic, so an unchanged chunk arrives under the id it already has
 * and `WHERE … IS DISTINCT FROM` suppresses the write in the database.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { MemoryChunk } from '../../types/memory.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const T = 'chunk_upsert_team';
const SESSION = 'sess-chunks';

const chunk = (i: number, text: string): MemoryChunk => ({
  chunkId: `${SESSION}_user_${i}`,
  itemId: SESSION,
  sourceType: 'session',
  title: 'a session',
  text,
  chunkType: 'user',
  projectPath: '/home/user/code/example',
  projectId: 'git:github.com/owner/example',
  filePath: `/home/user/code/example/t.jsonl`,
  mtime: 1,
} as MemoryChunk);

(PG_URL ? describe : describe.skip)('chunk writes', () => {
  let sudo: any; let store: any;

  /** chunk_id → physical row location, for every chunk of this tenant. */
  async function placed(): Promise<Map<string, string>> {
    const r = await sudo.query(
      `SELECT chunk_id, ctid::text AS loc FROM memory_chunks WHERE tenant=$1`, [T]);
    return new Map(r.rows.map((x: any) => [x.chunk_id, x.loc]));
  }

  /** What one write actually did to the table. */
  function diff(before: Map<string, string>, after: Map<string, string>) {
    let inserted = 0, rewritten = 0, untouched = 0;
    for (const [id, loc] of after) {
      if (!before.has(id)) inserted++;
      else if (before.get(id) !== loc) rewritten++;
      else untouched++;
    }
    let deleted = 0;
    for (const id of before.keys()) if (!after.has(id)) deleted++;
    return { inserted, rewritten, untouched, deleted };
  }

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: PG_URL });
    const { createStore } = await import('./index.js');
    store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: T } as any);
    await sudo.query(`DELETE FROM memory_chunks WHERE tenant=$1`, [T]);
  }, 40000);

  afterAll(async () => {
    try { await sudo.query(`DELETE FROM memory_chunks WHERE tenant=$1`, [T]); } catch { /* best effort */ }
    await store?.close(); await sudo?.end();
  });

  const twenty = () => Array.from({ length: 20 }, (_, i) => chunk(i, `turn ${i}`));

  test('the first sync inserts every chunk', async () => {
    const before = await placed();
    await store.addChunksFTS(twenty());
    expect(diff(before, await placed())).toEqual({ inserted: 20, rewritten: 0, untouched: 0, deleted: 0 });
  }, 30000);

  test('CRITERION 2: an identical re-sync writes nothing at all', async () => {
    const before = await placed();
    await store.addChunksFTS(twenty());
    expect(diff(before, await placed())).toEqual({ inserted: 0, rewritten: 0, untouched: 20, deleted: 0 });
  }, 30000);

  test('CRITERION 3: one changed turn rewrites one row, and only that one', async () => {
    const rows = twenty();
    rows[7] = chunk(7, 'turn 7, edited');
    const before = await placed();
    expect(diff(before, (await store.addChunksFTS(rows), await placed())))
      .toEqual({ inserted: 0, rewritten: 1, untouched: 19, deleted: 0 });
  }, 30000);

  test('a session that grew by one turn writes one row', async () => {
    const rows = [...twenty(), chunk(20, 'turn 20')];
    rows[7] = chunk(7, 'turn 7, edited');
    const before = await placed();
    await store.addChunksFTS(rows);
    expect(diff(before, await placed())).toEqual({ inserted: 1, rewritten: 0, untouched: 20, deleted: 0 });
  }, 30000);

  test('a session that shrank drops only the chunks that are gone', async () => {
    const rows = twenty().slice(0, 15);
    rows[7] = chunk(7, 'turn 7, edited');
    const before = await placed();
    await store.addChunksFTS(rows);
    const d = diff(before, await placed());
    expect(d.deleted).toBe(6);           // 21 stored, 15 sent
    expect(d.rewritten).toBe(0);
    expect(d.untouched).toBe(15);
  }, 30000);

  test('another item in the same tenant is untouched by any of it', async () => {
    const other = { ...chunk(0, 'other session'), chunkId: 'sess-other_user_0', itemId: 'sess-other' };
    await store.addChunksFTS([other as MemoryChunk]);
    const before = await placed();
    await store.addChunksFTS(twenty().slice(0, 15));
    const after = await placed();
    expect(after.get('sess-other_user_0')).toBe(before.get('sess-other_user_0'));
  }, 30000);
});
