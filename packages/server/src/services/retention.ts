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
import { billingEnabled, currentUsageMonth } from '../util/billing.js';

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


// ── The user's OWN retention window ────────────────────────────────────────
//
// The only answer we had to "how long do you keep my sessions?" was "while your
// workspace exists". For a product that indexes every line a developer's agents
// wrote, indefinite is the wrong default to have no alternative to, and a
// retention window is the one privacy control a user cannot implement for
// themselves — deleting by hand means finding every session older than a date.
//
// Per tenant, opt-in, stored as a tenant setting so it survives without a schema
// change and is readable by the same control plane the reminders use.
//
// NO TOMBSTONES, deliberately, and this is the difference from a user pressing
// delete. A tombstone is permanent: it would mean raising the window later could
// never bring anything back, and it would grow one row per expired session
// forever. Without one, the purge is just "the server stops holding this" — the
// transcript is still on the user's disk, so a `chat-recall sync --full` after
// widening the window re-ships whatever the new window admits. Pressing delete
// means "erase this"; a retention window means "do not keep it this long".
//
// The client's own ledger stops it re-shipping on ordinary ticks, so a purged
// session does not bounce straight back in.

/** Tenant-setting key holding the window, in days. Absent or 0 = keep forever. */
const RETENTION_KEY = 'retention_days';

/** Lower bound on a window a user may set. A one-day window on a product whose
 *  value is recall would delete the thing they came for, and the support cost of
 *  "where did my history go" outweighs serving that request. */
export const MIN_RETENTION_DAYS = 7;
/** Upper bound, so the value stays a number and not an accident (10 years). */
export const MAX_RETENTION_DAYS = 3650;

/** Parse a user-supplied window. Returns null when the input is not a usable
 *  number, and 0 for an explicit "keep everything". */
export function parseRetentionDays(input: unknown): number | null {
  if (input === 0 || input === '0' || input === null) return 0;
  const n = Number(input);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n === 0) return 0;
  if (n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS) return null;
  return n;
}

/**
 * THE WARNING, written once and served to every surface.
 *
 * A retention window deletes data on a timer, and the recovery story is
 * conditional in a way that is easy to state too comfortably. "Widen it and
 * re-sync" only works while the transcript still exists ON A MACHINE THE USER
 * STILL HAS. It does not work for:
 *
 *   - a laptop they no longer own, or a machine they wiped;
 *   - transcripts their AI tool has since rotated or pruned;
 *   - transcripts they deleted themselves to free space.
 *
 * In those cases our copy was the only copy, and the window destroyed it. So the
 * warning says so in those words rather than implying a safety net that may not
 * be there. Exported here so the API, the CLI and the dashboard cannot drift into
 * three different descriptions of the same irreversible action.
 */
export const RETENTION_WARNING = [
  'A retention window deletes sessions from the server on a timer, permanently.',
  'It can only be undone where the original transcript still exists on a machine you have:'
  + ' widening the window and running `chat-recall sync --full` re-ships whatever it admits.',
  'Sessions whose transcript is gone — a machine you no longer own, history your AI tool rotated,'
  + ' files you deleted — cannot come back. For those, our copy is the only copy.',
  'Export first if you want one: GET /api/data/export.',
].join(' ');

/**
 * How many sessions a window of `days` would delete RIGHT NOW.
 *
 * The point of the whole feature is that it acts later and unattended, so the
 * number has to be shown before it is armed — the same reason `init` prints its
 * scope before the first upload rather than counts after it. Counting is a walk
 * over metadata rows (mtime only), not a read of any content.
 */
export async function countOlderThan(tenant: string, days: number, now = Date.now()): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return runWithTenant(tenant, async () => {
    const store = await createStore();
    let count = 0;
    try {
      const PAGE = 500;
      for (let offset = 0; ; offset += PAGE) {
        const page = await store.listItems('session', PAGE, offset);
        if (!page.length) break;
        // listItems is mtime DESC, so once a whole page is stale the rest are
        // too — but count them properly rather than extrapolating: the number is
        // shown to a user about to delete their history.
        for (const row of page) if ((row.mtime ?? 0) < cutoff) count++;
        if (page.length < PAGE) break;
      }
    } finally {
      await store.close();
    }
    return count;
  });
}

