/**
 * Prometheus metrics endpoint (P1-9).
 *
 * Renders the shared prom-client registry (metrics/registry.ts) in the
 * Prometheus text exposition format so the cluster's Prometheus →
 * Alertmanager/Grafana stack can scrape it. The registry already carries the
 * live-updated HTTP (RED) histograms/counters, worker counters, and Node/process
 * metrics; on each scrape this handler ALSO refreshes the database-derived
 * gauges — capacity, security, work backlog, and SaaS business metrics — so a
 * single GET returns everything.
 *
 * The whole point of "verified-live secret findings" is that they should *page
 * someone*; `chatrecall_secret_findings_verified` is the alertable series. The
 * business gauges (MRR, conversions, churn) are sensitive, so for an
 * internet-exposed deployment set METRICS_TOKEN (Bearer) — Prometheus sends it
 * via `bearer_token_file`. No token ⇒ open on local/self-host; on the cloud
 * edition no token fails CLOSED for non-private source IPs (see metricsAccess).
 *
 * Mounted at `/metrics` (top-level, OUTSIDE `/api` → not tenant-scoped, and the
 * api rate-limiter doesn't apply).
 */
import express from 'express';
import { openPgPool, openPgPoolRo, tenantQuery } from '@chat-recall/engine/core/store/pg-pool.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { latestPoolStats, queryCostSummary } from '../middleware/request-cost.js';
import { edition } from '../util/mode.js';
import {
  registry,
  gUp, gSessions, gChunks, gRawSessions, gSecretFindings, gSecretFindingsVerified, gTenants,
  gPoolTotal, gPoolIdle, gPoolWaiting,
  gPendingVectors, gPendingSummaries, gPendingRealSummaries,
  gSubscriptions, gSubscriptionsByPlan, gMrrUsd, gTrialsActive, gTrialsExpiring24h,
  gTeamsTotal, gMembersTotal, gSignups24h, gConversions24h, gChurn24h,
} from '../metrics/registry.js';

const router = express.Router();
const log = createLogger('metrics');

/**
 * True for loopback/RFC1918/ULA/link-local source addresses (the direct TCP
 * peer, NOT X-Forwarded-For — that header is caller-controlled).
 */
function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip; // IPv4-mapped IPv6
  if (/^127\./.test(v4) || v4 === '::1') return true;                      // loopback
  if (/^10\./.test(v4) || /^192\.168\./.test(v4)) return true;            // RFC1918
  const m172 = v4.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true; // RFC1918
  if (/^f[cd]/i.test(ip) || /^fe80:/i.test(ip)) return true;               // ULA / link-local v6
  return false;
}

type MetricsAccess = { ok: true } | { ok: false; status: number; message: string };

/**
 * Access policy for the metrics surface:
 *   - METRICS_TOKEN set → Bearer token required (401 otherwise). Unchanged.
 *   - METRICS_TOKEN unset, cloud edition → fail-closed for non-private source
 *     IPs (403), but private/loopback peers stay allowed so the in-cluster
 *     Prometheus (which scrapes tokenless today) keeps working.
 *     Trade-off, stated honestly: we check the DIRECT peer address, so a
 *     request proxied through an in-cluster ingress arrives from a private
 *     pod IP and passes. This blocks only direct external exposure; the real
 *     fix is setting METRICS_TOKEN + the ServiceMonitor bearer-token secret
 *     (logged as an error at boot via logMetricsExposureAtBoot).
 *   - METRICS_TOKEN unset, local/self-host → open (current behavior; the norm
 *     behind a private compose network / ingress allowlist).
 */
function metricsAccess(req: express.Request): MetricsAccess {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    if (req.headers.authorization === `Bearer ${token}`) return { ok: true };
    return { ok: false, status: 401, message: 'unauthorized' };
  }
  if (edition() === 'cloud') {
    const peer = req.socket.remoteAddress ?? '';
    if (isPrivateAddress(peer)) return { ok: true };
    return {
      ok: false,
      status: 403,
      message: 'metrics disabled for external callers: set METRICS_TOKEN on the server and the matching bearer-token secret on the Prometheus ServiceMonitor',
    };
  }
  return { ok: true };
}

