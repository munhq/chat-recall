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
import { openPgPool } from '@chat-recall/engine/core/store/pg-pool.js';

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
    const count = async (sql: string): Promise<number> =>
      Number((await pool.query(sql)).rows[0]?.c ?? 0);

    // Server-wide totals (across all tenants). Cheap COUNTs on indexed tables.
    const [sessions, chunks, raw, findings, verified, tenants] = await Promise.all([
      count("SELECT count(*) c FROM memory_metadata WHERE source_type='session'"),
      count('SELECT count(*) c FROM memory_chunks'),
      count('SELECT count(*) c FROM raw_sessions'),
      count('SELECT count(*) c FROM secret_findings'),
      count('SELECT count(*) c FROM secret_findings WHERE verified = 1'),
      count('SELECT count(*) c FROM tenants'),
    ]);

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
