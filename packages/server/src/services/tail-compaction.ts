/**
 * Compaction of tail segments (issue #27).
 *
 * An append adds a segment to a session instead of rewriting its stored
 * envelope. Segments make a read merge more rows, so a session whose segments
 * passed a count or a size, and that no append has touched for five minutes, is
 * merged back into its base here: one session at a time, so the memory of the
 * job is one envelope. It runs on the worker tier.
 */
import { createStore, createControlPlane, runWithTenant } from '../imports.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('tail-compaction');

type Store = Awaited<ReturnType<typeof createStore>>;

/** Sessions merged in one pass of one tenant, so a pass ends in bounded time. */
const SESSIONS_PER_PASS = 20;

export interface CompactionResult { sessions: number; segments: number; failed: number }

export async function compactTailsOfTenant(store: Store, opts: { limit?: number } = {}): Promise<CompactionResult> {
  const ids = await store.sessionsNeedingCompaction({ limit: opts.limit ?? SESSIONS_PER_PASS });
  const out: CompactionResult = { sessions: 0, segments: 0, failed: 0 };
  for (const id of ids) {
    try {
      const r = await store.compactSessionTails(id);
      if (r) { out.sessions++; out.segments += r.segments; }
    } catch (err) {
      out.failed++;
      log.error({ err, session: id }, 'tail compaction failed');
    }
  }
  return out;
}

export async function compactTailsAllTenants(): Promise<CompactionResult & { tenants: number }> {
  const cp = await createControlPlane();
  let tenants: string[] = [];
  try { tenants = await cp.listTenants(); } catch { /* fall through */ }
  finally { await cp.close?.(); }
  if (tenants.length === 0) tenants = [process.env.CHAT_RECALL_TENANT || 'default'];
  const total = { sessions: 0, segments: 0, failed: 0, tenants: tenants.length };
  for (const tenant of tenants) {
    await runWithTenant(tenant, async () => {
      const store = await createStore();
      try {
        const r = await compactTailsOfTenant(store);
        total.sessions += r.sessions; total.segments += r.segments; total.failed += r.failed;
        if (r.sessions > 0) log.info({ tenant, ...r }, 'tail compaction (tenant)');
      } finally {
        await store.close();
      }
    });
  }
  return total;
}
