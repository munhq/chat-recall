/**
 * Deleting a lapsed tenant's data — the most destructive thing in this codebase.
 *
 * Every test here is about what must NOT happen. The behaviour being protected:
 *
 *   1. Off by default. Shipping this code deletes nothing; arming it takes a
 *      deliberate env var with a number in it.
 *   2. Armed but not applied is report-only. An operator's first sight of this
 *      is a count they can check, not a hole where data used to be.
 *   3. 'past_due' is never touched. Stripe's dunning runs for weeks, and a card
 *      that merely expired is not a decision to leave — deleting there destroys
 *      the history of someone who fully intends to keep paying.
 *   4. Nothing inside the window, and nothing with an open-ended period.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIG = { days: process.env.LAPSED_RETENTION_DAYS, apply: process.env.LAPSED_RETENTION_APPLY };

/** Entitlement rows the fake control plane will filter, mirroring the real SQL. */
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const rows = [
  { tenant: 'expired-trial', status: 'trialing', current_period_end: NOW - 40 * DAY },
  { tenant: 'cancelled-long', status: 'canceled', current_period_end: NOW - 90 * DAY },
  { tenant: 'unpaid-long',    status: 'unpaid',   current_period_end: NOW - 31 * DAY },
  // Must survive: still in dunning.
  { tenant: 'card-retrying',  status: 'past_due', current_period_end: NOW - 60 * DAY },
  // Must survive: inside the window.
  { tenant: 'just-lapsed',    status: 'canceled', current_period_end: NOW - 3 * DAY },
  // Must survive: paying.
  { tenant: 'paying',         status: 'active',   current_period_end: NOW + 20 * DAY },
  // Must survive: open-ended grant (self-host, un-dated trial).
  { tenant: 'open-ended',     status: 'trialing', current_period_end: null },
];

const purged: string[] = [];

vi.mock('../imports.js', () => ({
  createControlPlane: async () => ({
    // Mirrors the real query: the three terminal statuses, a dated period, past
    // the cutoff. If the production SQL and this ever disagree, the divergence
    // is the bug this file is meant to surface.
    listLapsedTenants: async (before: number, limit = 100) =>
      rows
        .filter((r) => ['trialing', 'canceled', 'unpaid'].includes(r.status))
        .filter((r) => r.current_period_end != null && r.current_period_end < before)
        .sort((a, b) => (a.current_period_end! - b.current_period_end!))
        .slice(0, limit)
        .map((r) => ({ tenant: r.tenant, lapsedAt: r.current_period_end!, status: r.status })),
    close: async () => {},
  }),
  createStore: async () => ({
    listItems: async () => [{ id: 's1' }, { id: 's2' }],
    purgeSession: async (id: string) => { purged.push(id); },
    close: async () => {},
  }),
}));

vi.mock('@chat-recall/engine/core/store/tenant-context.js', () => ({
  runWithTenant: async (_t: string, fn: () => Promise<unknown>) => fn(),
}));

beforeEach(() => { purged.length = 0; });
afterEach(() => {
  if (ORIG.days === undefined) delete process.env.LAPSED_RETENTION_DAYS;
  else process.env.LAPSED_RETENTION_DAYS = ORIG.days;
  if (ORIG.apply === undefined) delete process.env.LAPSED_RETENTION_APPLY;
  else process.env.LAPSED_RETENTION_APPLY = ORIG.apply;
});

async function sweep(opts = {}) {
  const { sweepLapsedRetention } = await import('./retention.js');
  return sweepLapsedRetention({ now: NOW, ...opts });
}

describe('lapsed retention', () => {
  test('does nothing at all when the env var is unset', async () => {
    delete process.env.LAPSED_RETENTION_DAYS;
    const r = await sweep();
    expect(r.cutoff).toBeNull();
    expect(r.tenants).toEqual([]);
    expect(purged).toEqual([]);
  });

  test('does nothing for a zero or nonsense window', async () => {
    for (const v of ['0', '-5', 'soon', '']) {
      process.env.LAPSED_RETENTION_DAYS = v;
      const r = await sweep();
      expect(r.cutoff, `for ${JSON.stringify(v)}`).toBeNull();
      expect(purged).toEqual([]);
    }
  });

  test('armed but not applied reports what it WOULD delete and deletes nothing', async () => {
    process.env.LAPSED_RETENTION_DAYS = '30';
    delete process.env.LAPSED_RETENTION_APPLY;
    const r = await sweep();
    expect(r.dryRun).toBe(true);
    expect(r.tenants.length).toBeGreaterThan(0);
    expect(r.tenants.every((t) => t.purged === 0)).toBe(true);
    expect(r.tenants.some((t) => t.sessions > 0)).toBe(true);
    expect(purged).toEqual([]);          // the assertion that matters
  });

  test('never selects a tenant still in dunning, inside the window, paying, or open-ended', async () => {
    process.env.LAPSED_RETENTION_DAYS = '30';
    process.env.LAPSED_RETENTION_APPLY = '1';
    const r = await sweep();
    const picked = r.tenants.map((t) => t.tenant);
    for (const safe of ['card-retrying', 'just-lapsed', 'paying', 'open-ended']) {
      expect(picked, `${safe} must never be purged`).not.toContain(safe);
    }
    expect(picked.sort()).toEqual(['cancelled-long', 'expired-trial', 'unpaid-long']);
  });

  test('applied, it purges — and only then', async () => {
    process.env.LAPSED_RETENTION_DAYS = '30';
    process.env.LAPSED_RETENTION_APPLY = '1';
    const r = await sweep();
    expect(r.dryRun).toBe(false);
    expect(purged.length).toBeGreaterThan(0);
    expect(r.tenants.every((t) => t.purged > 0)).toBe(true);
  });

  test('a longer window protects more tenants', async () => {
    process.env.LAPSED_RETENTION_DAYS = '60';
    process.env.LAPSED_RETENTION_APPLY = '1';
    const r = await sweep();
    // At 60 days only the 90-day-old cancellation qualifies.
    expect(r.tenants.map((t) => t.tenant)).toEqual(['cancelled-long']);
  });

  test('respects the per-tenant batch cap so one huge tenant cannot hold the sweep', async () => {
    process.env.LAPSED_RETENTION_DAYS = '30';
    process.env.LAPSED_RETENTION_APPLY = '1';
    const r = await sweep({ batchPerTenant: 1 });
    expect(r.tenants.every((t) => t.purged <= 1)).toBe(true);
  });
});
