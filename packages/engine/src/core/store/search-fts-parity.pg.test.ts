/**
 * #10: the bounded-candidate full-text search must return the same ranking as
 * the query it replaced.
 *
 * The old query computed ts_rank, the normalized window and the recency prior
 * over EVERY matching chunk and selected the body of all of them (8,969 ms mean
 * on production). The new one ranks a bounded candidate set first and joins the
 * bodies back in. As long as the match set is smaller than the cap (500), the
 * answer must be byte-identical: this test runs both SQL statements over the
 * same seeded corpus, for five stored queries, and compares the ordered items.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { MemoryChunk } from '../../types/memory.js';
import { pgAdminUrl } from '../../test-support/pg-urls.js';
import { andPrefixTsQuery, orPrefixTsQuery } from './pg.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const T = 'search_fts_parity';

// The query from before #10, verbatim except for the tenant/limit parameters.
const LEGACY_SQL = `
  SELECT chunk_id, item_id, source_type, chunk_type, mtime
    FROM (
      SELECT chunk_id, item_id, source_type, chunk_type, mtime,
             ts_rank(tsv, to_tsquery('english',$2), 1) AS rank
        FROM memory_chunks WHERE tenant=$1 AND tsv @@ to_tsquery('english',$2)
    ) s
   ORDER BY (rank / NULLIF(max(rank) OVER (), 0))
            * (CASE WHEN chunk_type LIKE 'subagent%' THEN 0.4
                    WHEN chunk_type LIKE 'tool_result%' OR chunk_type = 'harness' THEN 0.5
                    ELSE 1.0 END)
            + 0.15 * exp(-LEAST(GREATEST($3::double precision - COALESCE(mtime, 0), 0) / (14.0 * 86400000), 60))
            + 0.10 * (COALESCE(NULLIF(substring(chunk_type from 'imp([0-9])'), '')::int, 1) / 5.0) DESC,
            mtime DESC NULLS LAST
   LIMIT $4`;

const chunk = (i: number, text: string, type: string, mtime: number, item = 's1'): MemoryChunk => ({
  chunkId: `${item}_${i}`,
  itemId: item,
  sourceType: 'session',
  title: 'a session',
  text,
  chunkType: type,
  projectPath: '/home/user/code/example',
  projectId: 'git:github.com/owner/example',
  filePath: `/home/user/code/example/${item}.jsonl`,
  mtime,
} as MemoryChunk);

// A corpus with the shapes the ranking treats differently: primary turns, the
// demoted subagent/tool-result/harness types, and the importance-tagged types.
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const CORPUS: MemoryChunk[] = [
  chunk(0, 'we deployed postgres and the failover loop started', 'user', now - 7 * DAY, 's1'),
  chunk(1, 'the deploy hit a postgres timeout during failover', 'assistant', now - 6 * DAY, 's1'),
  chunk(2, 'failover loop postgres timeout diagnosis', 'subagent:explore', now - DAY, 's2'),
  chunk(3, 'tool output: postgres failover timeout trace', 'tool_result', now - DAY, 's2'),
  chunk(4, 'postgres failover decision imp5', 'user:imp5', now - 2 * DAY, 's3'),
  chunk(5, 'harness log postgres failover noise', 'harness', now - 3 * DAY, 's4'),
  chunk(6, 'search index and vector backlog for the corpus', 'user', now - 5 * DAY, 's5'),
  chunk(7, 'the search index is a tsvector, the backlog is vectors', 'assistant', now - 5 * DAY, 's5'),
  chunk(8, 'cache storage moved to object storage', 'user', now - 4 * DAY, 's6'),
  chunk(9, 'cache storage keeps a key and a hash in postgres', 'assistant:imp4', now - 4 * DAY, 's6'),
  chunk(10, 'failover of postgres moved the primary', 'user', now - 20 * DAY, 's7'),
  chunk(11, 'deploy notes for the search index rollout', 'assistant', now - 10 * DAY, 's8'),
];

const QUERIES = [
  'deploy failover',
  'postgres timeout',
  'search index',
  'vector backlog',
  'cache storage',
];

(PG_URL ? describe : describe.skip)('searchFTS bounded candidates (#10)', () => {
  let sudo: any; let store: any;

  /** Ordered (item) pairs the legacy query produces, grouped as searchFTS does. */
  async function legacy(q: string, topK: number): Promise<Array<{ itemId: string; sourceType: string }>> {
    const orTsq = orPrefixTsQuery(q);
    if (!orTsq) return [];
    const andTsq = andPrefixTsQuery(q);
    const run = async (tsq: string) =>
      (await sudo.query(LEGACY_SQL, [T, tsq, Date.now(), topK * 5])).rows as any[];
    let rows = andTsq ? await run(andTsq) : await run(orTsq);
    if (andTsq && andTsq !== orTsq && rows.length < 3) rows = await run(orTsq);
    const seen = new Set<string>();
    const out: Array<{ itemId: string; sourceType: string }> = [];
    for (const r of rows) {
      const key = `${r.source_type}:${r.item_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ itemId: r.item_id, sourceType: r.source_type });
      if (out.length >= topK) break;
    }
    return out;
  }

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: pgAdminUrl() });
    const { createStore } = await import('./index.js');
    store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: T } as any);
    await sudo.query(`DELETE FROM memory_chunks WHERE tenant=$1`, [T]);
    await store.addChunksFTS(CORPUS);
  }, 60000);

  afterAll(async () => {
    try { await sudo.query(`DELETE FROM memory_chunks WHERE tenant=$1`, [T]); } catch { /* best effort */ }
    await store?.close(); await sudo?.end();
  });

  for (const q of QUERIES) {
    test(`"${q}" ranks the same as before the candidate bound`, async () => {
      const topK = 10;
      const got = (await store.searchFTS(q, { topK })).map((r: any) => ({ itemId: r.itemId, sourceType: r.sourceType }));
      expect(got).toEqual(await legacy(q, topK));
      expect(got.length).toBeGreaterThan(0);
    }, 30000);
  }
});