/**
 * Boot-time exposure check — call once from server startup. On the cloud
 * edition with no METRICS_TOKEN, /metrics (MRR, churn, tenant counts, secret
 * findings) is reachable by anything that can hit the pod from a private
 * address, and external callers are only blocked by the peer-IP heuristic
 * above. That's a stopgap, not auth — say so loudly.
 */
export function logMetricsExposureAtBoot(): void {
  if (edition() === 'cloud' && !process.env.METRICS_TOKEN) {
    log.error(
      'METRICS_TOKEN is unset on the cloud edition: /metrics (business + security gauges) is only protected by a private-source-IP check. Set METRICS_TOKEN and configure the Prometheus ServiceMonitor bearer-token secret before exposing this deployment.',
    );
  }
}

/** Per-tenant prices in USD/month for MRR, from BILLING_PRICE_USD_MAP (JSON,
 *  keyed by Stripe price id) with BILLING_PRICE_USD as a flat fallback for every
 *  active sub whose plan isn't in the map. Parsed once. */
const priceMap: Record<string, number> = (() => {
  try {
    return JSON.parse(process.env.BILLING_PRICE_USD_MAP || '{}');
  } catch {
    return {};
  }
})();
const flatPriceUsd = Number(process.env.BILLING_PRICE_USD) || 0;

// ── DB collectors (shared by `/` and `/backlog`) ─────────────────────────────

/**
 * Capacity + security counts. The data tables are RLS-scoped by the
 * `app.tenant` GUC, so a plain server-wide COUNT returns 0 on the cloud. We sum
 * per tenant INSIDE each tenant's RLS context AND filter on `tenant=$1` — the
 * explicit filter keeps totals correct on self-host where RLS isn't enforced.
 */
async function collectCapacity(pool: any, slugs: string[]) {
  let sessions = 0, chunks = 0, raw = 0, findings = 0, verified = 0;
  for (const t of slugs) {
    const r = (await tenantQuery(pool, t, `
      SELECT
        (SELECT count(*) FROM memory_metadata WHERE tenant=$1 AND source_type='session') AS sessions,
        (SELECT count(*) FROM memory_chunks   WHERE tenant=$1) AS chunks,
        (SELECT count(*) FROM raw_sessions    WHERE tenant=$1) AS raw,
        (SELECT count(*) FROM secret_findings WHERE tenant=$1) AS findings,
        (SELECT count(*) FROM secret_findings WHERE tenant=$1 AND verified=1) AS verified
    `, [t])).rows[0];
    sessions += Number(r.sessions); chunks += Number(r.chunks); raw += Number(r.raw);
    findings += Number(r.findings); verified += Number(r.verified);
  }
  return { sessions, chunks, raw, findings, verified };
}

/**
 * Work backlog across tenants — the KEDA scale signal. `pendingRealSummaries`
 * excludes trivial sessions (<= SUMMARY_MIN_TURNS) that resolve to first_prompt
 * with NO LLM call, so KEDA scales OVMS on summaries that actually need compute.
 */
async function collectBacklog(pool: any, slugs: string[]) {
  const minTurns = Math.max(0, Number(process.env.SUMMARY_MIN_TURNS) || 4);
  let pendingVectors = 0, pendingSummaries = 0, pendingRealSummaries = 0;
  for (const t of slugs) {
    const r = (await tenantQuery(pool, t, `
      SELECT
        (SELECT count(*) FROM memory_chunks c
           LEFT JOIN memory_vectors v ON v.chunk_id = c.chunk_id AND v.tenant = c.tenant
           WHERE c.tenant = $1 AND length(c.text) > 0 AND v.chunk_id IS NULL) AS pending_vectors,
        (SELECT count(*) FROM session_metadata
           WHERE tenant = $1 AND (summary IS NULL OR length(summary) = 0)) AS pending_summaries,
        (SELECT count(*) FROM session_metadata sm
           WHERE sm.tenant = $1 AND (sm.summary IS NULL OR length(sm.summary) = 0)
             AND EXISTS (SELECT 1 FROM memory_metadata m
                          WHERE m.tenant = sm.tenant AND m.id = sm.session_id AND m.source_type = 'session'
                            AND m.extra_json LIKE '{%'
                            AND COALESCE(NULLIF(m.extra_json::jsonb ->> 'messageCount', '')::int, 999) > $2)
        ) AS pending_real_summaries
    `, [t, minTurns])).rows[0];
    pendingVectors += Number(r.pending_vectors);
    pendingSummaries += Number(r.pending_summaries);
    pendingRealSummaries += Number(r.pending_real_summaries);
  }
  return { pendingVectors, pendingSummaries, pendingRealSummaries };
}

