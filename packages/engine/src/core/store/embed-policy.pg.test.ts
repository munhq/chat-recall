/**
 * The pending-vectors query must read idx_chunks_embeddable.
 *
 * A partial index serves a query only when the query repeats its predicate.
 * The index text and the query text come from one file, and this test checks
 * that Postgres agrees: with sequential scans off, the plan of the worker
 * filter uses the index. If the two texts drift, the plan falls back to the
 * heap and the count goes back to reading every chunk.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { buildConcurrentIndexes, ensurePgSchema, closePgPools } from './pg-pool.js';
import { embedPolicy, embeddableChunkSql } from './embed-policy.js';
import { pgAdminUrl, pgTestUrl } from '../../test-support/pg-urls.js';

const PG_URL = pgTestUrl();

(PG_URL ? describe : describe.skip)('idx_chunks_embeddable (postgres)', () => {
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

  test('the index exists and is valid', async () => {
    const r = await admin.query(
      `SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = 'idx_chunks_embeddable'`);
    expect(r.rows[0]?.indisvalid).toBe(true);
  });

  test('the worker filter plans through the index', async () => {
    const sql = `EXPLAIN SELECT count(*) FROM memory_chunks c
      WHERE c.tenant = 'plan-test' AND c.text <> ''
        AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.tenant = c.tenant AND v.chunk_id = c.chunk_id)
        ${embeddableChunkSql('c', embedPolicy({}), '4', '2000')}`;
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL enable_seqscan = off');
      const plan = (await admin.query(sql)).rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain('idx_chunks_embeddable');
    } finally {
      await admin.query('ROLLBACK');
    }
  });
});
