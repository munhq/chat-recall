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
 * via `bearer_token_file`. No token ⇒ open, the norm inside a private cluster
 * behind an ingress allowlist.
 *
 * Mounted at `/metrics` (top-level, OUTSIDE `/api` → not tenant-scoped, and the
 * api rate-limiter doesn't apply).
 */
import express from 'express';
import { openPgPool, tenantQuery } from '@chat-recall/engine/core/store/pg-pool.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { latestPoolStats, queryCostSummary } from '../middleware/request-cost.js';
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

function tokenOk(req: express.Request): boolean {
  const token = process.env.METRICS_TOKEN;
  return !token || req.headers.authorization === `Bearer ${token}`;
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

// ── GET /metrics ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  if (!tokenOk(req)) return res.status(401).type('text/plain').send('unauthorized');

  try {
    const pool = await openPgPool(process.env.DATABASE_URL || '');
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

    const backlog = await collectBacklog(pool, slugs);
    gPendingVectors.set(backlog.pendingVectors);
    gPendingSummaries.set(backlog.pendingSummaries);
    gPendingRealSummaries.set(backlog.pendingRealSummaries);

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
  if (!tokenOk(req)) return res.status(401).json({ error: 'unauthorized' });
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
router.get('/backlog', async (req, res) => {
  if (!tokenOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const pool = await openPgPool(process.env.DATABASE_URL || '');
    const slugs: string[] = (await pool.query('SELECT tenant FROM tenants')).rows.map((r: any) => r.tenant);
    const backlog = await collectBacklog(pool, slugs);
    res.json({ ...backlog, tenants: slugs.length });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
