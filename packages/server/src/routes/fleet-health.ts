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

  return {
    deviceId: d.deviceId,
    os: d.os,
    cliVersion: d.cliVersion,
    lastSeenAt: d.lastSeenAt,
    lastSyncAt: activity?.lastSyncAt ?? null,
    sessions: activity?.sessions ?? 0,
    folders,
    warnings,
  };
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
}

router.get('/fleet', async (req, res) => {
  const tenant = (req as any).tenant || process.env.CHAT_RECALL_TENANT || 'default';
  const cp = await createControlPlane();
  const store = await createStore();
  try {
    const [devices, activity, sourcesRaw] = await Promise.all([
      cp.listAgentTokens(tenant),
      store.sessionCountsByDevice?.() ?? Promise.resolve([]),
      cp.getTenantSetting(tenant, 'sync_sources'),
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
    const out: DeviceHealth[] = live.map((d) =>
      classifyDevice(d, byDevice.get(d.deviceId) ?? null, reported, now));

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
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'fleet health failed' });
  } finally {
    await store.close();
    await cp.close?.();
  }
});

export default router;
