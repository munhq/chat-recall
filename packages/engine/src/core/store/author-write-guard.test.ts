/**
 * Proves the author-safe write RLS guard: within a team (=tenant), a NAMED
 * member (app.viewer = their Keycloak sub) can only write rows they author.
 * A member can NEVER overwrite, flip the attribution of, or delete another
 * member's row. Legacy NULL-author rows may be claimed. Worker/CLI ('*') and
 * self-host ('') are unrestricted.
 *
 * This is the guard that makes the attribution-flip corruption class
 * structurally impossible. Runs as a NOBYPASSRLS role (a superuser silently
 * bypasses RLS). Gated on DATABASE_URL (a superuser DSN, used to mint the role).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const RLS_ROLE = 'cr_wguard_test';
const RLS_PASS = 'wguardpass';
const T = 'wguard_team';
const ALICE = 'user-alice';
const BOB = 'user-bob';

(PG_URL ? describe : describe.skip)('author-safe writes (RLS write-guard)', () => {
  let sudo: any;
  let app: any;

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: PG_URL });
    // Build the engine schema (tables + RLS incl. the write-guard) once.
    const { createStore } = await import('./index.js');
    const s = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: 'seed' } as any);
    await s.close();
    // Restricted, RLS-subject role (a superuser would bypass the guard).
    await sudo.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${RLS_ROLE}') THEN CREATE ROLE ${RLS_ROLE} LOGIN PASSWORD '${RLS_PASS}' NOBYPASSRLS; END IF; END $$;`);
    await sudo.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await sudo.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_ROLE}`);
    await sudo.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RLS_ROLE}`);
    for (const tbl of ['memory_metadata', 'session_metadata', 'code_projects']) {
      await sudo.query(`DELETE FROM ${tbl} WHERE tenant=$1`, [T]);
    }
    const u = new URL(PG_URL!); u.username = RLS_ROLE; u.password = RLS_PASS;
    app = new pg.Pool({ connectionString: u.toString() });
  }, 30000);

  afterAll(async () => {
    try {
      for (const tbl of ['memory_metadata', 'session_metadata', 'code_projects']) await sudo.query(`DELETE FROM ${tbl} WHERE tenant=$1`, [T]);
    } catch { /* best effort */ }
    await app?.end(); await sudo?.end();
  });

  /** Run fn in a txn scoped to (tenant=T, viewer). */
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

  /** The real ingest upsert shape (reverse-COALESCE: existing author preserved). */
  const upsert = (id: string, author: string | null, title: string) =>
    `INSERT INTO memory_metadata (tenant,id,source_type,title,project_id,indexed_at,author_sub)
     VALUES ('${T}','${id}','session','${title}','git:h/o/r',1, ${author ? `'${author}'` : 'NULL'})
     ON CONFLICT (tenant,id,source_type) DO UPDATE SET title=excluded.title,
       author_sub=COALESCE(memory_metadata.author_sub, excluded.author_sub)`;

  const readRow = (id: string) =>
    asViewer('*', (c) => c.query(`SELECT title, author_sub FROM memory_metadata WHERE tenant='${T}' AND id='${id}'`).then((r: any) => r.rows[0]));

  test('a member can create and update their OWN row', async () => {
    await asViewer(ALICE, (c) => c.query(upsert('s1', ALICE, 'alice v1')));
    await asViewer(ALICE, (c) => c.query(upsert('s1', ALICE, 'alice v2')));
    expect(await readRow('s1')).toMatchObject({ title: 'alice v2', author_sub: ALICE });
  });

  test('a DIFFERENT member cannot overwrite or flip another member\'s row', async () => {
    // Blocked by RLS (throws) — but assert the invariant regardless of throw vs skip.
    await asViewer(BOB, (c) => c.query(upsert('s1', BOB, 'bob hijack'))).catch(() => {});
    expect(await readRow('s1')).toMatchObject({ title: 'alice v2', author_sub: ALICE });
  });

  test('a DIFFERENT member cannot delete another member\'s row', async () => {
    const del = await asViewer(BOB, (c) => c.query(`DELETE FROM memory_metadata WHERE tenant='${T}' AND id='s1'`));
    expect(del.rowCount).toBe(0);          // RLS USING hides it → nothing deleted
    expect(await readRow('s1')).toMatchObject({ author_sub: ALICE }); // still there
  });

  test('a member CAN claim a legacy NULL-author row', async () => {
    await asViewer('*', (c) => c.query(upsert('s2', null, 'legacy')));       // worker writes null-author
    await asViewer(ALICE, (c) => c.query(upsert('s2', ALICE, 'claimed')));   // alice claims it
    expect(await readRow('s2')).toMatchObject({ author_sub: ALICE });
  });

  test('the unrestricted context (worker/CLI) can write anything', async () => {
    await asViewer('*', (c) => c.query(upsert('s1', BOB, 'worker edit')));   // no RLS restriction
    // reverse-COALESCE keeps the original author even for a worker write
    expect(await readRow('s1')).toMatchObject({ title: 'worker edit', author_sub: ALICE });
  });

  // ── session_metadata: this table is in the write-guard AND has an author_sub
  // column, but its write path (caches.ts set/setUserTitle/setToolTitle) shipped
  // without stamping author_sub — so a named member's own summary sync was
  // fail-closed by author_write_insert in prod. These lock the contract: the
  // guard requires attribution, and the code must supply it.
  //
  // session_metadata's author_visibility (SELECT) inherits from the parent
  // memory_metadata SESSION row, and ON CONFLICT DO UPDATE evaluates that SELECT
  // policy — so, exactly as in prod, the parent session must exist first. Seed it
  // via the superuser pool (bypasses RLS) so each test isolates the write-guard.
  const smUpsert = (id: string, author: string | null) =>
    `INSERT INTO session_metadata (tenant,session_id,first_prompt,summary,summary_source,mtime,indexed_at,author_sub)
     VALUES ('${T}','${id}','p','s','original',1,1, ${author ? `'${author}'` : 'NULL'})
     ON CONFLICT (tenant,session_id) DO UPDATE SET summary=excluded.summary,
       author_sub=COALESCE(session_metadata.author_sub, excluded.author_sub)`;
  const readSm = (id: string) =>
    asViewer('*', (c) => c.query(`SELECT author_sub FROM session_metadata WHERE tenant='${T}' AND session_id='${id}'`).then((r: any) => r.rows[0]));
  // Seed a parent session row (owned by `owner`) so the child's SELECT-inherited
  // visibility passes for that owner.
  const seedSession = (id: string, owner: string) =>
    sudo.query(`INSERT INTO memory_metadata (tenant,id,source_type,title,project_id,indexed_at,author_sub)
      VALUES ('${T}','${id}','session','s','git:h/o/r',1,'${owner}') ON CONFLICT DO NOTHING`);

  test('session_metadata: a member can write their OWN (attributed) summary row', async () => {
    await seedSession('sm1', ALICE);
    await asViewer(ALICE, (c) => c.query(smUpsert('sm1', ALICE)));
    expect(await readSm('sm1')).toMatchObject({ author_sub: ALICE });
  });

  test('session_metadata: an UNattributed write by a named member is rejected (the prod regression)', async () => {
    // Exactly what broke prod: NULL author_sub under a named viewer → author_sub =
    // app.viewer is NULL (not true) → RESTRICTIVE fail-closed. The fix is that the
    // code now stamps author_sub; this proves the policy still demands it. The
    // parent session is ALICE's (visible to her) so the ONLY thing that can reject
    // is author_write_insert.
    await seedSession('sm2', ALICE);
    await expect(asViewer(ALICE, (c) => c.query(smUpsert('sm2', null)))).rejects.toThrow();
  });

  test('session_metadata: a member CANNOT write a row attributed to someone else', async () => {
    // BOB owns the parent session (so visibility passes for him), but tries to
    // attribute the summary row to ALICE → author_write_insert fail-closed.
    await seedSession('sm3', BOB);
    await expect(asViewer(BOB, (c) => c.query(smUpsert('sm3', ALICE)))).rejects.toThrow();
  });

  // ── code intel is project-scoped SHARED data — the author-write-guard was
  // removed from code_* (PK is tenant,project_id: one row per project, any
  // member may (re-)index it). With the guard present, a second member's ON
  // CONFLICT upsert hit the first indexer's author_sub and fail-closed.
  // code_* author_visibility inherits from ANY memory_metadata row in the
  // project; seed a legacy (NULL-author) session so the project is visible to
  // every member (mirrors a shared/legacy project both teammates can index).
  const cpUpsert = (author: string | null) =>
    `INSERT INTO code_projects (tenant,project_id,created_at,updated_at,author_sub)
     VALUES ('${T}','git:h/o/shared',1,1, ${author ? `'${author}'` : 'NULL'})
     ON CONFLICT (tenant,project_id) DO UPDATE SET updated_at=code_projects.updated_at+1`;

  test('code_*: a second member can re-index a shared project (guard removed)', async () => {
    await sudo.query(`INSERT INTO memory_metadata (tenant,id,source_type,title,project_id,indexed_at,author_sub)
      VALUES ('${T}','cp-sess','session','s','git:h/o/shared',1,NULL) ON CONFLICT DO NOTHING`);
    await asViewer(ALICE, (c) => c.query(cpUpsert(ALICE)));       // alice indexes first
    const r = await asViewer(BOB, (c) => c.query(cpUpsert(BOB))); // bob re-indexes SAME row
    expect(r.rowCount).toBe(1);                                    // not blocked
  });
});
