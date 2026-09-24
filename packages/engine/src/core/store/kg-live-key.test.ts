/**
 * The live-key index must not break the writers that move a row's key.
 *
 * See docs/SYNC-BATCH-WRITES.md §2. The ingest upserts triples on their logical
 * key, which needs a unique index. A FULL index including `valid_to` is wrong:
 * `addTriple` and `invalidate` expire a row by setting `valid_to`, which moves
 * that row's key, and if an expired row already occupies the destination the
 * UPDATE raises a unique violation and fails the request. The index is therefore
 * partial on `valid_to IS NULL` — an expiring row leaves the index, so the move
 * is always free.
 *
 * Criterion 5 of the spec. The first test is the exact reproduction that ruled
 * out the full index; it must pass here and would fail against one.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createKnowledgeGraph } from './knowledge-graph.js';
import { pgAdminUrl } from '../../test-support/pg-urls.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const T = 'kg_live_key_team';

(PG_URL ? describe : describe.skip)('the live-key index', () => {
  let sudo: any; let kg: any;

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: pgAdminUrl() });
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

  const live = async (subject: string) => (await sudo.query(
    `SELECT e.name AS object FROM kg_triples t JOIN kg_entities e ON e.tenant=t.tenant AND e.id=t.object
      WHERE t.tenant=$1 AND t.subject=$2 AND t.valid_to IS NULL`, [T, subject])).rows.map((r: any) => r.object);

  test('THE REPRODUCTION: supersede onto a key an expired row already holds', async () => {
    // An expired fact arrives from a client, ending on d5.
    await kg.importTriples([{
      subject: 'x:auth', predicate: 'decided', object: 'BetterAuth',
      valid_from: '2026-01-01', valid_to: '2026-01-05',
    }]);
    // The same fact is asserted live, with the same start date.
    await kg.addTriple('x:auth', 'decided', 'BetterAuth', { validFrom: '2026-01-01', origin: 'asserted' } as never);
    // Superseding on exactly d5 moves the live row's key onto the expired one's.
    // A full unique index including valid_to raises 23505 here and fails the
    // whole request. The partial index does not.
    await expect(kg.addTriple('x:auth', 'decided', 'Keycloak', {
      validFrom: '2026-01-05', origin: 'asserted', supersede: true,
    } as never)).resolves.toBeDefined();

    expect(await live('x_auth')).toEqual(['Keycloak']);
  }, 30000);

  test('two live rows for one key are refused, which is the invariant it exists for', async () => {
    await kg.importTriples([{ subject: 'y:db', predicate: 'decided', object: 'Postgres', valid_from: '2026-02-01' }]);
    // Same subject, predicate, object and start date, still live: a duplicate.
    const again = kg.importTriples([{ subject: 'y:db', predicate: 'decided', object: 'Postgres', valid_from: '2026-02-01' }]);
    await expect(again).resolves.toEqual({ inserted: 0, exists: 1 });
    expect(await live('y_db')).toEqual(['Postgres']);
  }, 30000);

  test('the same fact in two different validity windows is two rows', async () => {
    await kg.importTriples([
      { subject: 'z:api', predicate: 'decided', object: 'Express', valid_from: '2026-03-01', valid_to: '2026-03-10' },
      { subject: 'z:api', predicate: 'decided', object: 'Express', valid_from: '2026-04-01' },
    ]);
    const n = (await sudo.query(`SELECT count(*)::int n FROM kg_triples WHERE tenant=$1 AND subject='z_api'`, [T])).rows[0].n;
    expect(n).toBe(2);
  }, 30000);

  test('invalidate moves a key onto an expired row without failing', async () => {
    await kg.importTriples([{
      subject: 'w:deploy', predicate: 'decided', object: 'k3s',
      valid_from: '2026-05-01', valid_to: '2026-05-09',
    }]);
    await kg.addTriple('w:deploy', 'decided', 'k3s', { validFrom: '2026-05-01', origin: 'asserted' } as never);
    await expect(kg.invalidate('w:deploy', 'decided', 'k3s', '2026-05-09')).resolves.toBeGreaterThan(0);
    expect(await live('w_deploy')).toEqual([]);
  }, 30000);
});
