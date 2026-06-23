/**
 * Shared Postgres pool helper for all Pg* drivers. Sets the int8 type parser
 * (so BIGINT columns come back as numbers, matching the SQLite shape) and runs
 * the idempotent schema on first connect.
 *
 * Pools are cached per connection URL: stores are created per request (and
 * per MCP tool call), so without the cache every createStore() opened a new
 * Pool(max 8) — connection churn that exhausts pg max_connections under any
 * real traffic. The cached pool is shared; drivers must NOT end() it (their
 * close() is a no-op for pooled pg connections — see closePgPools for
 * process shutdown).
 */
let int8ParserSet = false;
const POOLS = new Map<string, Promise<any>>();

export async function openPgPool(databaseUrl?: string): Promise<any> {
  const url = databaseUrl || process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
  if (!url) throw new Error('Postgres: no DATABASE_URL configured');
  let pooled = POOLS.get(url);
  if (!pooled) {
    pooled = (async () => {
      const pg = (await import('pg')).default;
      if (!int8ParserSet) {
        pg.types.setTypeParser(20, (v: string | null) => (v === null ? null : parseInt(v, 10)));
        int8ParserSet = true;
      }
      // Pool size: the per-process concurrency ceiling against Postgres. 8 was
      // far too small (a single 1500-query ingest could pin most of it). Bump
      // to 20 (env-tunable). Keep replicas × PG_POOL_MAX comfortably under the
      // server's max_connections (~100) — past that is where a pooler/PgBouncer
      // earns its place.
      const poolMax = Math.max(2, Number(process.env.PG_POOL_MAX) || 20);
      const pool = new pg.Pool({ connectionString: url, max: poolMax });
      const { PG_SCHEMA } = await import('./pg-schema.js');
      await pool.query(PG_SCHEMA);
      return pool;
    })();
    POOLS.set(url, pooled);
    // A failed bootstrap (bad URL, db down) must not poison the cache forever.
    pooled.catch(() => POOLS.delete(url));
  }
  return pooled;
}

/** End every cached pool. For process shutdown and tests only. */
export async function closePgPools(): Promise<void> {
  const pools = [...POOLS.values()];
  POOLS.clear();
  await Promise.all(pools.map(async (p) => { try { await (await p).end(); } catch { /* closing */ } }));
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

/**
 * Run MANY statements inside ONE tenant-scoped transaction (one BEGIN/SET
 * GUC/COMMIT, one connection). Use this whenever a write touches more than one
 * row/statement — calling tenantQuery per row pays the BEGIN+SET+COMMIT
 * round-trips every time, which is what made bulk ingest do thousands of
 * round-trips. The callback gets the checked-out client; issue `client.query`
 * directly inside it. Rolls back and rethrows on error.
 */
export async function tenantTx<T>(pool: any, tenant: string, fn: (client: any) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant', $1, true)", [tenant]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Build + run param-chunked multi-row INSERTs on an already-open client (inside
 * a tenantTx). Splits rows so the bound-parameter count stays well under
 * Postgres's 65535 limit. `conflictSql` is appended verbatim (e.g. an
 * `ON CONFLICT … DO UPDATE …`). De-dupe conflict keys BEFORE calling — a single
 * INSERT cannot hit the same ON CONFLICT key twice.
 */
export async function bulkInsert(
  client: any,
  table: string,
  columns: string[],
  rows: unknown[][],
  conflictSql = '',
): Promise<void> {
  if (rows.length === 0) return;
  const cols = columns.length;
  const maxRows = Math.max(1, Math.floor(60000 / cols));
  const colList = columns.join(',');
  for (let off = 0; off < rows.length; off += maxRows) {
    const slice = rows.slice(off, off + maxRows);
    const params: unknown[] = [];
    const tuples = slice.map((row) => {
      const base = params.length;
      for (const v of row) params.push(v);
      return '(' + columns.map((_, i) => `$${base + i + 1}`).join(',') + ')';
    });
    await client.query(`INSERT INTO ${table} (${colList}) VALUES ${tuples.join(',')} ${conflictSql}`, params);
  }
}
