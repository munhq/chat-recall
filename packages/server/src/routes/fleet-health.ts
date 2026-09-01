/**
 * GET /api/health/fleet — one place that answers "is chat-recall actually
 * working on my machines?"
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * Every silent failure in this system was found by a human asking about one
 * specific session, then a forensic dig. The reason is that healthy and broken
 * look identical from outside: a sync run prints `15604 skipped` whether the
 * corpus is complete or a third of a session is missing, a daemon running
 * two-day-old code logs nothing unusual, and a transcript folder nobody approved
 * is simply absent from every report.
 *
 * Real cases from 2026-08-02..04, each of which would have been ONE LINE here:
 *   - a laptop's daemon ran stale code for a day after the fix shipped
 *   - a work profile was discovered but never synced; nobody knew it existed
 *   - the field-reconcile batch 500'd on every sync for 13 days
 *   - a session sat 589 records short with its ledger claiming complete
 *
 * So this reports, per device: when we last heard from it, how much it has
 * actually stored, how many transcript folders are syncing versus waiting for a
 * decision, and what CLI it is on — plus explicit WARNINGS, because a number the
 * reader has to interpret is a number that gets skipped.
 *
 * Read-only and cheap: one control-plane query, one aggregate, one settings read.
 */

import express from 'express';
import { createControlPlane, createStore } from '../imports.js';
import { cliRelease } from '../util/cli-release.js';

/**
 * Turn one device's raw facts into health + warnings. PURE and exported so the
 * tests exercise the real logic — an earlier test file re-implemented this in its
 * harness, which meant it could pass while the endpoint was broken.
 */
