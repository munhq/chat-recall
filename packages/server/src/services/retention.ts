/**
 * Retention sweep for SYNTHETIC tenants (healthchecks / probes).
 *
 * The sync healthcheck tenant ('synccheck') pushes real session envelopes to
 * prove the ingest path end-to-end — but nothing ever deleted them, so probe
 * data accumulated without bound (measured: 15k sessions / 2.5 GB in 12 days
 * on the shared 10 Gi PVC that has already had one WAL-fill outage). This
 * sweep purges synthetic-tenant sessions older than a short window so the
 * healthcheck keeps proving syncs work while its footprint stays flat.
 *
 * NEVER runs against real tenants: the tenant list is an explicit allowlist
 * (SYNTHETIC_TENANTS, default 'synccheck'), not a pattern match.
 */
import { runWithTenant } from '@chat-recall/engine/core/store/tenant-context.js';
import { createStore, createControlPlane } from '../imports.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { billingEnabled } from '../util/billing.js';

const log = createLogger('retention');

export function syntheticTenants(): string[] {
  return (process.env.SYNTHETIC_TENANTS ?? 'synccheck')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}

function retentionMs(): number {
  const days = Number(process.env.SYNTHETIC_RETENTION_DAYS) || 7;
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Purge synthetic-tenant sessions whose mtime is older than the retention
 * window. Bounded per tick (default 500/tenant) so a large first run drains
 * over a few sweeps instead of holding long transactions. No tombstones:
 * probe sessions get fresh ids each run, and if one ever re-syncs the next
 * sweep purges it again — cheaper than growing session_tombstones forever.
 */
export async function sweepSyntheticRetention(
  opts: { batchPerTenant?: number } = {},
): Promise<Array<{ tenant: string; purged: number }>> {
  const batch = opts.batchPerTenant ?? 500;
  const cutoff = Date.now() - retentionMs();
  const results: Array<{ tenant: string; purged: number }> = [];

  for (const tenant of syntheticTenants()) {
    const purged = await runWithTenant(tenant, async () => {
      const store = await createStore();
      let count = 0;
      try {
        // listItems orders by mtime DESC, so stale rows form a contiguous
        // SUFFIX: skip forward over the (small) fresh prefix, then purge in
        // place — purged rows vanish from the ordering and the remaining
        // suffix slides up to the same offset, so we re-fetch without
        // advancing. Guarded by a hard iteration cap in case a purge ever
        // fails to remove the metadata row (never spin forever).
        let offset = 0;
        const PAGE = 200;
        let guard = Math.ceil(batch / PAGE) + 100;
        while (count < batch && guard-- > 0) {
          const page = await store.listItems('session', PAGE, offset);
          if (page.length === 0) break;
          const stale = page.filter(r => (r.mtime ?? 0) < cutoff);
          if (stale.length === 0) {
            if (page.length < PAGE) break; // end reached, nothing stale
            offset += page.length; // fresh prefix — skip ahead
            continue;
          }
          for (const row of stale) {
            if (count >= batch) break;
            await store.purgeSession(row.id);
            count++;
          }
        }
      } finally {
        await store.close();
      }
      return count;
    });
    if (purged > 0) log.info({ tenant, purged, cutoff }, 'synthetic retention purge');
    results.push({ tenant, purged });
  }
  return results;
}


// ── Lapsed-tenant deletion ──────────────────────────────────────────────────
//
// Storing someone's complete AI coding transcripts indefinitely after they have
// stopped paying is a LIABILITY, not an asset: it is breach exposure and a data
// protection obligation carried for nothing. Cost is not the argument — the
// heaviest measured tenant is ~3 GB, well under a dollar a month.
//
// DISABLED unless LAPSED_RETENTION_DAYS is set to a positive number. This code
// deletes real customers' data, so shipping it must not start deleting anything;
// turning it on is a deliberate act with a number attached.
//
// What it will not touch:
//   - 'past_due' — Stripe is still retrying the card. Dunning runs for weeks and
//     an expired card is not a decision to leave.
//   - anything inside the window, obviously.
//   - a tenant whose period end is null (open-ended grants, self-host).

/** Days after lapse before data is deleted. 0 / unset ⇒ the sweep does nothing. */
export function lapsedRetentionDays(): number {
  const n = Number(process.env.LAPSED_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Report only, deleting nothing, unless LAPSED_RETENTION_APPLY=1. */
export function lapsedRetentionApplies(): boolean {
  return process.env.LAPSED_RETENTION_APPLY === '1';
}

export interface LapsedSweepResult {
  /** Null when the sweep is switched off entirely. */
  cutoff: number | null;
  dryRun: boolean;
  tenants: Array<{ tenant: string; status: string; lapsedAt: number; sessions: number; purged: number }>;
}

/**
 * Purge sessions for tenants that lapsed more than the retention window ago.
 *
 * Two switches, on purpose. LAPSED_RETENTION_DAYS arms it; LAPSED_RETENTION_APPLY
 * makes it actually delete. Without the second it walks the same tenants, counts
 * exactly what it WOULD remove, and logs that — so the first thing an operator
 * sees is a number they can sanity-check, not a hole where data used to be.
 */
export async function sweepLapsedRetention(
  opts: { batchPerTenant?: number; maxTenants?: number; now?: number } = {},
): Promise<LapsedSweepResult> {
  // NEVER on a self-hosted install. "Lapsed" is a billing state, and where there
  // is no billing there is no such state: isEntitled() returns true for everyone,
  // so nobody there owes anything and nobody's access has ended.
  //
  // This is not a theoretical guard. A self-hoster running with auth enabled who
  // opens the account page has ensureTrial() write a `trialing` row with a 7-day
  // period — harmless, because the gate ignores it. Thirty-seven days later that
  // row matches listLapsedTenants() exactly, and an operator who set
  // LAPSED_RETENTION_DAYS would have their own server delete their own history
  // on their own hardware. The env var alone made that only accidentally
  // impossible; this makes it structurally impossible.
  if (!billingEnabled()) return { cutoff: null, dryRun: true, tenants: [] };

  const days = lapsedRetentionDays();
  if (days <= 0) return { cutoff: null, dryRun: true, tenants: [] };

  const now = opts.now ?? Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const dryRun = !lapsedRetentionApplies();
  const batch = opts.batchPerTenant ?? 500;

  const cp = await createControlPlane();
  let candidates: Array<{ tenant: string; lapsedAt: number; status: string }>;
  try {
    candidates = await cp.listLapsedTenants(cutoff, opts.maxTenants ?? 25);
    // The free tier redefines "lapsed". A lapsed entitlement is no longer
    // someone who left — it is the FREE PLAN, whose promise is "your history is
    // kept and unlocks on upgrade". Deleting it would be that promise broken by
    // a cron. So a candidate is only sweepable when they have ALSO stopped
    // syncing: any metered bytes this month or last means the tenant is present,
    // and present tenants are never purged regardless of billing status.
    const nowD = new Date(now);
    const thisMonth = nowD.toISOString().slice(0, 7);
    const lastMonth = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - 1, 1))
      .toISOString().slice(0, 7);
    const still: typeof candidates = [];
    // Optional on the passed shape: a control plane without the meter cannot
    // prove presence, and the sweep already fails safe elsewhere (report-only
    // by default). Fakes and older planes simply skip the presence check.
    //
    // Presence is ROW EXISTENCE, not bytes: a tenant over the storage cap has
    // every batch refused, so no accepted bytes are ever recorded — but each
    // refused batch leaves a zero-byte presence row (recordSyncPresence). Bytes
    // would call that tenant absent and purge history the cap's own refusal
    // message promises is kept.
    const canMeter = typeof cp.hasSyncActivity === 'function';
    for (const c of candidates) {
      if (!canMeter) { still.push(c); continue; }
      if (await cp.hasSyncActivity(c.tenant, [thisMonth, lastMonth])) {
        log.info({ tenant: c.tenant, status: c.status }, 'lapsed retention: skipped — tenant still syncs (free tier)');
        continue;
      }
      still.push(c);
    }
    candidates = still;
  } finally {
    await cp.close();
  }

  const tenants: LapsedSweepResult['tenants'] = [];
  for (const c of candidates) {
    const counted = await runWithTenant(c.tenant, async () => {
      const store = await createStore();
      let sessions = 0;
      let purged = 0;
      try {
        // Whole-tenant deletion, so every session goes — no mtime filter. Paged
        // and capped so one enormous tenant drains over several sweeps instead of
        // holding a long transaction.
        let guard = Math.ceil(batch / 200) + 100;
        while (purged < batch && guard-- > 0) {
          const page = await store.listItems('session', 200, 0);
          if (page.length === 0) break;
          sessions += page.length;
          if (dryRun) break;                 // count the first page, delete nothing
          for (const row of page) {
            if (purged >= batch) break;
            await store.purgeSession(row.id);
            purged++;
          }
        }
      } finally {
        await store.close();
      }
      return { sessions, purged };
    });
    tenants.push({ tenant: c.tenant, status: c.status, lapsedAt: c.lapsedAt, ...counted });
    log[dryRun ? 'warn' : 'info']({
      tenant: c.tenant, status: c.status, lapsedAt: c.lapsedAt,
      sessions: counted.sessions, purged: counted.purged, dryRun, days,
    }, dryRun ? 'lapsed retention: WOULD purge (set LAPSED_RETENTION_APPLY=1 to act)'
              : 'lapsed retention purge');
  }
  return { cutoff, dryRun, tenants };
}
