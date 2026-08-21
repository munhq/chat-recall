/**
 * The free tier — the floor a cloud tenant lands on when their entitlement
 * stops being live.
 *
 * The contract under test, end to end:
 *   1. 'free' is a real plan in the packaging map: memory + scan + sync, nothing
 *      else — and it is never offered as the tier to upgrade to.
 *   2. limitsFor() meters free and FAILS CLOSED: an unknown or absent plan gets
 *      the meters, not unlimited ingest.
 *   3. effectivePlan() is the one switch: live entitlement → recorded plan,
 *      anything else → 'free'. Every gate resolves through it, so a lapsed Solo
 *      loses insights/tasks/toolkit the moment the period ends.
 *   4. syncAdmission() closes the hole where /api/sync never consulted billing:
 *      unverified tenants are refused, free tenants are metered (monthly quota
 *      + total cap), entitled tenants are untouched, self-host is untouched.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Fake control plane, swapped in before billing.js loads ──────────────────
const state = {
  ent: null as Record<string, unknown> | null,
  verified: true,
  usage: { monthBytes: 0, totalBytes: 0 },
  adds: [] as Array<{ tenant: string; month: string; bytes: number }>,
};

vi.mock('../imports.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createControlPlane: async () => ({
    getEntitlement: async () => state.ent,
    setEntitlement: async (_t: string, patch: Record<string, unknown>) => {
      state.ent = { ...(state.ent ?? {}), ...patch };
    },
    hasVerifiedMember: async () => state.verified,
    getSyncUsage: async () => state.usage,
    addSyncUsage: async (tenant: string, month: string, bytes: number) => {
      state.adds.push({ tenant, month, bytes });
    },
    close: async () => {},
  }),
}));

import {
  planFeatures, limitsFor, freeLimits, FULL_LIMITS, featureRequired, limitReached,
} from './entitlements.js';
import {
  effectivePlan, tenantLimits, syncAdmission, recordSyncUsage,
  clearEntitlementCache, currentUsageMonth, nextMonthStartMs,
} from './billing.js';

const DAY = 86_400_000;
const MB = 1024 * 1024;
let tenantSeq = 0;
/** Fresh tenant per test: billing.js holds 30s TTL caches keyed by tenant. */
const tenant = () => `t-${++tenantSeq}`;

const ORIG_STRIPE = process.env.STRIPE_SECRET_KEY;
beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_free_tier';
  state.ent = null;
  state.verified = true;
  state.usage = { monthBytes: 0, totalBytes: 0 };
  state.adds = [];
  clearEntitlementCache();
});
afterEach(() => {
  if (ORIG_STRIPE === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIG_STRIPE;
  delete process.env.FREE_SEARCH_WINDOW_DAYS;
  clearEntitlementCache();
});

// ── 1. Packaging ─────────────────────────────────────────────────────────────
describe("the 'free' plan in the packaging map", () => {
  test('grants memory, scan and sync — and nothing analysed or shared', () => {
    const f = planFeatures('free');
    for (const has of ['memory', 'scan', 'sync']) expect(f.has(has as never)).toBe(true);
    for (const not of ['insights', 'findings', 'alerts', 'tasks', 'toolkit', 'team', 'sso', 'audit']) {
      expect(f.has(not as never)).toBe(false);
    }
  });

  test('is never named as the tier to buy', () => {
    // 'sync' is in the free set, but the cheapest PURCHASABLE tier that grants
    // it is solo — telling a user to "buy the free plan" is the trial bug again.
    expect(featureRequired('sync').requires).toBe('solo');
    expect(featureRequired('insights').requires).toBe('solo');
    expect(featureRequired('team').requires).toBe('team');
  });
});

// ── 2. Limits ────────────────────────────────────────────────────────────────
describe('limitsFor', () => {
  test('meters the free plan', () => {
    const l = limitsFor('free');
    expect(l.searchWindowDays).toBe(7);
    expect(l.syncBytesPerMonth).toBe(50 * MB);
    expect(l.syncStorageBytes).toBe(300 * MB);
    expect(l.summaries).toBe(false);
    expect(l.embeddings).toBe(false);
    expect(l.rateMultiplier).toBe(0.2);
  });

  test.each(['solo-monthly', 'team-yearly', 'trial', 'enterprise', 'selfhost'])(
    'leaves %s unmetered', (plan) => {
      expect(limitsFor(plan)).toEqual(FULL_LIMITS);
    });

  test.each([null, undefined, '', 'platinum-unlimited'])(
    'fails CLOSED on %s — an unrecorded plan must not mean unmetered ingest', (plan) => {
      expect(limitsFor(plan as string | null).syncBytesPerMonth).toBe(50 * MB);
    });

  test('window is an env knob, not a deploy', () => {
    process.env.FREE_SEARCH_WINDOW_DAYS = '14';
    expect(freeLimits().searchWindowDays).toBe(14);
  });
});

// ── 3. effectivePlan ─────────────────────────────────────────────────────────
describe('effectivePlan — the one switch every gate resolves through', () => {
  test('live subscription → the recorded plan', async () => {
    state.ent = { status: 'active', plan: 'solo-monthly', currentPeriodEnd: Date.now() + 20 * DAY };
    expect(await effectivePlan(tenant())).toBe('solo-monthly');
  });

  test('live trial → trial', async () => {
    state.ent = { status: 'trialing', plan: 'trial', currentPeriodEnd: Date.now() + 3 * DAY };
    expect(await effectivePlan(tenant())).toBe('trial');
  });

  test("lapsed trial → 'free' — this is the downgrade moment", async () => {
    state.ent = { status: 'trialing', plan: 'trial', currentPeriodEnd: Date.now() - DAY };
    const t = tenant();
    expect(await effectivePlan(t)).toBe('free');
    expect((await tenantLimits(t)).searchWindowDays).toBe(7);
  });

  test("cancelled Solo → 'free' — a lapsed paid plan keeps nothing paid", async () => {
    state.ent = { status: 'canceled', plan: 'solo-monthly', currentPeriodEnd: Date.now() - 30 * DAY };
    expect(await effectivePlan(tenant())).toBe('free');
  });

  test('self-host (billing off) → null plan, FULL limits', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const t = tenant();
    expect(await effectivePlan(t)).toBeNull();
    expect(await tenantLimits(t)).toEqual(FULL_LIMITS);
  });
});

