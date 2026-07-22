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
    await sudo.query(`DELETE FROM memory_metadata WHERE tenant=$1`, [T]);
    const u = new URL(PG_URL!); u.username = RLS_ROLE; u.password = RLS_PASS;
    app = new pg.Pool({ connectionString: u.toString() });
  }, 30000);

  afterAll(async () => {
    try { await sudo.query(`DELETE FROM memory_metadata WHERE tenant=$1`, [T]); } catch { /* best effort */ }
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
});
