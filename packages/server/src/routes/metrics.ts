/**
 * Prometheus metrics endpoint (P1-9).
 *
 * Exposes server-wide gauges in the Prometheus text exposition format so the
 * existing Prometheus → Alertmanager/Grafana stack can scrape capacity and —
 * more importantly — security signals. The whole point of "verified-live secret
 * findings" is that they should *page someone*, not sit in a dashboard nobody
 * opens; `chatrecall_secret_findings_verified` is the alertable series.
 *
 * Mounted at `/metrics` (top-level, OUTSIDE `/api` → not tenant-scoped, and the
 * api rate-limiter doesn't apply). Optionally gated by `METRICS_TOKEN` (Bearer)
 * for internet-exposed deployments — Prometheus sends it via `bearer_token_file`.
 * No token ⇒ open, which is the norm inside a private cluster behind an ingress
 * allowlist.
 */
import express from 'express';
import { openPgPool, tenantQuery } from '@chat-recall/engine/core/store/pg-pool.js';
import { latestPoolStats, queryCostSummary } from '../middleware/request-cost.js';

const router = express.Router();

function line(name: string, help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
}

router.get('/', async (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).type('text/plain').send('unauthorized');
  }

  const out: string[] = [];
  try {
    const pool = await openPgPool(process.env.DATABASE_URL || '');

    // The data tables (memory_metadata, memory_chunks, raw_sessions,
    // secret_findings) are Row-Level-Security-scoped by the `app.tenant` GUC, so
    // a plain server-wide COUNT returns 0 on an RLS deployment (the cloud). We
    // sum per tenant INSIDE each tenant's RLS context (via tenantQuery) AND
    // filter explicitly on `tenant=$1` — the explicit filter keeps the totals
    // correct on self-host where RLS isn't enforced (otherwise every per-tenant
    // pass would see all rows and we'd multiply by the tenant count).
    const slugs: string[] = (await pool.query('SELECT tenant FROM tenants')).rows.map((r: any) => r.tenant);

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
    const tenants = slugs.length;

    out.push(line('chatrecall_up', '1 when the server can read its database', 1));
    out.push(line('chatrecall_sessions_total', 'Indexed sessions across all tenants', sessions));
    out.push(line('chatrecall_chunks_total', 'Searchable text chunks across all tenants', chunks));
    out.push(line('chatrecall_raw_sessions_total', 'Stored raw (redacted) session archives', raw));
    out.push(line('chatrecall_secret_findings_total', 'Secret findings across all tenants', findings));
    out.push(line('chatrecall_secret_findings_verified', 'Secret findings confirmed LIVE by the verifier — alert on this', verified));
    out.push(line('chatrecall_tenants_total', 'Provisioned tenants', tenants));

    // pg pool saturation — the direct overload signal that rate limits defend.
    // waiting>0 sustained ⇒ requests are queueing for a DB connection (at the
    // ceiling). Sampled by the cost-telemetry background loop.
    const ps = latestPoolStats();
    out.push(line('chatrecall_pg_pool_total', 'pg pool connections open', ps.total));
    out.push(line('chatrecall_pg_pool_idle', 'pg pool connections idle', ps.idle));
    out.push(line('chatrecall_pg_pool_waiting', 'requests waiting for a pg connection — alert if sustained >0', ps.waiting));
  } catch (e) {
    // Surface a scrapeable down-signal instead of a 500 so Prometheus can alert
    // on chatrecall_up==0 rather than a missing target.
    out.length = 0;
    out.push(line('chatrecall_up', '1 when the server can read its database', 0));
    console.error('[metrics] query failed:', e instanceof Error ? e.message : e);
  }

  res.set('Content-Type', 'text/plain; version=0.0.4').send(out.join('\n') + '\n');
});

// Rate-limit cost telemetry summary (JSON): per-class latency percentiles +
// request rate, the noisiest tenants, and pool saturation over a window. This
// is the input for deriving real limits from observed cost/traffic (vs guessed
// constants). Gated by the same METRICS_TOKEN. ?window=<minutes> (default 60).
router.get('/rl-cost', async (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
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
// summaries deployments on PENDING WORK rather than CPU — the right signal for
// bursty multi-tenant load (scale out when a backlog builds, idle back to min
// when drained). Same per-tenant RLS-safe summation as `/`. Unauthenticated by
// default (cluster-internal); gated by METRICS_TOKEN when set.
router.get('/backlog', async (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const pool = await openPgPool(process.env.DATABASE_URL || '');
    const slugs: string[] = (await pool.query('SELECT tenant FROM tenants')).rows.map((r: any) => r.tenant);
    let pendingVectors = 0;
    let pendingSummaries = 0;
    for (const t of slugs) {
      const r = (await tenantQuery(pool, t, `
        SELECT
          (SELECT count(*) FROM memory_chunks c
             LEFT JOIN memory_vectors v ON v.chunk_id = c.chunk_id AND v.tenant = c.tenant
             WHERE c.tenant = $1 AND length(c.text) > 0 AND v.chunk_id IS NULL) AS pending_vectors,
          (SELECT count(*) FROM session_metadata
             WHERE tenant = $1 AND (summary IS NULL OR length(summary) = 0)) AS pending_summaries
      `, [t])).rows[0];
      pendingVectors += Number(r.pending_vectors);
      pendingSummaries += Number(r.pending_summaries);
    }
    res.json({ pendingVectors, pendingSummaries, tenants: slugs.length });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
