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
import { createStore } from '../imports.js';
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
