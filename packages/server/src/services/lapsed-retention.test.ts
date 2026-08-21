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

const ORIG = {
  days: process.env.LAPSED_RETENTION_DAYS,
  apply: process.env.LAPSED_RETENTION_APPLY,
  stripe: process.env.STRIPE_SECRET_KEY,
};

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

/** Tenants with a sync-usage ROW in the checked months — "still present".
 *  Row existence, not bytes: a refused batch (over the storage cap) records a
 *  zero-byte presence row, and the free tier's promise is that a lapsed tenant
 *  who still syncs — or still TRIES to — keeps their history. */
const activeSyncers = new Set<string>();

vi.mock('../imports.js', () => ({
  createControlPlane: async () => ({
    hasSyncActivity: async (tenant: string, _months: string[]) => activeSyncers.has(tenant),
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

beforeEach(() => {
  purged.length = 0;
  activeSyncers.clear();
  // Billing on by default in these tests: the cloud path is what the rest of the
  // file is about. The self-host case turns it off explicitly.
  process.env.STRIPE_SECRET_KEY = 'sk_test_forthesetests';
});
afterEach(() => {
  if (ORIG.stripe === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIG.stripe;
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

  test('a lapsed tenant who STILL SYNCS is never purged — they are on the free plan', async () => {
    // 'expired-trial' lapsed 40 days ago but keeps pushing batches: the free
    // tier keeps their history by promise, so only truly absent tenants remain
    // sweepable. Presence is a usage ROW, so this also covers the tenant whose
    // every batch is REFUSED by the storage cap — refused batches record a
    // zero-byte presence row, and "sync is paused; your data is kept" must not
    // be falsified by this very cron.
    activeSyncers.add('expired-trial');
    process.env.LAPSED_RETENTION_DAYS = '30';
    process.env.LAPSED_RETENTION_APPLY = '1';
    const r = await sweep();
    const picked = r.tenants.map((t) => t.tenant);
    expect(picked).not.toContain('expired-trial');
    expect(picked.sort()).toEqual(['cancelled-long', 'unpaid-long']);
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

  test('does nothing on a SELF-HOSTED install, however hard it is armed', async () => {
    // "Lapsed" is a billing state, and self-host has no billing: isEntitled()
    // returns true for everyone there, so nobody's access has ended.
    //
    // The path this closes is real. A self-hoster running with auth enabled who
    // opens the account page has ensureTrial() write a `trialing` row with a
    // 7-day period — harmless, the gate ignores it. Thirty-seven days later that
    // row matches listLapsedTenants() exactly, and an operator who set the env
    // var would have their own server delete their own history on their own
    // hardware. Both switches are set here on purpose: the guard must not depend
    // on someone forgetting to configure it.
    delete process.env.STRIPE_SECRET_KEY;
    process.env.LAPSED_RETENTION_DAYS = '30';
    process.env.LAPSED_RETENTION_APPLY = '1';
    const r = await sweep();
    expect(r.cutoff).toBeNull();
    expect(r.tenants).toEqual([]);
    expect(purged).toEqual([]);
  });

  test('respects the per-tenant batch cap so one huge tenant cannot hold the sweep', async () => {
    process.env.LAPSED_RETENTION_DAYS = '30';
    process.env.LAPSED_RETENTION_APPLY = '1';
    const r = await sweep({ batchPerTenant: 1 });
    expect(r.tenants.every((t) => t.purged <= 1)).toBe(true);
  });
});
