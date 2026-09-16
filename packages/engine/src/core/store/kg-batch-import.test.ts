/**
 * One user's sync must not issue one query per row.
 *
 * `importTriple` costs four sequential round trips — two entity upserts, a
 * lookup, an insert — and the sync route called it once per triple. A sync
 * carrying 5905 triples therefore issued about 23600 queries in sequence, each
 * one a hop to the pooler while holding a pooled connection. With PG_POOL_MAX
 * at 20 per process and the deployment scaling to six pods, that asks a pooler
 * sized for 20 server connections to serve 120, and the requests behind it wait
 * until PgBouncer's 120s ceiling ends them. A 124997 ms ingest request is that
 * ceiling, not that much work.
 *
 * These assert the batch does the same thing in three queries per chunk:
 * the same rows land, a re-import inserts nothing, and the counts are right.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createKnowledgeGraph } from './knowledge-graph.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const T = 'kg_batch_team';

const triple = (n: number) => ({
  subject: `subject-${n}`, predicate: 'uses', object: `tool-${n % 7}`,
  valid_from: '2026-01-01', confidence: 1, source_session: `sess-${n % 3}`,
});

(PG_URL ? describe : describe.skip)('importTriples', () => {
  let sudo: any; let kg: any;

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: PG_URL });
    const { createStore } = await import('./index.js');
    const s = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: T } as any);
    await s.close();
    for (const tbl of ['kg_triples', 'kg_entities']) await sudo.query(`DELETE FROM ${tbl} WHERE tenant=$1`, [T]);
    kg = await createKnowledgeGraph({ backend: 'postgres', databaseUrl: PG_URL, tenant: T } as any);
  }, 40000);

  afterAll(async () => {
    try { for (const tbl of ['kg_triples', 'kg_entities']) await sudo.query(`DELETE FROM ${tbl} WHERE tenant=$1`, [T]); } catch { /* best effort */ }
    await kg?.close(); await sudo?.end();
  });

  test('THE POINT: a batch bigger than one chunk lands, every row', async () => {
    // 1200 crosses the 500-row chunk boundary twice, so chunking is exercised.
    const r = await kg.importTriples(Array.from({ length: 1200 }, (_, i) => triple(i)));
    expect(r.inserted).toBe(1200);
    expect(r.exists).toBe(0);
    const n = (await sudo.query(`SELECT count(*)::int n FROM kg_triples WHERE tenant=$1`, [T])).rows[0].n;
    expect(n).toBe(1200);
  }, 60000);

  test('the entities came with them, deduplicated', async () => {
    // 1200 subjects + 7 distinct objects, and each object repeats ~171 times.
    const n = (await sudo.query(`SELECT count(*)::int n FROM kg_entities WHERE tenant=$1`, [T])).rows[0].n;
    expect(n).toBe(1207);
  });

  test('a re-import inserts nothing — a re-sync must not duplicate', async () => {
    const r = await kg.importTriples(Array.from({ length: 1200 }, (_, i) => triple(i)));
    expect(r.inserted).toBe(0);
    expect(r.exists).toBe(1200);
    const n = (await sudo.query(`SELECT count(*)::int n FROM kg_triples WHERE tenant=$1`, [T])).rows[0].n;
    expect(n).toBe(1200);
  }, 60000);

  test('a mixed batch inserts only what is new', async () => {
    const mixed = [...Array.from({ length: 5 }, (_, i) => triple(i)), triple(9001), triple(9002)];
    const r = await kg.importTriples(mixed);
    expect(r.inserted).toBe(2);
    expect(r.exists).toBe(5);
  });

  test('a different validity window is a different fact, as importTriple treats it', async () => {
    const r = await kg.importTriples([{ ...triple(0), valid_from: '2026-06-01' }]);
    expect(r.inserted).toBe(1);
  });

  test('an empty batch is not an error', async () => {
    expect(await kg.importTriples([])).toEqual({ inserted: 0, exists: 0 });
  });
});