/**
 * SaaS business metrics from the control plane (NOT RLS-walled, so plain pool
 * queries). Sets subscription counts by status/plan, MRR, trials, and the 24h
 * signup/conversion/churn rates.
 */
async function collectBusiness(pool: any) {
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;

  // Subscriptions by status, and by plan+status (for MRR + funnel).
  const byPlan = (await pool.query(
    `SELECT coalesce(plan,'unknown') AS plan, coalesce(status,'none') AS status, count(*)::int AS n
       FROM entitlements GROUP BY plan, status`,
  )).rows as Array<{ plan: string; status: string; n: number }>;

  // Reset label sets each scrape so vanished plans/statuses don't linger.
  gSubscriptionsByPlan.reset();
  const byStatus: Record<string, number> = { active: 0, trialing: 0, past_due: 0, canceled: 0, none: 0 };
  let mrr = 0;
  for (const row of byPlan) {
    gSubscriptionsByPlan.set({ plan: row.plan, status: row.status }, row.n);
    byStatus[row.status] = (byStatus[row.status] || 0) + row.n;
    if (row.status === 'active') {
      const price = priceMap[row.plan] ?? flatPriceUsd;
      mrr += price * row.n;
    }
  }
  for (const status of ['active', 'trialing', 'past_due', 'canceled', 'none']) {
    gSubscriptions.set({ status }, byStatus[status] || 0);
  }
  gMrrUsd.set(mrr);

  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await pool.query(sql, params)).rows[0]?.n ?? 0);

  gTrialsActive.set(byStatus.trialing || 0);
  gTrialsExpiring24h.set(await one(
    `SELECT count(*)::int AS n FROM entitlements
       WHERE status='trialing' AND current_period_end IS NOT NULL
         AND current_period_end BETWEEN $1 AND $2`, [now, now + 24 * 3600 * 1000]));
  gTeamsTotal.set(await one(`SELECT count(*)::int AS n FROM teams`));
  gMembersTotal.set(await one(`SELECT count(*)::int AS n FROM memberships`));
  gSignups24h.set(await one(`SELECT count(*)::int AS n FROM teams WHERE created_at > $1`, [dayAgo]));
  gConversions24h.set(await one(
    `SELECT count(*)::int AS n FROM entitlements WHERE status='active' AND updated_at > $1`, [dayAgo]));
  gChurn24h.set(await one(
    `SELECT count(*)::int AS n FROM entitlements WHERE status='canceled' AND updated_at > $1`, [dayAgo]));
}

// ── Backlog cache (KEDA-safe) ────────────────────────────────────────────────
// The backlog COUNTs (per-tenant RLS anti-join over 100k+ chunks + a jsonb
// messageCount parse) take seconds — too slow for KEDA's metrics-api timeout.
// That made BOTH the OVMS summaries and Ollama embeddings scalers read
// <unknown> and stop scaling (FailedGetExternalMetric). So we compute it on a
// BACKGROUND timer and serve the last snapshot instantly; KEDA/Prometheus never
// block on the query.
interface BacklogSnapshot { pendingVectors: number; pendingSummaries: number; pendingRealSummaries: number; tenants: number; at: number; }
let backlogCache: BacklogSnapshot = { pendingVectors: 0, pendingSummaries: 0, pendingRealSummaries: 0, tenants: 0, at: 0 };
let backlogRefreshing = false;

