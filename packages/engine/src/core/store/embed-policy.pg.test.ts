/**
 * The pending-vectors query must read idx_chunks_pending_vector_v2.
 *
 * A partial index serves a query only when the query repeats its predicate.
 * The index text and the query text come from one file, and this test checks
 * that Postgres agrees: with sequential scans off, the plan of the worker
 * filter uses the index. If the two texts drift, the plan falls back to the
 * heap and the count goes back to reading every chunk.
 *
 * #10: the filter is `has_vector = false` (the write-through flag) rather than
 * a NOT EXISTS anti-join against memory_vectors, and the trivial-session test is
 * the row's own `trivial` flag rather than a per-chunk EXISTS against
 * memory_metadata — see pg-schema.ts, embed-policy.ts and vector.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { buildConcurrentIndexes, ensurePgSchema, closePgPools } from './pg-pool.js';
import { embedPolicy, embeddableChunkFlagSql } from './embed-policy.js';
import { pgAdminUrl, pgTestUrl } from '../../test-support/pg-urls.js';

const PG_URL = pgTestUrl();

(PG_URL ? describe : describe.skip)('idx_chunks_pending_vector_v2 (postgres)', () => {
  let admin: pg.Client;

  beforeAll(async () => {
    await ensurePgSchema(PG_URL!);
    admin = new pg.Client({ connectionString: pgAdminUrl() });
    await admin.connect();
    await buildConcurrentIndexes(admin);
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await closePgPools();
  });

  test('the v2 index exists and is valid', async () => {
    const r = await admin.query(
      `SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = 'idx_chunks_pending_vector_v2'`);
    expect(r.rows[0]?.indisvalid).toBe(true);
  });

  test('the worker filter plans through the v2 index', async () => {
    const sql = `EXPLAIN SELECT count(*) FROM memory_chunks c
      WHERE c.tenant = 'plan-test' AND c.text <> '' AND c.has_vector = false
        ${embeddableChunkFlagSql('c', embedPolicy({}))}`;
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL enable_seqscan = off');
      const plan = (await admin.query(sql)).rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain('idx_chunks_pending_vector_v2');
    } finally {
      await admin.query('ROLLBACK');
    }
  });
});
