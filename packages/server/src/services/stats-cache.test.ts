/**
 * `getStats()` must be fetched from the store ONCE per tenant per window.
 *
 * The store's implementation is three whole-corpus aggregates over
 * `memory_chunks` (`COUNT(*)`, `COUNT(DISTINCT (source_type,item_id))` and a
 * `GROUP BY`) — measured at 346ms + 704ms + 129ms on a 246k-chunk tenant, and
 * unpaginable because a total has no pages. Three call sites reached for it per
 * request (`/api/status`, `/api/memory/status`, and `vectorActive()` which
 * wanted a single boolean), and `/api/status` sits on the dashboard's boot path.
 *
 * Two properties are load-bearing and both are asserted here:
 *   1. repeated reads inside the window hit the store once, and
 *   2. the entry is per-tenant — these counts are RLS-filtered, so a cache that
 *      merely memoized would hand one team's totals to the next request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenant } from '@chat-recall/engine/core/store/tenant-context.js';

const getStatsSpy = vi.fn(async () => ({
  totalChunks: 246_540,
  totalItems: 15_456,
  bySourceType: {},
  indexPath: 'postgres',
  vectorOk: true,
}));

vi.mock('../imports.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createVectorStore: vi.fn(async () => ({ getStats: getStatsSpy })),
}));

const { SearchCore } = await import('./search-core.js');

/** Exposes the two protected members under test. */
class Probe extends (SearchCore as any) {
  stats() { return (this as any).cachedStats(); }
  vector() { return (this as any).vectorActive(); }
}

describe('SearchCore.cachedStats', () => {
  beforeEach(() => { getStatsSpy.mockClear(); });

  it('reads the store once for repeated calls in the same tenant', async () => {
    const svc = new Probe();
    const a = await runWithTenant('team-a', () => svc.stats());
    const b = await runWithTenant('team-a', () => svc.stats());
    const c = await runWithTenant('team-a', () => svc.stats());

    expect(getStatsSpy).toHaveBeenCalledTimes(1);
    expect(a.totalItems).toBe(15_456);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('keeps a separate entry per tenant', async () => {
    const svc = new Probe();
    await runWithTenant('team-a', () => svc.stats());
    await runWithTenant('team-b', () => svc.stats());

    // Two tenants, two reads — never one tenant's totals reused for the other.
    expect(getStatsSpy).toHaveBeenCalledTimes(2);
  });

  it('answers vectorActive() from the cache instead of a fresh scan', async () => {
    const svc = new Probe();
    await runWithTenant('team-a', () => svc.stats());
    const ok = await runWithTenant('team-a', () => svc.vector());

    expect(ok).toBe(true);
    expect(getStatsSpy).toHaveBeenCalledTimes(1);
  });
});
