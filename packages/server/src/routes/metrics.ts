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
  } catch (e) {
    // Surface a scrapeable down-signal instead of a 500 so Prometheus can alert
    // on chatrecall_up==0 rather than a missing target.
    out.length = 0;
    out.push(line('chatrecall_up', '1 when the server can read its database', 0));
    console.error('[metrics] query failed:', e instanceof Error ? e.message : e);
  }

  res.set('Content-Type', 'text/plain; version=0.0.4').send(out.join('\n') + '\n');
});

export default router;
