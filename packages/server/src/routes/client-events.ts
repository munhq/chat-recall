/**
 * Client failure/health telemetry.
 *
 * Collectors + the MCP POST redacted failure events here — mcp_crash,
 * sync_error, auth_error, tool_error, index_failed, etc. — so the operator can
 * SEE when a customer's recall breaks instead of waiting to be told. The tenant
 * comes from the authenticated request (tenantAuth); nothing crosses tenants.
 * On the SaaS this gives per-customer failure visibility; on self-host it stays
 * on the operator's own server. No transcript content or file paths — just the
 * error class + a redacted message + CLI/OS/version.
 */
import express from 'express';
import { openPgPool, tenantQuery } from '@chat-recall/engine/core/store/pg-pool.js';

const router = express.Router();
const MAX_BATCH = 50;
const clip = (s: unknown, n: number): string => (typeof s === 'string' ? s.slice(0, n) : '');

interface InEvent {
  ts?: number; kind?: string; tool?: string;
  cliVersion?: string; os?: string; deviceId?: string; message?: string;
}

// POST /api/client-events  { events: [{ kind, ts?, tool?, cliVersion?, os?, deviceId?, message? }] }
router.post('/', async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  const events: InEvent[] = Array.isArray(req.body?.events) ? req.body.events.slice(0, MAX_BATCH) : [];
  if (!events.length) return res.json({ ok: true, ingested: 0 });
  // The client can't know its own device id — the id lives on the token, which
  // only the server can resolve. Stamp it here from the authenticated identity
  // (`device:<id>`), and prefer it over anything the body claims: every event
  // ingested before this was attributed to nobody, which made the whole table
  // useless for answering "which machine is broken?".
  const authDevice = req.authorDevice || (req.userId?.startsWith('device:') ? req.userId.slice('device:'.length) : '');
  try {
    const pool = await openPgPool();
    let n = 0;
    for (const e of events) {
      const kind = clip(e?.kind, 64);
      if (!kind) continue;
      await tenantQuery(
        pool, tenant,
        `INSERT INTO client_events (tenant, ts, kind, tool, cli_version, os, device_id, message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenant, Number(e?.ts) || Date.now(), kind, clip(e?.tool, 64),
         clip(e?.cliVersion, 32), clip(e?.os, 32), clip(authDevice, 64) || clip(e?.deviceId, 64), clip(e?.message, 2000)],
      );
      n++;
    }
    res.json({ ok: true, ingested: n });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'client-events ingest failed' });
  }
});

// GET /api/client-events?limit=&kind=  — recent events for this tenant (operator view)
router.get('/', async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '100'), 10) || 100));
  const kind = typeof req.query.kind === 'string' ? req.query.kind : null;
  try {
    const pool = await openPgPool();
    const sql =
      `SELECT ts, kind, tool, cli_version, os, device_id, message
         FROM client_events WHERE tenant=$1 ${kind ? 'AND kind=$2' : ''}
        ORDER BY ts DESC LIMIT ${limit}`;
    const r = await tenantQuery(pool, tenant, sql, kind ? [tenant, kind] : [tenant]);
    res.json({ events: r.rows });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'client-events list failed' });
  }
});

// DELETE /api/client-events?kind=<kind>  — purge this tenant's events of one
// kind (e.g. test/validation rows). Requires an explicit kind so a stray call
// can't wipe the whole log.
router.delete('/', async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  const kind = typeof req.query.kind === 'string' ? req.query.kind : '';
  if (!kind) return res.status(400).json({ error: 'kind query param required (refusing to wipe all events)' });
  try {
    const pool = await openPgPool();
    const r = await tenantQuery(pool, tenant, `DELETE FROM client_events WHERE tenant=$1 AND kind=$2`, [tenant, kind]);
    res.json({ ok: true, deleted: r.rowCount ?? 0 });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'client-events delete failed' });
  }
});

export default router;
