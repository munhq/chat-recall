/**
 * A decision must be readable by the whole team. Proven against real RLS.
 *
 * The register exists so nobody has to ask a teammate what was settled. Under
 * the old policy a decision was shared only through its source session, so one
 * recorded in the dashboard — which has no session — stayed private to whoever
 * typed it. Two people on one team then got different answers from one
 * register, and neither was told. Measured on the production graph: 5 of 21
 * live decisions were readable by their author alone.
 *
 * So `decided` / `because` / `rejected` / `chosen_over` are tenant-wide, and
 * author_sub became a byline. Everything else the graph holds keeps the author
 * gate, which is what the last test here guards: an ad-hoc fact recorded with
 * recall_kg_add is still nobody else's business.
 *
 * Runs as a NOBYPASSRLS role. Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { pgAdminUrl } from '../../test-support/pg-urls.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const RLS_ROLE = 'cr_decision_test';
const RLS_PASS = 'decisionpass';
const T = 'decision_team';
const ALICE = 'user-alice';
const BOB = 'user-bob';

(PG_URL ? describe : describe.skip)('a decision is visible to the whole team', () => {
  let sudo: any; let app: any;

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: pgAdminUrl() });
    const { createStore } = await import('./index.js');
    const s = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: 'seed' } as any);
    await s.close();
    await sudo.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${RLS_ROLE}') THEN CREATE ROLE ${RLS_ROLE} LOGIN PASSWORD '${RLS_PASS}' NOBYPASSRLS; END IF; END $$;`);
    await sudo.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await sudo.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_ROLE}`);
    await sudo.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RLS_ROLE}`);
    for (const tbl of ['memory_metadata', 'kg_entities', 'kg_triples']) {
      await sudo.query(`DELETE FROM ${tbl} WHERE tenant=$1`, [T]);
    }

    const u = new URL(PG_URL!); u.username = RLS_ROLE; u.password = RLS_PASS;
    app = new pg.Pool({ connectionString: u.toString() });

    // Alice records three things, all with NO session — the dashboard write
    // path, which is exactly the shape that used to go private.
    await asViewer(ALICE, async (c) => {
      await c.query(`INSERT INTO kg_entities (tenant,id,name) VALUES
        ('${T}','_auth','*:auth'), ('${T}','betterauth','BetterAuth'),
        ('${T}','keycloak','Keycloak'), ('${T}','because_it_bills_per_seat','it bills per seat'),
        ('${T}','alices_laptop','alices laptop'), ('${T}','a_private_note','a private note')`);
      await c.query(`INSERT INTO kg_triples (tenant,id,subject,predicate,object,author_sub) VALUES
        ('${T}','d1','_auth','decided','betterauth','${ALICE}'),
        ('${T}','w1','_auth','because','because_it_bills_per_seat','${ALICE}'),
        ('${T}','r1','_auth','rejected','keycloak','${ALICE}'),
        ('${T}','n1','alices_laptop','has_note','a_private_note','${ALICE}')`);
    });
  }, 30000);

  afterAll(async () => {
    try {
      for (const tbl of ['memory_metadata', 'kg_entities', 'kg_triples']) {
        await sudo.query(`DELETE FROM ${tbl} WHERE tenant=$1`, [T]);
      }
    } catch { /* best effort */ }
    await app?.end(); await sudo?.end();
  });

  async function asViewer(viewer: string, fn: (c: any) => Promise<any>): Promise<any> {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant', $1, true)", [T]);
      await c.query("SELECT set_config('app.viewer', $1, true)", [viewer]);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  const count = (v: string, pred: string) => asViewer(v, (c) => c
    .query(`SELECT count(*)::int n FROM kg_triples WHERE tenant='${T}' AND predicate=$1`, [pred])
    .then((r: any) => r.rows[0].n));

  test('THE FAILURE: a teammate can now read a decision recorded with no session', async () => {
    expect(await count(BOB, 'decided')).toBe(1);
  });

  test('the reason travels with it, or the teammate sees a rule with no argument', async () => {
    expect(await count(BOB, 'because')).toBe(1);
  });

  test('what was rejected is team-wide too — the guard warns on it', async () => {
    // /api/decisions/check reads `rejected` and `chosen_over` to warn before an
    // agent reintroduces something the team already ruled out. Gated on the
    // author, that warning only ever reached the person who wrote it.
    expect(await count(BOB, 'rejected')).toBe(1);
  });

  test('everything else the graph holds STAYS private to its author', async () => {
    // The widening is four predicates, not the table. An ad-hoc fact recorded
    // with recall_kg_add and no session is still nobody else's business.
    expect(await count(ALICE, 'has_note')).toBe(1);
    expect(await count(BOB, 'has_note')).toBe(0);
  });

  test('the author still sees their own, and the worker sees all', async () => {
    expect(await count(ALICE, 'decided')).toBe(1);
    expect(await count('*', 'decided')).toBe(1);
  });

  test('a teammate cannot rewrite the decision they can now read', async () => {
    // Visibility is not authorship. The author-write guard is untouched, so a
    // decision cannot be edited out from under the person who recorded it.
    await expect(asViewer(BOB, (c) => c.query(
      `UPDATE kg_triples SET object='keycloak' WHERE tenant='${T}' AND id='d1'`,
    ).then((r: any) => { if (r.rowCount === 0) throw new Error('no rows updated'); return r; })))
      .rejects.toThrow();
  });
});
