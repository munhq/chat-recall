/**
 * Shared Postgres pool helper for all Pg* drivers.
 *
 * Two SEPARATE concerns, deliberately decoupled:
 *   1. `openPgPool(url)` — open (and cache) a connection pool. PURE: it sets the
 *      int8 type parser and creates the pool, and runs NO DDL. Safe against ANY
 *      database role, including a read-only replica.
 *   2. `ensurePgSchema(url)` — run the idempotent schema bootstrap. A WRITE
 *      operation, so it must only ever target the PRIMARY. Memoized per URL.
 *
 * They were once one function (the pool-open ran `PG_SCHEMA`), which was fine
 * while exactly one writable pool existed. The moment a second pool was opened
 * against the read-only replica (DATABASE_URL_RO) it inherited the hidden
 * "every pool may run DDL" assumption and the replica rejected the CREATE TABLE
 * — taking down every read AND every write (createStore() threw at init). Split
 * so opening a pool can never imply writing to the database.
 *
 * Pools are cached per connection URL: stores are created per request (and
 * per MCP tool call), so without the cache every createStore() opened a new
 * Pool — connection churn that exhausts pg max_connections under any real
 * traffic. The cached pool is shared; drivers must NOT end() it (their close()
 * is a no-op for pooled pg connections — see closePgPools for process shutdown).
 */
import { currentViewer } from './tenant-context.js';

let int8ParserSet = false;
const POOLS = new Map<string, Promise<any>>();
const SCHEMA_READY = new Map<string, Promise<void>>();

/**
 * Set the per-transaction scope GUCs on a checked-out client: always
 * `app.tenant` (the RLS tenant wall), and — for an authenticated request only —
 * `app.viewer` (per-project team visibility). Both are LOCAL (txn-scoped), so
 * they reset at COMMIT/ROLLBACK and never leak across pooled checkouts. A
 * background worker / CLI (no ambient author context) leaves `app.viewer` unset,
 * and the RLS policy's `IS NULL` short-circuit lets it read the whole tenant.
 * See currentViewer() for the tri-state rationale.
 */
async function setScopeGucs(c: any, tenant: string): Promise<void> {
  await c.query("SELECT set_config('app.tenant', $1, true)", [tenant]);
  // ALWAYS set app.viewer to a well-defined value — never rely on "unset". A
  // custom GUC reverts to EMPTY STRING (not NULL) on a pooled connection once
  // it's been set even once, so an `IS NULL` short-circuit is unreliable across
  // checkouts. The '*' sentinel means "no author context → a worker/CLI → see
  // the whole tenant"; a real request sets the viewer's sub (or '' for a
  // null-sub self-host request, which then sees only NULL-author rows).
  const viewer = currentViewer();
  await c.query("SELECT set_config('app.viewer', $1, true)", [viewer === undefined ? '*' : (viewer ?? '')]);
}

/** Open (and cache) a connection pool. Pure — NO schema/DDL side effect, so it
 *  is safe against a read-only replica. Callers that need tables to exist must
 *  separately call `ensurePgSchema(primaryUrl)` (never against a replica). */
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
      return new pg.Pool({ connectionString: url, max: poolMax });
    })();
    POOLS.set(url, pooled);
    // A failed open (bad URL) must not poison the cache forever.
    pooled.catch(() => POOLS.delete(url));
  }
  return pooled;
}

/**
 * Open (and cache) the READ pool → the read-only replica via PgBouncer
 * (`DATABASE_URL_RO`, the `-pooler-ro` service). Use this for pure, lag-tolerant
 * SELECTs (search, analytics, monitoring, list/view reads) to offload the
 * primary. NEVER use it for writes, read-after-write, or `SKIP LOCKED` claims —
 * the replica is read-only and lags the primary by streaming-replication delay.
 *
 * Falls back to the primary (`openPgPool`) when no RO DSN is set (local,
 * self-host, tests, or a single-DB deployment) so callers can ALWAYS route reads
 * here without branching — behaviour is identical when there's no replica.
 */
export async function openPgPoolRo(): Promise<any> {
  const roUrl = process.env.DATABASE_URL_RO || process.env.CHAT_RECALL_DATABASE_URL_RO;
  const primary = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
  // No RO DSN, or it's literally the primary ⇒ just use the primary pool.
  if (!roUrl || roUrl === primary) return openPgPool(primary);
  return openPgPool(roUrl);
}

