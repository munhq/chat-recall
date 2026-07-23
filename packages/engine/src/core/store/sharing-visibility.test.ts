/**
 * Proves per-project sharing visibility for the two tables that previously
 * leaked across team members: memory_links (relationship edges) and kg_entities
 * (KG nodes). A teammate must NOT see an owner's link/entity for unshared work,
 * and MUST see it once the owner shares the project.
 *
 * Runs as a NOBYPASSRLS role. Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const RLS_ROLE = 'cr_share_test';
const RLS_PASS = 'sharepass';
const T = 'share_team';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const PROJ = 'git:h/o/secret';

(PG_URL ? describe : describe.skip)('per-project sharing visibility (links + kg_entities)', () => {
  let sudo: any; let app: any;

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: PG_URL });
    const { createStore } = await import('./index.js');
    const s = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: 'seed' } as any);
    await s.close();
    await sudo.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${RLS_ROLE}') THEN CREATE ROLE ${RLS_ROLE} LOGIN PASSWORD '${RLS_PASS}' NOBYPASSRLS; END IF; END $$;`);
    await sudo.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await sudo.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_ROLE}`);
    await sudo.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RLS_ROLE}`);
    // clean slate
    for (const tbl of ['memory_metadata','memory_links','kg_entities','kg_triples']) {
      await sudo.query(`DELETE FROM ${tbl} WHERE tenant=$1`, [T]);
    }
    await sudo.query(`DELETE FROM team_project_shares WHERE team_slug=$1`, [T]);

    const u = new URL(PG_URL!); u.username = RLS_ROLE; u.password = RLS_PASS;
    app = new pg.Pool({ connectionString: u.toString() });

    // Seed alice's graph: a session + a plan (same project), a link between them,
    // and a KG entity referenced by a triple sourced from her session.
    await asViewer(ALICE, async (c) => {
      await c.query(`INSERT INTO memory_metadata (tenant,id,source_type,title,project_id,indexed_at,author_sub) VALUES
        ('${T}','sess1','session','s','${PROJ}',1,'${ALICE}'),
        ('${T}','plan1','plan','p','${PROJ}',1,'${ALICE}')`);
      await c.query(`INSERT INTO memory_links (tenant,source_type,source_id,target_type,target_id,link_type,created_at)
        VALUES ('${T}','session','sess1','plan','plan1','relates',1)`);
      await c.query(`INSERT INTO kg_entities (tenant,id,name,type) VALUES ('${T}','ent1','Postgres','tool')`);
      await c.query(`INSERT INTO kg_triples (tenant,id,subject,predicate,object,source_session,author_sub)
        VALUES ('${T}','tri1','Postgres','used_by','chat-recall','sess1','${ALICE}')`);
    });
  }, 30000);

  afterAll(async () => {
    try {
      for (const tbl of ['memory_metadata','memory_links','kg_entities','kg_triples']) await sudo.query(`DELETE FROM ${tbl} WHERE tenant=$1`, [T]);
      await sudo.query(`DELETE FROM team_project_shares WHERE team_slug=$1`, [T]);
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

  const countLinks = (v: string) => asViewer(v, (c) => c.query(`SELECT count(*)::int n FROM memory_links WHERE tenant='${T}'`).then((r: any) => r.rows[0].n));
  const countEntities = (v: string) => asViewer(v, (c) => c.query(`SELECT count(*)::int n FROM kg_entities WHERE tenant='${T}'`).then((r: any) => r.rows[0].n));
  const countTriples = (v: string) => asViewer(v, (c) => c.query(`SELECT count(*)::int n FROM kg_triples WHERE tenant='${T}'`).then((r: any) => r.rows[0].n));

  test('owner sees her own link + fact; worker sees all', async () => {
    expect(await countLinks(ALICE)).toBe(1);
    expect(await countTriples(ALICE)).toBe(1);
    expect(await countLinks('*')).toBe(1);
    expect(await countTriples('*')).toBe(1);
  });

  test('a teammate CANNOT see the LINK or the FACT of unshared work — but entity names are shared vocabulary', async () => {
    // The sensitive layer stays gated: BOB sees neither the relationship edge
    // (memory_links) nor the fact (kg_triples: who-asserted-what).
    expect(await countLinks(BOB)).toBe(0);
    expect(await countTriples(BOB)).toBe(0);
    // kg_entities has NO per-member gate (shared vocabulary — see pg-schema): a
    // RESTRICTIVE gate there fail-closed every member's entity-extraction upsert.
    // Only bare entity NAMES are visible team-wide; the facts above stay hidden.
    expect(await countEntities(BOB)).toBe(1);
  });

  test('after the owner shares the project, the teammate CAN see the link + fact', async () => {
    await sudo.query(
      `INSERT INTO team_project_shares (team_slug, owner_sub, project_id, scope, shared_at) VALUES ($1,$2,$3,'full',1)`,
      [T, ALICE, PROJ],
    );
    expect(await countLinks(BOB)).toBe(1);
    expect(await countTriples(BOB)).toBe(1);
  });

  test('a member can upsert a SHARED entity created by the worker (kg_entities has no per-member gate)', async () => {
    // The prod regression: entity extraction upserts kg_entities on EVERY member
    // sync. With a RESTRICTIVE author_visibility gate on kg_entities, a named
    // member re-adding a worker/legacy entity they could not see fail-closed the
    // whole sync — because ON CONFLICT (DO UPDATE and DO NOTHING alike)
    // conflict-checks the existing row against the SELECT policy. The gate is
    // removed for kg_entities, so this upsert must succeed for BOB.
    await asViewer('*', (c) => c.query(
      `INSERT INTO kg_entities (tenant,id,name,type) VALUES ('${T}','ent-worker','WorkerTool','tool') ON CONFLICT (tenant,id) DO NOTHING`));
    await expect(asViewer(BOB, (c) => c.query(
      `INSERT INTO kg_entities (tenant,id,name,type,properties) VALUES ('${T}','ent-worker','WorkerTool','tool','{}')
       ON CONFLICT (tenant,id) DO UPDATE SET type=excluded.type`))).resolves.toBeDefined();
  });
});
