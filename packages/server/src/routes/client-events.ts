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
import { isEntitled } from '../util/billing.js';

const router = express.Router();
const MAX_BATCH = 50;
const clip = (s: unknown, n: number): string => (typeof s === 'string' ? s.slice(0, n) : '');

interface InEvent {
  ts?: number; kind?: string; tool?: string;
  cliVersion?: string; os?: string; deviceId?: string; message?: string;
  /** Anything else on the event is a measurement — see `measurements()`. */
  [k: string]: unknown;
}

/** Known non-measurement fields, so everything else can be kept generically. */
const ENVELOPE = new Set(['ts', 'kind', 'tool', 'cliVersion', 'os', 'deviceId', 'message']);

/**
 * The event's numeric/boolean measurements, bounded and type-checked.
 *
 * Strings are DROPPED rather than stored: the collector sends only numbers plus
 * a couple of enumerated classes, so a string arriving here is either a bug or
 * an attempt to smuggle free text into a channel that promises not to carry it.
 * The one exception is a short enum-shaped value (error class, tool), which is
 * length-capped.
 */
function measurements(e: InEvent): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(e)) {
    if (ENVELOPE.has(k) || n >= 32) continue;
    if (typeof v === 'number' && Number.isFinite(v)) { out[k] = v; n++; }
    else if (typeof v === 'boolean') { out[k] = v; n++; }
    else if (typeof v === 'string' && v.length <= 40) { out[k] = v; n++; }
  }
  return out;
}

// POST /api/client-events  { events: [{ kind, ts?, tool?, cliVersion?, os?, deviceId?, message? }] }
router.post('/', async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  // PAYING TENANTS ONLY, enforced HERE and not merely requested of the client.
  //
  // The collector also gates itself (telemetry-consent.ts) so a free tenant's
  // data never leaves the machine, but that is an optimisation: the client is
  // software on someone else's computer and cannot be the boundary. A free or
  // lapsed tenant's events are dropped with 204 rather than 402 — this is
  // fire-and-forget telemetry, and an error would make a collector log a failure
  // about failing to report failures.
  if (!(await isEntitled(tenant))) return res.status(204).end();
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
        `INSERT INTO client_events (tenant, ts, kind, tool, cli_version, os, device_id, message, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenant, Number(e?.ts) || Date.now(), kind, clip(e?.tool, 64),
         clip(e?.cliVersion, 32), clip(e?.os, 32), clip(authDevice, 64) || clip(e?.deviceId, 64), clip(e?.message, 2000),
         JSON.stringify(measurements(e))],
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

/**
 * GET /api/client-events/health — one aggregate answering "are my collectors
 * healthy", per DEVICE.
 *
 * The raw event list answers "what happened"; this answers the question a human
 * actually opens the page with. Aggregated in SQL rather than shipped raw and
 * reduced in the browser, because a busy tenant has tens of thousands of rows
 * and the interesting numbers are per-device latests and per-class counts.
 *
 * `since` bounds the window (default 24h) so the query stays on the
 * (tenant, ts DESC) index instead of scanning a tenant's whole history.
 */
router.get('/health', async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  const hours = Math.min(24 * 30, Math.max(1, parseInt(String(req.query.hours ?? '24'), 10) || 24));
  const since = Date.now() - hours * 3600_000;
  try {
    const pool = await openPgPool();

    // Latest state per device: the most recent sync_walk, plus its version/OS.
    const devices = await tenantQuery(pool, tenant, `
      SELECT DISTINCT ON (device_id)
             device_id, ts, cli_version, os,
             (data->>'uploaded')::int   AS uploaded,
             (data->>'skipped')::int    AS skipped,
             (data->>'scanned')::int    AS scanned,
             (data->>'scanMs')::int     AS scan_ms,
             (data->>'rssPeakMb')::int  AS rss_peak_mb,
             (data->>'failedTargets')::int AS failed_targets
        FROM client_events
       WHERE tenant=$1 AND ts >= $2 AND kind = 'sync_walk'
       ORDER BY device_id, ts DESC
    `, [tenant, since]);

    // Fleet shape, not just latests: a median and a worst case are what make
    // "how long does a sync take for a real customer" answerable — the question
    // that previously had to be answered from one developer's laptop.
    const fleet = await tenantQuery(pool, tenant, `
      SELECT count(*)::int AS walks,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY (data->>'scanMs')::int)  AS scan_ms_p50,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY (data->>'scanMs')::int) AS scan_ms_p95,
             max((data->>'rssPeakMb')::int) AS rss_peak_mb_max,
             sum((data->>'uploaded')::int)::int AS uploaded_total
        FROM client_events
       WHERE tenant=$1 AND ts >= $2 AND kind = 'sync_walk' AND data ? 'scanMs'
    `, [tenant, since]);

    // Failure shape over the window. `message` carries the error CLASS for
    // failure kinds (never a raw message — the collector classifies before
    // sending), so grouping on it is safe and is the useful axis.
    const failures = await tenantQuery(pool, tenant, `
      SELECT kind, COALESCE(NULLIF(data->>'errorClass',''), NULLIF(message,''), 'unknown') AS error_class, count(*)::int AS n
        FROM client_events
       WHERE tenant=$1 AND ts >= $2
         AND kind IN ('breaker_trip','target_failure','sync_error','mcp_crash','auth_error','index_failed')
       GROUP BY kind, error_class
       ORDER BY n DESC
       LIMIT 40
    `, [tenant, since]);

    // Sessions the size ceiling caught — the population that used to OOM a walk.
    const oversized = await tenantQuery(pool, tenant, `
      SELECT tool, count(*)::int AS n, max((data->>'mb')::int) AS worst_mb
        FROM client_events
       WHERE tenant=$1 AND ts >= $2 AND kind = 'oversized_session'
       GROUP BY tool ORDER BY n DESC LIMIT 10
    `, [tenant, since]);

    const versions = await tenantQuery(pool, tenant, `
      SELECT cli_version, count(DISTINCT device_id)::int AS devices
        FROM client_events
       WHERE tenant=$1 AND ts >= $2 AND cli_version <> ''
       GROUP BY cli_version ORDER BY devices DESC LIMIT 10
    `, [tenant, since]);

    // Live walk progress, if a collector is mid-walk right now. Same source and
    // staleness rule the TopBar uses, so the two surfaces cannot disagree.
    let progress: { done: number; total: number } | null = null;
    try {
      const { createStore } = await import('../imports.js');
      const store = await createStore();
      try {
        const entry = await store.kvGet('collector', 'walk_progress');
        const raw = typeof entry === 'string' ? entry : (entry as { value?: string } | null)?.value;
        if (raw) {
          const pr = JSON.parse(raw) as { done: number; total: number; complete: boolean; at: number };
          if (!pr.complete && pr.total > 0 && Date.now() - pr.at < 10 * 60_000) {
            progress = { done: pr.done, total: pr.total };
          }
        }
      } finally { await store.close(); }
    } catch { /* progress is optional */ }

    res.json({
      windowHours: hours,
      fleet: fleet.rows[0] ?? null,
      devices: devices.rows,
      failures: failures.rows,
      oversized: oversized.rows,
      versions: versions.rows,
      progress,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'collector health failed' });
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