/**
 * Idempotently apply the schema to the PRIMARY database. Memoized per URL so
 * the DDL runs exactly once per process regardless of how many drivers ask for
 * it. NEVER call this against a read-only replica — its tables arrive via
 * streaming replication; issuing DDL there fails ("cannot execute CREATE TABLE
 * in a read-only transaction"). No URL configured (sqlite/local) ⇒ no-op.
 */
/** Arbitrary constant, shared by every replica: the schema-bootstrap mutex. */
const SCHEMA_LOCK_KEY = 8_246_113_001;
/** How long to wait for another replica's bootstrap before applying anyway. */
const SCHEMA_LOCK_WAIT_MS = 60_000;
/** Attempts at the schema DDL before giving up. A lock conflict with live read
 *  traffic is transient by nature, so a few jittered retries clear it; failing
 *  after that still surfaces a real problem rather than hiding it. */
const SCHEMA_MAX_ATTEMPTS = 5;


/** Postgres SQLSTATEs worth another attempt: deadlock_detected and
 *  lock_not_available (what `lock_timeout` raises). Both mean "someone else
 *  held a conflicting lock", which is transient by definition. */
const RETRYABLE_LOCK_CODES = new Set(['40P01', '55P03']);

/**
 * Apply the schema DDL, retrying a lock conflict.
 *
 * Split out of ensurePgSchema so the retry is testable without a database.
 * `sleep` is injectable for the same reason — the tests must not actually wait
 * out the backoff.
 */
export async function applySchemaWithRetry(
  run: (sql: string) => Promise<unknown>,
  sql: string,
  opts: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const maxAttempts = opts.maxAttempts ?? SCHEMA_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      await run(sql);
      return attempt;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (!code || !RETRYABLE_LOCK_CODES.has(code) || attempt >= maxAttempts) throw err;
      // Jittered backoff. Without the jitter, two pods that deadlocked together
      // wake together and deadlock again on the same schedule.
      const backoff = Math.min(250 * 2 ** (attempt - 1), 4000) + Math.floor(Math.random() * 250);
      await sleep(backoff);
    }
  }
}

export async function ensurePgSchema(databaseUrl?: string): Promise<void> {
  const url = databaseUrl || process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
  if (!url) return; // not a Postgres deployment — nothing to bootstrap
  let ready = SCHEMA_READY.get(url);
  if (!ready) {
    ready = (async () => {
      const pool = await openPgPool(url);
      const { PG_SCHEMA } = await import('./pg-schema.js');
      // Schema DDL (ADD COLUMN / CREATE TABLE on hot tables) must NOT be killed by
      // the app's default statement_timeout — that crashed boot mid-bootstrap. Run
      // it on a DEDICATED connection with the statement timeout lifted and a
      // bounded lock_timeout (so it fails fast + retries next boot rather than
      // hanging if a lock is genuinely unavailable). release(true) destroys the
      // connection so these session settings never leak back into the pool.
      const client = await pool.connect();
      try {
        await client.query('SET statement_timeout = 0');
        await client.query("SET lock_timeout = '30s'");
        // Cross-PROCESS mutex. SCHEMA_READY above only dedupes within one
        // process, but a rollout boots every replica at once (server + worker)
        // and each runs this same DDL: their ALTER TABLEs grab
        // AccessExclusiveLock on overlapping tables in interleaved order and
        // deadlock (40P01), which crash-loops pods through the rollout. One
        // applier at a time removes the interleaving entirely.
        //
        // try-lock + bounded wait rather than pg_advisory_lock: lock_timeout
        // does NOT apply to advisory locks, so an unconditional wait could hang
        // boot forever behind a wedged holder. After the budget we apply anyway
        // — the DDL is idempotent, so the worst case is exactly today's
        // behavior, never a pod that refuses to start.
        const deadline = Date.now() + SCHEMA_LOCK_WAIT_MS;
        let held = false;
        while (Date.now() < deadline) {
          const r = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [SCHEMA_LOCK_KEY]);
          if (r.rows[0]?.ok) { held = true; break; }
          await new Promise((res) => setTimeout(res, 500));
        }
        try {
          // Retry on a lock conflict. The advisory lock above serialises the
          // APPLIERS, but it cannot serialise the rest of the cluster: during a
          // rolling deploy the outgoing pods are still serving traffic, so an
          // ordinary SELECT holds AccessShareLock on a table this DDL wants
          // AccessExclusiveLock on. Observed in production as 40P01 between
          // memory_chunks and session_metadata, which exited the pod and
          // crash-looped it through every rollout.
          //
          // The window is wide because PG_SCHEMA is one multi-statement string,
          // which Postgres runs as a single implicit transaction — every lock it
          // takes is held until the last statement. Splitting it is not safe
          // (the body contains $$-quoted blocks), and the DDL is idempotent, so
          // retrying the whole thing is both correct and much simpler than
          // making the window narrower.
          await applySchemaWithRetry((sql) => client.query(sql), PG_SCHEMA);
        } finally {
          if (held) await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]).catch(() => {});
        }
      } finally {
        // Destroys the connection, so the advisory lock is released even if the
        // explicit unlock above never ran.
        client.release(true);
      }
    })();
    SCHEMA_READY.set(url, ready);
    // A failed bootstrap (db down at boot) must not poison forever — retry next call.
    ready.catch(() => SCHEMA_READY.delete(url));
  }
  return ready;
}

