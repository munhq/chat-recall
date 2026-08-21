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
