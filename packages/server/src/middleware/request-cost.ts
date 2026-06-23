/**
 * Per-request cost instrumentation + telemetry sink (rate-limit policy input #1+#2).
 *
 * Rate limits can only be set from DATA, not guesses: you need (a) what each
 * request class actually COSTS, and (b) how real tenants actually USE it. This
 * module captures both, with negligible overhead and zero risk to the request
 * path (everything here is best-effort and fails open).
 *
 * #1 Cost — for every request we record wall time, the Postgres time + query
 *    count it caused (attributed via a patched pg Client.query + AsyncLocalStorage),
 *    the response status, and its rate-limit class + tenant.
 * #2 Sink — samples are buffered and batch-inserted into `request_cost`; a
 *    background sampler records pg pool saturation (`pool_stats`) — the direct
 *    brownout signal. Percentiles per class/tenant are then a SQL query away
 *    (see queryCostSummary), which is what later turns observation into limits.
 *
 * NB: this writes to the same DB it measures. Writes are batched (one multi-row
 * insert per few seconds), sampled (REQUEST_COST_SAMPLE_RATE), pruned, and run
 * OUTSIDE any request's async context, so they never recurse into the counters
 * and never dominate load.
 */
import type { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { openPgPool } from '@chat-recall/engine/core/store/pg-pool.js';

export interface CostCtx { dbMs: number; dbQueries: number; }
const costALS = new AsyncLocalStorage<CostCtx>();

// ── pg attribution: count DB time/queries into the active request's context ──
let pgPatched = false;
export async function instrumentPgOnce(): Promise<void> {
  if (pgPatched) return;
  pgPatched = true;
  try {
    const pg = (await import('pg')).default;
    // Patch ONLY Client.prototype.query: Pool.query delegates to a pooled
    // client's query, and tenantQuery uses client.query directly, so this one
    // seam catches every statement without double-counting.
    const Client: any = pg.Client;
    const orig = Client.prototype.query;
    if (orig.__cost_instrumented) return;
    Client.prototype.query = function (this: unknown, ...args: unknown[]) {
      const ctx = costALS.getStore();
      if (!ctx) return orig.apply(this, args);
      const t0 = performance.now();
      const res = orig.apply(this, args);
      if (res && typeof (res as Promise<unknown>).then === 'function') {
        const fin = () => { ctx.dbMs += performance.now() - t0; ctx.dbQueries += 1; };
        (res as Promise<unknown>).then(fin, fin);
      } else {
        ctx.dbQueries += 1;   // callback/streaming form — count, can't time
      }
      return res;
    };
    Client.prototype.query.__cost_instrumented = true;
  } catch {
    pgPatched = false;   // allow a retry; instrumentation is optional
  }
}

// ── sample buffer + batched flush ──
interface Sample { tenant: string; rlClass: string; route: string; status: number; wallMs: number; dbMs: number; dbQueries: number; }
const buffer: Sample[] = [];
const MAX_BUFFER = 5000;                                  // hard cap → drop rather than OOM
const SAMPLE_RATE = (() => { const v = Number(process.env.REQUEST_COST_SAMPLE_RATE); return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1; })();
let schemaReady: Promise<void> | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS request_cost (
  ts          timestamptz NOT NULL DEFAULT now(),
  tenant      text,
  rl_class    text,
  route       text,
  status      int,
  wall_ms     double precision,
  db_ms       double precision,
  db_queries  int
);
CREATE INDEX IF NOT EXISTS request_cost_class_ts ON request_cost (rl_class, ts);
CREATE INDEX IF NOT EXISTS request_cost_tenant_ts ON request_cost (tenant, ts);
CREATE TABLE IF NOT EXISTS pool_stats (
  ts      timestamptz NOT NULL DEFAULT now(),
  total   int,
  idle    int,
  waiting int
);
CREATE INDEX IF NOT EXISTS pool_stats_ts ON pool_stats (ts);
`;

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => { const pool = await openPgPool(); await pool.query(SCHEMA); })();
    schemaReady.catch(() => { schemaReady = null; });
  }
  return schemaReady;
}

async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  try {
    await ensureSchema();
    const pool = await openPgPool();
    const cols = 7;
    const values: unknown[] = [];
    const tuples = batch.map((s, i) => {
      const b = i * cols;
      values.push(s.tenant, s.rlClass, s.route, s.status, s.wallMs, s.dbMs, s.dbQueries);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
    });
    await pool.query(
      `INSERT INTO request_cost (tenant, rl_class, route, status, wall_ms, db_ms, db_queries) VALUES ${tuples.join(',')}`,
      values,
    );
  } catch {
    /* telemetry is best-effort — drop the batch rather than retry-storm the DB */
  }
}

let started = false;
/** Start background flush + pool sampler + retention prune. Idempotent. */
export function startCostTelemetry(): void {
  if (started) return;
  started = true;
  void instrumentPgOnce();
  setInterval(() => { void flush(); }, 5000).unref();
  // Pool saturation: the direct DB-pressure signal. waiting>0 ⇒ at the ceiling.
  setInterval(() => { void samplePool(); }, 10_000).unref();
  // Retention: keep a week of samples; prune hourly.
  setInterval(() => { void prune(); }, 3_600_000).unref();
}

let lastPool = { total: 0, idle: 0, waiting: 0 };
async function samplePool(): Promise<void> {
  try {
    const pool: any = await openPgPool();
    lastPool = { total: pool.totalCount ?? 0, idle: pool.idleCount ?? 0, waiting: pool.waitingCount ?? 0 };
    await ensureSchema();
    await pool.query('INSERT INTO pool_stats (total, idle, waiting) VALUES ($1,$2,$3)', [lastPool.total, lastPool.idle, lastPool.waiting]);
  } catch { /* best-effort */ }
}
/** Latest pool gauge for the Prometheus endpoint. */
export function latestPoolStats(): { total: number; idle: number; waiting: number } { return lastPool; }

async function prune(): Promise<void> {
  try {
    const pool = await openPgPool();
    const days = Number(process.env.REQUEST_COST_RETENTION_DAYS) || 7;
    await pool.query(`DELETE FROM request_cost WHERE ts < now() - ($1 || ' days')::interval`, [String(days)]);
    await pool.query(`DELETE FROM pool_stats   WHERE ts < now() - ($1 || ' days')::interval`, [String(days)]);
  } catch { /* best-effort */ }
}

// ── the middleware ──
/** Establish a cost context for the request and record a sample on finish. */
export function costMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ctx: CostCtx = { dbMs: 0, dbQueries: 0 };
  const t0 = performance.now();
  costALS.run(ctx, () => {
    res.on('finish', () => {
      try {
        if (SAMPLE_RATE < 1 && Math.random() > SAMPLE_RATE) return;
        if (buffer.length >= MAX_BUFFER) return;   // shed telemetry under extreme load
        buffer.push({
          tenant: ((req as any).tenant as string) || req.ip || 'anon',
          rlClass: ((req as any).rlClass as string) || 'unclassified',
          // Coarse route (template if available, else mount path) — never the
          // full URL, to avoid unbounded cardinality / leaking ids.
          route: (req.baseUrl || '') + ((req.route && req.route.path) || ''),
          status: res.statusCode,
          wallMs: performance.now() - t0,
          dbMs: ctx.dbMs,
          dbQueries: ctx.dbQueries,
        });
      } catch { /* never let telemetry break a response */ }
    });
    next();
  });
}

/**
 * Percentile summary per class (and optionally per tenant) over a window —
 * the query that turns collected samples into the numbers limits are set from.
 * `windowMinutes` default 60.
 */
export async function queryCostSummary(windowMinutes = 60): Promise<{
  byClass: Array<{ rl_class: string; n: number; rps: number; p50: number; p95: number; p99: number; avg_db_ms: number; avg_queries: number }>;
  topTenants: Array<{ tenant: string; rl_class: string; n: number; rps: number; p99: number }>;
  pool: { total: number; idle: number; waiting: number; max_waiting_window: number };
}> {
  const pool = await openPgPool();
  await ensureSchema();
  const w = Math.max(1, Math.floor(windowMinutes));
  const secs = w * 60;
  const byClass = (await pool.query(
    `SELECT rl_class,
        count(*)                                                  AS n,
        count(*)::float / $1                                      AS rps,
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY wall_ms)     AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY wall_ms)     AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY wall_ms)     AS p99,
        avg(db_ms)                                                AS avg_db_ms,
        avg(db_queries)                                           AS avg_queries
     FROM request_cost WHERE ts > now() - ($2 || ' minutes')::interval
     GROUP BY rl_class ORDER BY n DESC`,
    [secs, String(w)],
  )).rows;
  const topTenants = (await pool.query(
    `SELECT tenant, rl_class, count(*) AS n, count(*)::float / $1 AS rps,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY wall_ms) AS p99
     FROM request_cost WHERE ts > now() - ($2 || ' minutes')::interval
     GROUP BY tenant, rl_class ORDER BY n DESC LIMIT 20`,
    [secs, String(w)],
  )).rows;
  const ps = (await pool.query(
    `SELECT coalesce(max(waiting),0) AS max_waiting FROM pool_stats WHERE ts > now() - ($1 || ' minutes')::interval`,
    [String(w)],
  )).rows[0];
  return {
    byClass: byClass.map((r: any) => ({ rl_class: r.rl_class, n: Number(r.n), rps: Number(r.rps), p50: Number(r.p50), p95: Number(r.p95), p99: Number(r.p99), avg_db_ms: Number(r.avg_db_ms), avg_queries: Number(r.avg_queries) })),
    topTenants: topTenants.map((r: any) => ({ tenant: r.tenant, rl_class: r.rl_class, n: Number(r.n), rps: Number(r.rps), p99: Number(r.p99) })),
    pool: { ...latestPoolStats(), max_waiting_window: Number(ps?.max_waiting ?? 0) },
  };
}