/** End every cached pool. For process shutdown and tests only. */
export async function closePgPools(): Promise<void> {
  const pools = [...POOLS.values()];
  POOLS.clear();
  SCHEMA_READY.clear();   // a re-opened pool must re-assert schema
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
export async function tenantQuery(
  pool: any, tenant: string, sql: string, params: unknown[] = [],
  opts: {
    /**
     * `SET LOCAL lock_timeout` for this transaction, in ms.
     *
     * For a caller that would rather FAIL than wait behind a lock — monitoring
     * reads, above all. A tenant-scoped read touching several tables holds
     * ACCESS SHARE on each one for the length of the transaction, and the
     * migrate init container runs `ALTER TABLE … ADD COLUMN IF NOT EXISTS` on
     * every pod start (so on every autoscaler event). That is a lock cycle, and
     * Postgres resolves it by killing one side: production logged `deadlock
     * detected` on the metrics scrape, and the victim could just as easily have
     * been the migration — a failed migration crashloops a pod.
     *
     * With a timeout the reader gives up quickly and its caller serves the last
     * snapshot, so monitoring can never be the reason a schema change fails.
     */
    lockTimeoutMs?: number;
  } = {},
): Promise<any> {
  const c = await pool.connect();
  // A connection-level error (server closing the backend, pooler reset, FATAL
  // termination) is emitted as an 'error' event on the client — with NO listener
  // Node treats it as fatal and CRASHES the process. Swallow it here so it
  // surfaces only as the query rejection caught below; the broken client is then
  // discarded by the pool on release.
  const onErr = () => { /* handled via the query rejection */ };
  c.on('error', onErr);
  try {
    await c.query('BEGIN');
    await setScopeGucs(c, tenant);
    if (opts.lockTimeoutMs && Number.isFinite(opts.lockTimeoutMs)) {
      // A literal, not a bound parameter: SET does not accept placeholders. The
      // value is an integer we produced, never caller text.
      await c.query(`SET LOCAL lock_timeout = ${Math.max(1, Math.floor(opts.lockTimeoutMs))}`);
    }
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    c.removeListener('error', onErr);
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
  // See tenantQuery: a connection 'error' with no listener crashes the process.
  const onErr = () => { /* handled via the query/await rejection */ };
  c.on('error', onErr);
  try {
    await c.query('BEGIN');
    await setScopeGucs(c, tenant);
    // The callback may hold this tx open across slow work — the summary worker
    // runs a multi-second LLM call INSIDE the tx (it deliberately holds the
    // FOR UPDATE … SKIP LOCKED locks to dedupe across replicas). That makes the
    // connection "idle in transaction", which Postgres' idle_in_transaction_
    // session_timeout FATALs → unhandled client error → worker crashloop. Disable
    // that timeout for THIS tx only; the app-level operation timeout bounds it.
    await c.query('SET LOCAL idle_in_transaction_session_timeout = 0');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    c.removeListener('error', onErr);
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