/** Read one tenant's window. 0 when unset — the current behaviour, kept as the
 *  default so no existing workspace starts deleting because this shipped. */
export async function getRetentionDays(tenant: string): Promise<number> {
  const cp = await createControlPlane();
  try {
    const raw = await cp.getTenantSetting(tenant, RETENTION_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } finally {
    await cp.close();
  }
}

/** Set (or clear, with 0) one tenant's window. */
export async function setRetentionDays(tenant: string, days: number): Promise<void> {
  const cp = await createControlPlane();
  try {
    await cp.setTenantSetting(tenant, RETENTION_KEY, String(days));
  } finally {
    await cp.close();
  }
}

/**
 * Purge sessions older than each tenant's own window.
 *
 * Same paging shape as the synthetic sweep — `listItems` is mtime DESC, so the
 * expired rows are a contiguous suffix — and the same per-tenant batch cap, so a
 * tenant that sets a 30-day window on ten years of history drains over several
 * sweeps instead of holding one enormous transaction.
 */
export async function sweepUserRetention(
  opts: { batchPerTenant?: number; now?: number; tenants?: string[] } = {},
): Promise<Array<{ tenant: string; days: number; purged: number }>> {
  const batch = opts.batchPerTenant ?? 500;
  const now = opts.now ?? Date.now();
  const results: Array<{ tenant: string; days: number; purged: number }> = [];

  // `tenants` narrows the sweep to a named set. Two uses: re-running a purge for
  // one workspace after a support question, and testing the sweep at all — the
  // control plane's tenant list is a production concept, so a test that has to
  // go through it is testing the control plane instead of the sweep.
  let tenants: string[] = opts.tenants ?? [];
  if (!opts.tenants) {
    const cp = await createControlPlane();
    try {
      tenants = await cp.listTenants();
    } finally {
      await cp.close();
    }
  }

  const synthetic = new Set(syntheticTenants());

  for (const tenant of tenants) {
    if (synthetic.has(tenant)) continue;   // the other sweep owns those
    const days = await getRetentionDays(tenant);
    if (days <= 0) continue;               // keep forever — the default

    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const purged = await runWithTenant(tenant, async () => {
      const store = await createStore();
      let count = 0;
      try {
        let offset = 0;
        const PAGE = 200;
        let guard = Math.ceil(batch / PAGE) + 100;
        while (count < batch && guard-- > 0) {
          const page = await store.listItems('session', PAGE, offset);
          if (page.length === 0) break;
          const stale = page.filter((r) => (r.mtime ?? 0) < cutoff);
          if (stale.length === 0) {
            if (page.length < PAGE) break;
            offset += page.length;
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
    if (purged > 0) log.info({ tenant, days, purged, cutoff }, 'user retention purge');
    results.push({ tenant, days, purged });
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
    // currentUsageMonth is THE bucket key — the same function that writes the
    // rows. An inlined copy here would query keys nothing writes the moment
    // the key format changes, and every free tenant would read as absent.
    const nowD = new Date(now);
    const thisMonth = currentUsageMonth(nowD);
    const lastMonth = currentUsageMonth(new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - 1, 1)));
    // Optional on the passed shape: a control plane without the meter cannot
    // prove presence, and the sweep already fails safe elsewhere (report-only
    // by default). Fakes and older planes simply skip the presence check.
    //
    // Presence is ROW EXISTENCE, not bytes: a tenant over the storage cap has
    // every batch refused, so no accepted bytes are ever recorded — but each
    // refused batch leaves a zero-byte presence row (recordSyncPresence). Bytes
    // would call that tenant absent and purge history the cap's own refusal
    // message promises is kept. Checked in parallel: the list is bounded by
    // maxTenants, and N serialized round trips were pure added wall-clock.
    if (typeof cp.hasSyncActivity === 'function') {
      const present = await Promise.all(
        candidates.map((c) => cp.hasSyncActivity(c.tenant, [thisMonth, lastMonth])),
      );
      candidates = candidates.filter((c, i) => {
        if (!present[i]) return true;
        log.info({ tenant: c.tenant, status: c.status }, 'lapsed retention: skipped — tenant still syncs (free tier)');
        return false;
      });
    }
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