async function refreshBacklog(): Promise<void> {
  if (backlogRefreshing) return;
  backlogRefreshing = true;
  try {
    // Deliberately the RW pooler, NOT openPgPoolRo: this seconds-long COUNT was
    // cancelled by WAL replay on the hot standby ("conflict with recovery") on
    // nearly every tick while the embedding backfill streams writes — the KEDA
    // scalers ran blind on a stale snapshot and the log spammed a warn/min. A
    // bounded count every BACKLOG_REFRESH_MS is cheap on the primary; a read
    // that reliably dies on the replica offloads nothing.
    const pool = await openPgPool();
    const slugs: string[] = (await pool.query('SELECT tenant FROM tenants')).rows.map((r: any) => r.tenant);
    const b = await collectBacklog(pool, slugs);
    backlogCache = { ...b, tenants: slugs.length, at: Date.now() };
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'backlog refresh failed (serving last value)');
  } finally {
    backlogRefreshing = false;
  }
}

let backlogStarted = false;
/** Start the background backlog refresher (server mode). Idempotent. */
export function startBacklogRefresher(): void {
  if (backlogStarted) return;
  backlogStarted = true;
  void refreshBacklog();                                   // warm immediately at boot
  const ms = Math.max(5000, Number(process.env.BACKLOG_REFRESH_MS) || 15000);
  setInterval(() => { void refreshBacklog(); }, ms).unref();
}

// ── GET /metrics ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const access = metricsAccess(req);
  if (!access.ok) return res.status(access.status).type('text/plain').send(access.message);

  try {
    // Monitoring aggregations: capacity/backlog/business COUNTs (+ tenant
    // enumeration) are all pure reads that tolerate a scrape-interval of replica
    // lag — route to the read replica to offload per-scrape COUNT load off the
    // primary (falls back to primary when no RO DSN is set).
    const pool = await openPgPoolRo();
    const slugs: string[] = (await pool.query('SELECT tenant FROM tenants')).rows.map((r: any) => r.tenant);

    const cap = await collectCapacity(pool, slugs);
    gSessions.set(cap.sessions);
    gChunks.set(cap.chunks);
    gRawSessions.set(cap.raw);
    gSecretFindings.set(cap.findings);
    gSecretFindingsVerified.set(cap.verified);
    gTenants.set(slugs.length);

    const ps = latestPoolStats();
    gPoolTotal.set(ps.total);
    gPoolIdle.set(ps.idle);
    gPoolWaiting.set(ps.waiting);

    // Backlog from the background cache (never run the heavy query on a scrape).
    gPendingVectors.set(backlogCache.pendingVectors);
    gPendingSummaries.set(backlogCache.pendingSummaries);
    gPendingRealSummaries.set(backlogCache.pendingRealSummaries);

    await collectBusiness(pool);

    gUp.set(1);
  } catch (e) {
    // Surface a scrapeable down-signal instead of a 500 so Prometheus can alert
    // on chatrecall_up==0 rather than a missing target.
    gUp.set(0);
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'metrics query failed');
  }

  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});

// Rate-limit cost telemetry summary (JSON): per-class latency percentiles +
// request rate, the noisiest tenants, and pool saturation over a window.
// Gated by the same METRICS_TOKEN. ?window=<minutes> (default 60).
router.get('/rl-cost', async (req, res) => {
  const access = metricsAccess(req);
  if (!access.ok) return res.status(access.status).json({ error: access.message });
  try {
    const windowMinutes = Math.max(1, Math.min(Number(req.query.window) || 60, 10080));
    const summary = await queryCostSummary(windowMinutes);
    res.json({ windowMinutes, ...summary });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Work-backlog gauges (JSON) for the KEDA metrics-api scaler. Returns the
// cross-tenant count of work still pending so KEDA scales the OVMS embeddings /
// summaries deployments on PENDING WORK rather than CPU. Unauthenticated by
// default (cluster-internal); gated by METRICS_TOKEN when set.
router.get('/backlog', (req, res) => {
  const access = metricsAccess(req);
  if (!access.ok) return res.status(access.status).json({ error: access.message });
  // Served from the in-memory snapshot — instant, so KEDA's metrics-api never
  // times out. `at` lets a consumer see snapshot freshness if it cares.
  const { pendingVectors, pendingSummaries, pendingRealSummaries, tenants } = backlogCache;
  res.json({ pendingVectors, pendingSummaries, pendingRealSummaries, tenants });
});

export default router;