export function classifyDevice(
  d: { deviceId: string; os: string | null; cliVersion: string | null; lastSeenAt: number | null },
  activity: { sessions: number; lastSyncAt: number } | null,
  reported: ReportedSource[],
  now: number,
  telemetry?: DeviceTelemetry,
  /** The CLI release this server ships, for the version-drift warning. */
  offeredCli?: string | null,
): DeviceHealth {
  const mine = reported.filter((s) => (s.device || '') === d.deviceId);
  const folders = {
    syncing:  mine.filter((s) => s.decision === 'primary' || s.decision === 'approved').length,
    pending:  mine.filter((s) => s.decision === 'pending').length,
    declined: mine.filter((s) => s.decision === 'declined').length,
  };

  const warnings: string[] = [];
  if (folders.pending > 0) {
    const n = mine.filter((s) => s.decision === 'pending').reduce((sum, s) => sum + (s.sessions || 0), 0);
    warnings.push(
      `${folders.pending} transcript folder${folders.pending === 1 ? '' : 's'} waiting for a decision` +
      (n > 0 ? ` (${n} session${n === 1 ? '' : 's'} not being synced)` : ''),
    );
  }
  if (d.lastSeenAt == null) {
    warnings.push('never connected — the collector has not run on this device');
  } else if (now - d.lastSeenAt > STALE_AFTER_MS) {
    warnings.push(`no contact for ${Math.floor((now - d.lastSeenAt) / 86_400_000)} days`);
  }
  // Heard from but storing nothing is a DISTINCT failure from being offline, and
  // the one that looks fine in every other view.
  if (d.lastSeenAt != null && now - d.lastSeenAt <= STALE_AFTER_MS && !activity) {
    warnings.push('connected but has not stored any sessions');
  }
  if (mine.length === 0 && d.lastSeenAt != null) {
    warnings.push('has not reported which transcript folders it can see — CLI may predate folder reporting');
  }

  // ── What only the device knows ──────────────────────────────────────────
  //
  // Each of these completes a sync successfully from the server's point of view,
  // which is why none of them was visible before. Phrased as what is wrong AND
  // what it costs, in the same voice as the warnings above — a number the reader
  // has to interpret is a number that gets skipped.
  if (telemetry) {
    if (telemetry.breakerTrips > 0) {
      // WHICH target, in the only terms this endpoint has: private address or
      // public one. "823 trips" for a LAN box somebody switched off is a very
      // different fact from the same number against the hosted service, and the
      // reader cannot tell them apart from a count.
      const where = telemetry.breakerTripsAllLocal ? 'a sync target on your own network' : 'a sync target';
      const streak = telemetry.worstFailureStreak > 0
        ? ` (worst run: ${telemetry.worstFailureStreak} consecutive failures)` : '';
      warnings.push(
        `stopped trying ${where} ${telemetry.breakerTrips} time${telemetry.breakerTrips === 1 ? '' : 's'} `
        + `after repeated failures${streak} — anything it holds is not reaching that server`,
      );
    }
    const rateLimited = telemetry.failuresByClass.rate_limited ?? 0;
    if (rateLimited > 0) {
      warnings.push(
        `${rateLimited} upload${rateLimited === 1 ? '' : 's'} rate-limited — this device's sync is `
        + 'slower than it needs to be, and a first sync will take much longer',
      );
    }
    const auth = telemetry.failuresByClass.auth ?? 0;
    if (auth > 0) {
      warnings.push(`${auth} upload${auth === 1 ? '' : 's'} rejected for authentication — this device's token may be revoked`);
    }
    // BILLING. This is the one the panel used to hide completely: 270 of these
    // were reported by a device whose only visible warning claimed a TLS problem
    // it did not have. A paused meter is the most actionable condition here —
    // nobody has to debug it, somebody has to decide.
    const payment = telemetry.failuresByClass.payment_required ?? 0;
    if (payment > 0) {
      warnings.push(
        `${payment} upload${payment === 1 ? '' : 's'} refused for billing — that server has paused this `
        + 'tenant\'s sync until the meter resets or the plan changes',
      );
    }
    const transport = telemetry.failuresByClass.insecure_transport ?? 0;
    if (transport > 0) {
      warnings.push('refusing to sync to a server over plain HTTP — nothing from this device is reaching it');
    }
    // A class nobody wrote a sentence for must still be visible. Every class
    // above was added after a silent failure was found by hand; this line is so
    // the NEXT one does not need that.
    const NAMED = new Set(['rate_limited', 'auth', 'payment_required', 'insecure_transport']);
    const others = Object.entries(telemetry.failuresByClass)
      .filter(([cls, n]) => n > 0 && !NAMED.has(cls))
      .sort((a, b) => b[1] - a[1]);
    if (others.length > 0) {
      warnings.push(
        `${others.map(([cls, n]) => `${n}× ${cls.replace(/_/g, ' ')}`).join(', ')} — `
        + 'sync attempts this device could not complete',
      );
    }
    if (telemetry.oversizedSessions > 0) {
      warnings.push(
        `${telemetry.oversizedSessions} session${telemetry.oversizedSessions === 1 ? '' : 's'} too large to archive `
        + `(largest ${telemetry.oversizedWorstMb}MB) — searchable, but their raw transcript is not stored`,
      );
    }
    if (telemetry.autoUpdateProblems > 0) {
      warnings.push(
        `self-update did not run ${telemetry.autoUpdateProblems} time${telemetry.autoUpdateProblems === 1 ? '' : 's'} `
        + '— this device cannot pick up fixes on its own',
      );
    }
  }
  // VERSION DRIFT, the failure that hides behind every other one: a device
  // running old code has already missed whatever the newer releases fixed, and
  // no amount of correct telemetry from it can say so. Compared against what
  // THIS server ships, which is the version the device would install.
  if (d.cliVersion && offeredCli && compareCliVersions(d.cliVersion, offeredCli) < 0) {
    warnings.push(
      `on CLI ${d.cliVersion} while this server ships ${offeredCli} — this device is not `
      + 'running the current collector',
    );
  }

  return {
    deviceId: d.deviceId,
    os: d.os,
    cliVersion: d.cliVersion,
    lastSeenAt: d.lastSeenAt,
    lastSyncAt: activity?.lastSyncAt ?? null,
    sessions: activity?.sessions ?? 0,
    folders,
    warnings,
    ...(telemetry ? { telemetry } : {}),
  };
}

/**
 * Compare two dotted release numbers. -1 / 0 / 1, numeric per segment.
 *
 * Deliberately small and local: the only versions it ever sees are this
 * product's own `major.minor.patch`, and a string compare gets 0.5.9 vs 0.5.30
 * wrong — which is exactly the drift this is here to catch. A non-numeric
 * segment (a `-rc1` suffix, a `dev` build) compares as 0, so an unparseable
 * version never produces a false warning.
 */
