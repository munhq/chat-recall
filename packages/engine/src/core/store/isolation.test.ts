/**
 * Proves Postgres Row-Level-Security actually isolates tenants — the security
 * guarantee behind the shared-cloud SKU. Critically, this runs as a
 * NOBYPASSRLS role: a superuser (which the parity suite uses) silently bypasses
 * RLS, so app-level `WHERE tenant=$1` would mask a broken policy. Here there is
 * NO tenant WHERE clause — isolation must come from RLS alone.
 *
 * Gated on DATABASE_URL (a superuser DSN, used to create the restricted role).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const RLS_ROLE = 'cr_rls_test';
const RLS_PASS = 'rlspass';

(PG_URL ? describe : describe.skip)('Postgres RLS tenant isolation (restricted role)', () => {
  let sudo: any;
  let app: any;

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: PG_URL });
    // Create the engine tables (+ RLS policies) by opening a store once.
    const { createStore } = await import('./index.js');
    const s = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: 'seed' } as any);
    await s.close();
    // Restricted, RLS-subject role with table access.
    await sudo.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${RLS_ROLE}') THEN CREATE ROLE ${RLS_ROLE} LOGIN PASSWORD '${RLS_PASS}' NOBYPASSRLS; END IF; END $$;`);
    await sudo.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await sudo.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_ROLE}`);
    await sudo.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RLS_ROLE}`);
    const u = new URL(PG_URL!);
    u.username = RLS_ROLE;
    u.password = RLS_PASS;
    app = new pg.Pool({ connectionString: u.toString() });
  }, 30000);

  afterAll(async () => { await app?.end(); await sudo?.end(); });

  async function asTenant(tenant: string | null, fn: (c: any) => Promise<any>): Promise<any> {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      if (tenant !== null) await c.query("SELECT set_config('app.tenant', $1, true)", [tenant]);
      // The pool always sets app.viewer too (setScopeGucs); '*' is the no-author
      // / worker context these raw inserts represent. Without it the author-safe
      // write-guard (RESTRICTIVE) correctly blocks the un-attributed INSERT.
      await c.query("SELECT set_config('app.viewer', $1, true)", ['*']);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  const ins = (t: string, id: string, title: string) =>
    `INSERT INTO memory_metadata (tenant,id,source_type,title,indexed_at) VALUES ('${t}','${id}','plan','${title}',1) ON CONFLICT DO NOTHING`;

  test('tenant sees only its own rows (no WHERE clause — pure RLS)', async () => {
    await asTenant('teamA', (c) => c.query(ins('teamA', 'x1', 'A')));
    await asTenant('teamB', (c) => c.query(ins('teamB', 'x1', 'B')));

    const aRows = await asTenant('teamA', (c) => c.query('SELECT tenant FROM memory_metadata').then((r: any) => r.rows));
    expect(aRows.length).toBeGreaterThanOrEqual(1);
    expect(aRows.every((r: any) => r.tenant === 'teamA')).toBe(true);

    const bRows = await asTenant('teamB', (c) => c.query('SELECT tenant FROM memory_metadata').then((r: any) => r.rows));
    expect(bRows.some((r: any) => r.tenant === 'teamA')).toBe(false);
  });

  test('WITH CHECK blocks writing another tenant\'s row', async () => {
    await expect(
      asTenant('teamA', (c) => c.query(ins('teamB', 'evil', 'E'))),
    ).rejects.toThrow();
  });

  test('fail-closed: unset GUC returns zero rows', async () => {
    const n = await asTenant(null, (c) => c.query('SELECT count(*)::int AS n FROM memory_metadata').then((r: any) => r.rows[0].n));
    expect(n).toBe(0);
  });
});