// ── 4. syncAdmission ─────────────────────────────────────────────────────────
describe('syncAdmission — the gate /api/sync never had', () => {
  test('self-host: admitted, unmetered', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const a = await syncAdmission(tenant(), 5 * MB);
    expect(a.ok).toBe(true);
  });

  test('entitled tenant: admitted, unmetered, meter never consulted', async () => {
    state.ent = { status: 'active', plan: 'solo-monthly', currentPeriodEnd: Date.now() + 20 * DAY };
    state.usage = { monthBytes: 999 * MB, totalBytes: 9999 * MB };  // would refuse if read
    const a = await syncAdmission(tenant(), 5 * MB);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.limits.syncBytesPerMonth).toBeNull();
  });

  test('unverified new tenant: refused with the confirm-email payload, not a checkout', async () => {
    state.verified = false;
    const a = await syncAdmission(tenant(), 1000);
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.status).toBe(402);
      expect(String(a.body.error)).toContain('email confirmation');
    }
  });

  test('verified new tenant: the trial is granted on first sync and admits', async () => {
    const a = await syncAdmission(tenant(), 1000);
    expect(a.ok).toBe(true);
    expect(state.ent?.status).toBe('trialing');
  });

  test('free tenant inside both meters: admitted', async () => {
    state.ent = { status: 'trialing', plan: 'trial', currentPeriodEnd: Date.now() - DAY };
    state.usage = { monthBytes: 10 * MB, totalBytes: 100 * MB };
    const a = await syncAdmission(tenant(), 1 * MB);
    expect(a.ok).toBe(true);
  });

  test('free tenant over the MONTH quota: 402 sync_quota with a reset date', async () => {
    state.ent = { status: 'trialing', plan: 'trial', currentPeriodEnd: Date.now() - DAY };
    state.usage = { monthBytes: 49.5 * MB, totalBytes: 100 * MB };
    const a = await syncAdmission(tenant(), 1 * MB);
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.status).toBe(402);
      expect(a.body.kind).toBe('sync_quota');
      expect(typeof a.body.resetsAt).toBe('number');
    }
  });

  test('free tenant over the STORAGE cap: 402 sync_storage, no reset date — the cap does not turn over', async () => {
    state.ent = { status: 'canceled', plan: 'solo-monthly', currentPeriodEnd: Date.now() - DAY };
    state.usage = { monthBytes: 1 * MB, totalBytes: 299.5 * MB };
    const a = await syncAdmission(tenant(), 1 * MB);
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.body.kind).toBe('sync_storage');
      expect(a.body.resetsAt).toBeUndefined();
    }
  });
});

// ── 5. Recording ─────────────────────────────────────────────────────────────
describe('recordSyncUsage', () => {
  test('records under the current UTC month for cloud tenants', async () => {
    await recordSyncUsage('t-rec', 1234);
    expect(state.adds).toEqual([{ tenant: 't-rec', month: currentUsageMonth(), bytes: 1234 }]);
  });

  test('self-host never meters', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await recordSyncUsage('t-rec', 1234);
    expect(state.adds).toEqual([]);
  });

  test('zero and garbage byte counts are ignored', async () => {
    await recordSyncUsage('t-rec', 0);
    await recordSyncUsage('t-rec', NaN);
    expect(state.adds).toEqual([]);
  });
});

describe('the meter calendar', () => {
  test('month key and rollover are UTC and consistent', () => {
    const d = new Date('2026-08-21T23:59:00Z');
    expect(currentUsageMonth(d)).toBe('2026-08');
    expect(nextMonthStartMs(d)).toBe(Date.UTC(2026, 8, 1));
  });

  test('December rolls into January of the next year', () => {
    const d = new Date('2026-12-05T00:00:00Z');
    expect(nextMonthStartMs(d)).toBe(Date.UTC(2027, 0, 1));
  });
});