export function compareCliVersions(a: string, b: string): number {
  const seg = (v: string): number[] => v.trim().replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const [x, y] = [seg(a), seg(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** How far back a device's self-reported telemetry is worth believing. */
const TELEMETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-device collector telemetry from client_events.
 *
 * One query, grouped in SQL, because a busy tenant has tens of thousands of rows
 * and the interesting values are counts and maxima rather than the rows.
 */
async function collectorTelemetryByDevice(tenant: string): Promise<Map<string, DeviceTelemetry>> {
  const { openPgPool, tenantQuery } = await import('@chat-recall/engine/core/store/pg-pool.js');
  const pool = await openPgPool();
  const since = Date.now() - TELEMETRY_WINDOW_MS;
  const out = new Map<string, DeviceTelemetry>();

  const rows = await tenantQuery(pool, tenant, `
    SELECT device_id,
           count(*) FILTER (WHERE kind = 'breaker_trip')::int        AS breaker_trips,
           -- The collector reports local:1 for a private/LAN target. Counting the
           -- trips that were NOT local is what lets the warning say "a server on
           -- your own network" instead of implying the whole fleet is down.
           count(*) FILTER (WHERE kind = 'breaker_trip'
                              AND COALESCE(data->>'local','0') <> '1')::int
                                                                     AS breaker_trips_remote,
           count(*) FILTER (WHERE kind IN ('auto_update_failed','auto_update_skipped'))::int
                                                                     AS auto_update_problems,
           -- DISTINCT SESSIONS, not events. This repeats on every walk while a
           -- transcript stays oversized, so count(*) reported one 117MB session
           -- as 38 of them, and the reader concluded 38 transcripts were losing
           -- their archive.
           --
           -- dedupeKey is a non-reversible per-session mark. A collector that
           -- predates it sends none, and those rows fall back to size+tool: two
           -- reports of a 117MB OpenCode session are one session far more often
           -- than they are two. That fallback can UNDERCOUNT two genuinely
           -- same-size sessions, which is the right way round to be wrong here —
           -- the warning's job is "some transcripts are not archived, the worst
           -- is 117MB", and a 38x overcount got that fact wrong.
           count(DISTINCT COALESCE(
                   data->>'dedupeKey',
                   COALESCE(data->>'mb','?') || ':' || COALESCE(tool,'')))
             FILTER (WHERE kind = 'oversized_session')::int          AS oversized,
           max((data->>'mb')::int) FILTER (WHERE kind = 'oversized_session') AS oversized_worst_mb,
           max((data->>'rssPeakMb')::int) FILTER (WHERE kind = 'sync_walk')  AS rss_peak_mb,
           (array_agg((data->>'scanMs')::int ORDER BY ts DESC)
              FILTER (WHERE kind = 'sync_walk' AND data ? 'scanMs'))[1]      AS last_scan_ms
      FROM client_events
     WHERE tenant = $1 AND ts >= $2 AND device_id <> ''
     GROUP BY device_id
  `, [tenant, since]);

  for (const r of rows.rows as Array<Record<string, unknown>>) {
    out.set(String(r.device_id), {
      breakerTrips: Number(r.breaker_trips) || 0,
      failuresByClass: {},
      worstFailureStreak: 0,
      breakerTripsAllLocal: (Number(r.breaker_trips) || 0) > 0
        && (Number(r.breaker_trips_remote) || 0) === 0,
      autoUpdateProblems: Number(r.auto_update_problems) || 0,
      oversizedSessions: Number(r.oversized) || 0,
      oversizedWorstMb: Number(r.oversized_worst_mb) || 0,
      rssPeakMb: r.rss_peak_mb == null ? null : Number(r.rss_peak_mb),
      lastScanMs: r.last_scan_ms == null ? null : Number(r.last_scan_ms),
      recentScanMs: Array.isArray(r.recent_scan_ms)
        ? (r.recent_scan_ms as unknown[]).map(Number).filter((n) => Number.isFinite(n)).reverse()
        : [],
    });
  }

  // Failure classes are a second grouping (by device AND class), so they are
  // fetched separately rather than pivoted into fixed columns — the set of
  // classes grows, and a column per class would need a migration to learn one.
  const byClass = await tenantQuery(pool, tenant, `
    SELECT device_id,
           COALESCE(NULLIF(data->>'errorClass',''), 'other') AS error_class,
           count(*)::int AS n,
           -- The streak is where the severity lives: 828 trips against one target
           -- with a run of 109 consecutive failures is ONE box that is off, and a
           -- count on its own cannot say that.
           max((data->>'failures')::int) AS streak
      FROM client_events
     WHERE tenant = $1 AND ts >= $2 AND device_id <> ''
       AND kind IN ('target_failure','breaker_trip','sync_error','auth_error')
     GROUP BY device_id, error_class
  `, [tenant, since]);

  for (const r of byClass.rows as Array<Record<string, unknown>>) {
    const id = String(r.device_id);
    const entry = out.get(id) ?? {
      breakerTrips: 0, failuresByClass: {}, worstFailureStreak: 0, breakerTripsAllLocal: false,
      autoUpdateProblems: 0, oversizedSessions: 0,
      oversizedWorstMb: 0, rssPeakMb: null, lastScanMs: null, recentScanMs: [],
    };
    entry.failuresByClass[String(r.error_class)] = Number(r.n) || 0;
    entry.worstFailureStreak = Math.max(entry.worstFailureStreak, Number(r.streak) || 0);
    out.set(id, entry);
  }

  return out;
}

/**
 * Fleet-wide shape, not per device: the numbers that answer "how long does a
 * sync take for a real customer" rather than "how is this laptop".
 *
 * These lived briefly on a separate /api/client-events/health endpoint that
 * nothing ever called — built before I noticed FleetHealth already owned this
 * question. Unused endpoints rot, so the aggregate moved into the route the UI
 * actually fetches and the endpoint was deleted.
 */
export interface FleetTelemetrySummary {
  walks: number;
  scanMsP50: number | null;
  scanMsP95: number | null;
  rssPeakMbMax: number | null;
  /** CLI versions in use, most-deployed first. */
  versions: Array<{ version: string; devices: number }>;
}

async function fleetTelemetrySummary(tenant: string): Promise<FleetTelemetrySummary | null> {
  try {
    const { openPgPool, tenantQuery } = await import('@chat-recall/engine/core/store/pg-pool.js');
    const pool = await openPgPool();
    const since = Date.now() - TELEMETRY_WINDOW_MS;
    const agg = await tenantQuery(pool, tenant, `
      SELECT count(*)::int AS walks,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY (data->>'scanMs')::int)  AS p50,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY (data->>'scanMs')::int) AS p95,
             max((data->>'rssPeakMb')::int) AS rss_max
        FROM client_events
       WHERE tenant=$1 AND ts >= $2 AND kind='sync_walk' AND data ? 'scanMs'
    `, [tenant, since]);
    const versions = await tenantQuery(pool, tenant, `
      SELECT cli_version, count(DISTINCT device_id)::int AS devices
        FROM client_events
       WHERE tenant=$1 AND ts >= $2 AND cli_version <> ''
       GROUP BY cli_version ORDER BY devices DESC LIMIT 10
    `, [tenant, since]);
    const r = agg.rows[0] as Record<string, unknown> | undefined;
    if (!r || Number(r.walks) === 0) return null;
    return {
      walks: Number(r.walks) || 0,
      scanMsP50: r.p50 == null ? null : Number(r.p50),
      scanMsP95: r.p95 == null ? null : Number(r.p95),
      rssPeakMbMax: r.rss_max == null ? null : Number(r.rss_max),
      versions: (versions.rows as Array<Record<string, unknown>>)
        .map((v) => ({ version: String(v.cli_version), devices: Number(v.devices) || 0 })),
    };
  } catch {
    return null;   // no telemetry reported, or a schema without `data`
  }
}

const router = express.Router();

/** A device is stale when we have not heard from it in this long. Chosen to be
 *  well beyond the 15-minute heartbeat plus a laptop being shut for a weekend,
 *  so a warning means something rather than crying wolf on a Monday. */
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

interface ReportedSource {
  id: string; tool: string; path: string; sessions: number;
  isPrimary?: boolean; decision?: string; device?: string;
}

/**
 * What a device's own collector reported about itself, from client_events.
 *
 * Everything above is what the SERVER can see about a device. This is what only
 * the device knows: that its uploads are being rate-limited, that a sync target
 * has been failing long enough to be skipped, that sessions are too large to
 * archive. Those are invisible from the server side — the walk still completes,
 * rows still arrive — which is exactly the class of silent failure this endpoint
 * exists to surface.
 */
export interface DeviceTelemetry {
  /**
   * Breaker INCIDENTS in the window — a target going from working to given up
   * on. Not attempts: the collector re-opens a tripped breaker on every walk, so
   * counting those measured how long a box stayed off, not how often anything
   * broke. See BreakerVerdict.tripped in the collector.
   */
  breakerTrips: number;
  /** Individual target failures, by class (rate_limited, dns, timeout, …). */
  failuresByClass: Record<string, number>;
  /** Longest run of consecutive failures the device reported for one target. */
  worstFailureStreak: number;
  /**
   * True when every breaker trip in the window was against a private/LAN address.
   *
   * The difference between "your laptop cannot reach the hosted service" and
   * "the box in your study is switched off", which a count alone cannot express.
   *
   * Scoped to the TRIPS on purpose. Computed across all failure kinds instead, a
   * single stray failure against a public host — one in a thousand, on a device
   * whose 828 trips were every one of them a LAN box — flipped it to false and
   * took the useful half of the sentence with it.
   */
  breakerTripsAllLocal: boolean;
  /** Times the collector's self-update failed or was refused in the window. */
  autoUpdateProblems: number;
  /** DISTINCT sessions skipped from the raw archive for exceeding the ceiling. */
  oversizedSessions: number;
  /** Largest such session, in MB — how far past the ceiling this device goes. */
  oversizedWorstMb: number;
  /** Peak RSS the collector reported, MB. */
  rssPeakMb: number | null;
  /** Most recent walk's scan time, ms. */
  lastScanMs: number | null;
  /**
   * The last few walks' scan times, OLDEST FIRST, for a trend.
   *
   * A single current value cannot answer the question a reader actually has —
   * "is this getting worse?" — and p50/p95 across the fleet cannot answer it for
   * ONE machine. Twelve points is the stat-tile sparkline length; ordered for
   * drawing so the UI does no reversing.
   */
  recentScanMs: number[];
}

export interface DeviceHealth {
  deviceId: string;
  os: string | null;
  cliVersion: string | null;
  lastSeenAt: number | null;
  /** Newest session this device has stored, which is the real "is data arriving". */
  lastSyncAt: number | null;
  sessions: number;
  folders: { syncing: number; pending: number; declined: number };
  /** Plain-language problems, most important first. Empty means healthy. */
  warnings: string[];
  /** Present only when the device reported telemetry (paid plan + consent). */
  telemetry?: DeviceTelemetry;
}

router.get('/fleet', async (req, res) => {
  const tenant = (req as any).tenant || process.env.CHAT_RECALL_TENANT || 'default';
  const cp = await createControlPlane();
  const store = await createStore();
  try {
    const [devices, activity, sourcesRaw, telemetry, fleetTelemetry] = await Promise.all([
      cp.listAgentTokens(tenant),
      store.sessionCountsByDevice?.() ?? Promise.resolve([]),
      cp.getTenantSetting(tenant, 'sync_sources'),
      // Best-effort: a tenant on a free plan reports none, and a server whose
      // schema predates the `data` column has nothing to read. Neither is an
      // error — the panel simply shows what the server can see on its own, which
      // is what it showed before this existed.
      collectorTelemetryByDevice(tenant).catch(() => new Map<string, DeviceTelemetry>()),
      fleetTelemetrySummary(tenant),
    ]);

    let reported: ReportedSource[] = [];
    if (sourcesRaw) { try { reported = JSON.parse(sourcesRaw) || []; } catch { /* corrupt → none */ } }
    if (!Array.isArray(reported)) reported = [];

    const byDevice = new Map<string, { sessions: number; lastSyncAt: number }>();
    for (const row of activity as Array<{ device: string | null; sessions: number; lastIndexedAt: number }>) {
      if (row.device) byDevice.set(row.device, { sessions: row.sessions, lastSyncAt: row.lastIndexedAt });
    }

    const now = Date.now();
    const live = devices.filter((d) => !d.revoked);
    // What this server ships is what a device would install, so it is the right
    // yardstick for "is this machine current" — not the newest version any
    // device happens to report, which drifts with whoever updated by hand.
    const offeredCli = cliRelease()?.version ?? null;
    const out: DeviceHealth[] = live.map((d) =>
      classifyDevice(d, byDevice.get(d.deviceId) ?? null, reported, now, telemetry.get(d.deviceId), offeredCli));

    out.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));

    res.json({
      devices: out,
      summary: {
        devices: out.length,
        healthy: out.filter((d) => d.warnings.length === 0).length,
        needsAttention: out.filter((d) => d.warnings.length > 0).length,
        pendingFolders: out.reduce((n, d) => n + d.folders.pending, 0),
        // Sessions with no device attribution: the pre-attribution backlog. Shown
        // so a big number here is not mistaken for a device having lost data.
        unattributedSessions: (activity as Array<{ device: string | null; sessions: number }>)
          .filter((r) => !r.device).reduce((n, r) => n + r.sessions, 0),
      },
      // Null when no device has reported telemetry — a free plan, opted out, or
      // an older CLI. The panel omits the row rather than showing zeros.
      fleetTelemetry,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'fleet health failed' });
  } finally {
    await store.close();
    await cp.close?.();
  }
});

export default router;
