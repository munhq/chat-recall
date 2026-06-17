/**
 * Platform-operator admin surface (P1-10).
 *
 * Unlike the Prometheus `/metrics` endpoint (machine scrape, token-gated, plain
 * text), this is the human-facing admin view: a logged-in operator with the
 * Keycloak `chat-recall-admin` realm role gets a JSON breakdown of every
 * tenant's footprint. On self-host it falls back to the `ADMIN_KEY` header.
 *
 * Mounted at `/api/admin` BEFORE tenantAuth — it is deliberately cross-tenant,
 * so it must NOT run inside a single tenant's RLS context. Each per-tenant count
 * is taken INSIDE that tenant's RLS context (tenantQuery) AND filtered on
 * `tenant=$1`, identical to routes/metrics.ts, so the totals are correct on both
 * the RLS cloud and non-RLS self-host.
 */
import express from 'express';
import { openPgPool, tenantQuery } from '@chat-recall/engine/core/store/pg-pool.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

interface TenantRow {
  tenant: string;
  sessions: number;
  chunks: number;
  raw: number;
  findings: number;
  verified: number;
}

// GET /api/admin/metrics — per-tenant footprint + totals, for the admin UI.
router.get('/metrics', async (req, res) => {
  if (!(await requireAdmin(req, res))) return; // 401/403 already sent
  try {
    const pool = await openPgPool(process.env.DATABASE_URL || '');
    const slugs: string[] = (await pool.query('SELECT tenant FROM tenants')).rows.map((r: any) => r.tenant);

    const tenants: TenantRow[] = [];
    for (const t of slugs) {
      const r = (await tenantQuery(pool, t, `
        SELECT
          (SELECT count(*) FROM memory_metadata WHERE tenant=$1 AND source_type='session') AS sessions,
          (SELECT count(*) FROM memory_chunks   WHERE tenant=$1) AS chunks,
          (SELECT count(*) FROM raw_sessions    WHERE tenant=$1) AS raw,
          (SELECT count(*) FROM secret_findings WHERE tenant=$1) AS findings,
          (SELECT count(*) FROM secret_findings WHERE tenant=$1 AND verified=1) AS verified
      `, [t])).rows[0];
      tenants.push({
        tenant: t,
        sessions: Number(r.sessions),
        chunks: Number(r.chunks),
        raw: Number(r.raw),
        findings: Number(r.findings),
        verified: Number(r.verified),
      });
    }

    const totals = tenants.reduce(
      (acc, t) => ({
        tenants: acc.tenants + 1,
        sessions: acc.sessions + t.sessions,
        chunks: acc.chunks + t.chunks,
        raw: acc.raw + t.raw,
        findings: acc.findings + t.findings,
        verified: acc.verified + t.verified,
      }),
      { tenants: 0, sessions: 0, chunks: 0, raw: 0, findings: 0, verified: 0 },
    );

    res.json({ totals, tenants });
  } catch (e) {
    console.error('[admin/metrics] query failed:', e instanceof Error ? e.message : e);
    res.status(500).json({ error: 'admin metrics query failed' });
  }
});

export default router;
