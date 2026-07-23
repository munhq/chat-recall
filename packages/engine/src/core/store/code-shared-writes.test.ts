/**
 * Proves PROJECT-scoped shared writes (code_*) succeed for a NAMED member even
 * when they have NO visible session in the project — the codeindex ingest must
 * not fail-close on the author_visibility SELECT gate (which gates READS only).
 *
 * This drives the REAL engine store bound to a NOBYPASSRLS role, so it exercises
 * runUnrestricted()'s async-context propagation end to end (authorAls.exit must
 * still be in effect when the pool sets app.viewer inside the awaited query).
 * A superuser would bypass RLS and hide the bug, so a restricted role is required.
 * Gated on DATABASE_URL (a superuser DSN, used to mint the role + seed).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runWithAuthor } from './tenant-context.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const RLS_ROLE = 'cr_codeshare_test';
const RLS_PASS = 'codesharepass';
const T = 'codeshare_team';
const BOB = 'user-bob';
const PROJ = 'git:h/o/shared-repo';

(PG_URL ? describe : describe.skip)('code_* shared writes: unrestricted ingest, gated reads', () => {
  let sudo: any;
  let store: any;

  const clean = async () => {
    for (const tbl of ['code_projects', 'code_findings', 'code_hotspots', 'code_actions', 'memory_links', 'memory_metadata']) {
      await sudo.query(`DELETE FROM ${tbl} WHERE tenant=$1`, [T]);
    }
  };

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: PG_URL });
    const { createStore } = await import('./index.js');
    // Build schema once (as the superuser DSN), then close.
    const seed = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: 'seed' } as any);
    await seed.close();
    await sudo.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${RLS_ROLE}') THEN CREATE ROLE ${RLS_ROLE} LOGIN PASSWORD '${RLS_PASS}' NOBYPASSRLS; END IF; END $$;`);
    // Member of the owner role so the store's idempotent ensurePgSchema (ALTER
    // TABLE ...) is permitted; membership does NOT transfer the owner's BYPASSRLS
    // attribute, so RLS still applies (the gated-read test below is the guard).
    const owner = (await sudo.query('SELECT current_user AS u')).rows[0].u;
    await sudo.query(`GRANT ${owner} TO ${RLS_ROLE}`);
    await sudo.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await sudo.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_ROLE}`);
    await sudo.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RLS_ROLE}`);
    await clean();
    // A pre-existing shared project row (indexed earlier by "someone else"),
    // NOT visible to BOB: there is no memory_metadata session in PROJ for him,
    // so author_visibility hides it. This is the exact prod trigger.
    await sudo.query(`INSERT INTO code_projects (tenant,project_id,root_path,created_at,updated_at) VALUES ($1,$2,'/x',1,1)`, [T, PROJ]);
    const u = new URL(PG_URL!); u.username = RLS_ROLE; u.password = RLS_PASS;
    store = await createStore({ backend: 'postgres', databaseUrl: u.toString(), tenant: T } as any);
  }, 30000);

  afterAll(async () => {
    try { await clean(); } catch { /* best effort */ }
    await store?.close();
    await sudo?.end();
  });

  test('a member re-indexes a project they CANNOT see — the full ingest succeeds', async () => {
    // Without runUnrestricted, the ON CONFLICT upsert conflict-checks the existing
    // (invisible) row against author_visibility and throws 42501. The store methods
    // elevate the WRITE, so this must resolve.
    await expect(runWithAuthor({ sub: BOB, device: 'd' }, async () => {
      await store.upsertCodeProject({
        projectId: PROJ, rootPath: '/x', fileCount: 2, symbolCount: 3,
        langs: {}, health: {}, map: {}, lastIndexedAt: 2, collectorVersion: 1,
      });
      await store.replaceCodeFindings(PROJ, [{ category: 'bug', severity: 'high', file: 'a.ts', rule: 'r', title: 't' }]);
      await store.replaceCodeHotspots(PROJ, [{ file: 'a.ts', churn: 1, complexity: 1, score: 1, aiAuthored: false, lines: 10 }]);
      await store.upsertCodeActions(PROJ, [{ pri: 1, category: 'fix', title: 't', fix: 'f', agentPrompt: 'p', loc: [] }]);
    })).resolves.toBeUndefined();

    // The writes actually landed (read back with the superuser pool).
    expect((await sudo.query(`SELECT file_count FROM code_projects WHERE tenant=$1 AND project_id=$2`, [T, PROJ])).rows[0].file_count).toBe(2);
    expect((await sudo.query(`SELECT count(*)::int n FROM code_findings WHERE tenant=$1 AND project_id=$2`, [T, PROJ])).rows[0].n).toBe(1);
    expect((await sudo.query(`SELECT count(*)::int n FROM code_actions WHERE tenant=$1 AND project_id=$2`, [T, PROJ])).rows[0].n).toBe(1);
  });

  test('reads stay GATED: BOB still cannot see code_* for a project with no visible session', async () => {
    // listCodeFindings is NOT elevated — it runs under BOB's viewer, so
    // author_visibility hides a project he has no session in. Elevating writes
    // does not open reads.
    const findings = await runWithAuthor({ sub: BOB, device: 'd' }, () => store.listCodeFindings(PROJ));
    expect(findings.length).toBe(0);
  });

  test('memory_links: a member can write a link whose TARGET endpoint is invisible', async () => {
    // Two-endpoint ON CONFLICT upsert. Source is BOB's own session (visible);
    // target 'ghostplan' has no memory_metadata row (invisible). Without the
    // unrestricted write, the conflict-check fail-closes on author_visibility
    // (a link is visible only when BOTH endpoints are). addLinks must succeed.
    await sudo.query(
      `INSERT INTO memory_metadata (tenant,id,source_type,title,project_id,indexed_at,author_sub) VALUES ($1,'bobsess','session','s','p',1,$2) ON CONFLICT DO NOTHING`,
      [T, BOB],
    );
    await expect(runWithAuthor({ sub: BOB, device: 'd' }, () =>
      store.addLinks([{ sourceType: 'session', sourceId: 'bobsess', targetType: 'plan', targetId: 'ghostplan', linkType: 'relates', confidence: 1 }]),
    )).resolves.toBeUndefined();
    expect((await sudo.query(`SELECT count(*)::int n FROM memory_links WHERE tenant=$1 AND source_id='bobsess'`, [T])).rows[0].n).toBe(1);
  });
});
