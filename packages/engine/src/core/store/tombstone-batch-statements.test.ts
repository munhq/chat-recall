/**
 * A batch's tombstones cost a FIXED number of statements, whatever the batch
 * holds.
 *
 * purgeSession issues 12 DELETEs and addTombstone one more, so the per-tombstone
 * loop at the top of the ingest handler cost 13 round trips each — 650 for a
 * 50-tombstone batch, in front of a request docs/SYNC-BATCH-WRITES.md holds to
 * 15 statements total. Deleting a session is also the one operation a user can
 * trigger in bulk, so the count has to be flat in the number of sessions.
 *
 * Counted by wrapping `query` on the pg pool and client prototypes, so what is
 * measured is round trips the application actually made. See
 * ingest-batch-statements.test.ts, which counts the write path the same way.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { pgAdminUrl } from '../../test-support/pg-urls.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const T = 'tombstone_stmt_team';

/** Round trips made while `fn` runs. */
async function counted<T>(fn: () => Promise<T>): Promise<{ result: T; statements: number }> {
  const targets = [pg.Pool.prototype, (pg as any).Client.prototype];
  const originals = targets.map((t: any) => t.query);
  let statements = 0;
  targets.forEach((t: any, i) => {
    t.query = function (...args: any[]) {
      statements++;
      return originals[i].apply(this, args);
    };
  });
  try {
    return { result: await fn(), statements };
  } finally {
    targets.forEach((t: any, i) => { t.query = originals[i]; });
  }
}

(PG_URL ? describe : describe.skip)('tombstone statement count', () => {
  let store: any; let sudo: any;

  const ids = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}_s${i}`);

  /** Seed one metadata row + one chunk per id, so the purge has rows to remove. */
  async function seed(sessionIds: string[]): Promise<void> {
    await store.setItems(sessionIds.map((id) => ({
      id, sourceType: 'session', title: id,
      projectPath: '/home/user/code/example', projectId: 'git:github.com/owner/example',
      filePath: '', mtime: 1000, contentPreview: id, extra: { tool: 'claude' },
    })));
    await store.addChunksFTS(sessionIds.map((id) => ({
      chunkId: `${id}:sync:0`, itemId: id, sourceType: 'session', title: id,
      text: `turn of ${id}`, chunkType: 'user',
      projectPath: '/home/user/code/example', projectId: 'git:github.com/owner/example',
      filePath: '', mtime: 1000,
    })));
  }

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: pgAdminUrl() });
    const { createStore } = await import('./index.js');
    store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: T } as any);
    for (const t of ['memory_chunks', 'memory_metadata', 'content_cache', 'session_metadata', 'session_tombstones']) {
      await sudo.query(`DELETE FROM ${t} WHERE tenant=$1`, [T]).catch(() => { /* table may not exist */ });
    }
  });

  afterAll(async () => {
    await sudo?.end().catch(() => { /* closing */ });
  });

  test('the count is flat from 1 tombstone to 50', async () => {
    const one = ids(1, 'a');
    const many = ids(50, 'b');
    await seed(one);
    await seed(many);

    const first = await counted(async () => {
      await store.purgeSessionsMany(one);
      await store.addTombstonesMany(one);
    });
    const fifty = await counted(async () => {
      await store.purgeSessionsMany(many);
      await store.addTombstonesMany(many);
    });

    // The assertion the defect was invisible to: 50× the work, the same number
    // of round trips. The per-session loop made this 13 vs 650.
    expect(fifty.statements).toBe(first.statements);
    // Measured at 21, and flat to 5,000 sessions. Asserted exactly so a new
    // per-row statement shows up as a failing test rather than as latency:
    // when a table joins the purge, update this number on purpose.
    expect(fifty.statements).toBe(21);
  });

  test('the rows are actually gone and the tombstones are recorded', async () => {
    const list = ids(3, 'c');
    await seed(list);

    const before = await sudo.query(
      `SELECT count(*)::int AS n FROM memory_metadata WHERE tenant=$1 AND id = ANY($2)`, [T, list]);
    expect(before.rows[0].n).toBe(3);

    await store.purgeSessionsMany(list);
    await store.addTombstonesMany(list);

    const meta = await sudo.query(
      `SELECT count(*)::int AS n FROM memory_metadata WHERE tenant=$1 AND id = ANY($2)`, [T, list]);
    const chunks = await sudo.query(
      `SELECT count(*)::int AS n FROM memory_chunks WHERE tenant=$1 AND item_id = ANY($2)`, [T, list]);
    const tombs = await sudo.query(
      `SELECT count(*)::int AS n FROM session_tombstones WHERE tenant=$1 AND session_id = ANY($2)`, [T, list]);

    expect(meta.rows[0].n).toBe(0);
    expect(chunks.rows[0].n).toBe(0);
    expect(tombs.rows[0].n).toBe(3);
  });

  test('the dead-set read is bounded by the payload, not by deletion history', async () => {
    // A tenant with a long deletion history. The ingest asks about three
    // sessions; it must not pay for the other 2,000.
    const history = ids(2000, 'hist');
    await store.addTombstonesMany(history);

    const asked = [history[7], 'e_live_1', 'e_live_2'];
    const { result, statements } = await counted(() => store.tombstonedAmong(asked));

    // Exactly the tombstoned one comes back, and the live ids do not.
    expect([...result]).toEqual([history[7]]);
    // One logical query, whatever the history holds.
    expect(statements).toBeLessThanOrEqual(5);

    // Doubling the history does not change the cost of the same question.
    await store.addTombstonesMany(ids(2000, 'hist2'));
    const again = await counted(() => store.tombstonedAmong(asked));
    expect(again.statements).toBe(statements);
    expect([...again.result]).toEqual([history[7]]);
  });

  test('a repeated tombstone is idempotent and an empty set writes nothing', async () => {
    const list = ids(2, 'd');
    await seed(list);
    await store.purgeSessionsMany(list);
    await store.addTombstonesMany(list);
    await store.addTombstonesMany(list);

    const tombs = await sudo.query(
      `SELECT count(*)::int AS n FROM session_tombstones WHERE tenant=$1 AND session_id = ANY($2)`, [T, list]);
    expect(tombs.rows[0].n).toBe(2);

    const empty = await counted(async () => {
      await store.purgeSessionsMany([]);
      await store.addTombstonesMany([]);
      await store.purgeSessionsMany(['', '']);
    });
    expect(empty.statements).toBe(0);
  });
});
