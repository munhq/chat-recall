/**
 * Shared Postgres pool helper for all Pg* drivers. Sets the int8 type parser
 * (so BIGINT columns come back as numbers, matching the SQLite shape) and runs
 * the idempotent schema on first connect.
 */
let int8ParserSet = false;

export async function openPgPool(databaseUrl?: string): Promise<any> {
  const url = databaseUrl || process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
  if (!url) throw new Error('Postgres: no DATABASE_URL configured');
  const pg = (await import('pg')).default;
  if (!int8ParserSet) {
    pg.types.setTypeParser(20, (v: string | null) => (v === null ? null : parseInt(v, 10)));
    int8ParserSet = true;
  }
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  const { PG_SCHEMA } = await import('./pg-schema.js');
  await pool.query(PG_SCHEMA);
  return pool;
}

export function pgTenant(t?: string): string {
  return t || process.env.CHAT_RECALL_TENANT || 'default';
}

/**
 * Run a single query inside a tenant-scoped transaction. `SET LOCAL` (via
 * set_config(..., true)) binds the `app.tenant` GUC for THIS transaction only,
 * so Row-Level-Security policies isolate rows by tenant. LOCAL is mandatory:
 * a session-level SET would leak the tenant across the shared pool's next
 * checkout. Self-host pins tenant='default' and the policy passes trivially.
 */
export async function tenantQuery(pool: any, tenant: string, sql: string, params: unknown[] = []): Promise<any> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant', $1, true)", [tenant]);
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    c.release();
  }
}
