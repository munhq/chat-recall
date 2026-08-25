/**
 * DORMANCY — the floor a cloud tenant lands on when their entitlement stops
 * being live.
 *
 * Rewritten on 2026-08-25, when dormancy became a HARD STOP. Two earlier shapes
 * are recorded in the git history: metered sync with a seven-day search window,
 * then the whole corpus readable with ingest stopped. The second one left a
 * memory product answering from a memory that stopped growing.
 *
 * The contract under test, end to end:
 *   1. 'free' grants NOTHING, and is never offered as the tier to upgrade to.
 *   2. No plan windows search — a window is a degraded answer, and dormancy no
 *      longer answers at all.
 *   3. The meters live on the TRIAL, the only unpaid plan that still ingests.
 *   4. Unknown or absent plans FAIL CLOSED to dormancy, so an unrecorded plan
 *      cannot mean unmetered ingest.
 *   5. effectivePlan() is the one switch: live entitlement → recorded plan,
 *      anything else → 'free'.
 *   6. syncAdmission() refuses a dormant tenant with the sync_off payload, and
 *      still refuses an unverified one; entitled and self-host are untouched.
 *   7. planFeatures(null) still grants memory + scan — that is the safety net
 *      for a PAYING tenant whose plan failed to record, and it is a different
 *      question from what a lapsed tenant gets.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Fake control plane, swapped in before billing.js loads ──────────────────
const state = {
  ent: null as Record<string, unknown> | null,
  verified: true,
  usage: { monthBytes: 0, totalBytes: 0 },
  /** What approxStoredBytes measures — the STORAGE meter reads reality now. */
  storedBytes: 0,
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
  createStore: async () => ({
    approxStoredBytes: async () => state.storedBytes,
    close: async () => {},
  }),
}));

import {
  planFeatures, limitsFor, dormantLimits, trialLimits, FULL_LIMITS, featureRequired, limitReached,
} from './entitlements.js';
import {
  effectivePlan, tenantLimits, syncAdmission, recordSyncUsage,
  clearEntitlementCache, currentUsageMonth, nextMonthStartMs, isEntitled, operatorPlan,
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
  state.storedBytes = 0;
  state.adds = [];
  clearEntitlementCache();
});
afterEach(() => {
  if (ORIG_STRIPE === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIG_STRIPE;
  delete process.env.TRIAL_STORAGE_MB;
  delete process.env.OPERATOR_TENANTS;
  delete process.env.OPERATOR_PLAN;
  clearEntitlementCache();
});

// ── 0. The operator override ─────────────────────────────────────────────────
describe('OPERATOR_TENANTS — the people who run the service are not locked out of it', () => {
  test('a lapsed operator is still entitled, on the full plan', async () => {
    const t = tenant();
    process.env.OPERATOR_TENANTS = `someone-else, ${t} ,another`;   // spaces tolerated
    // The row says lapsed. Configuration outranks it.
    state.ent = { status: 'trialing', plan: 'trial', currentPeriodEnd: Date.now() - 30 * DAY };
    expect(await isEntitled(t)).toBe(true);
    expect(await effectivePlan(t)).toBe('enterprise');
    expect(await tenantLimits(t)).toEqual(FULL_LIMITS);
    expect(planFeatures(await effectivePlan(t)).has('team')).toBe(true);
  });

  test('an operator syncs unmetered, whatever the trial cap says', async () => {
    const t = tenant();
    process.env.OPERATOR_TENANTS = t;
    process.env.TRIAL_STORAGE_MB = '1';
    state.ent = { status: 'trialing', plan: 'trial', currentPeriodEnd: Date.now() - DAY };
    state.storedBytes = 500 * MB;
    const a = await syncAdmission(t, 50 * MB);
    expect(a.ok).toBe(true);
  });

  test('OPERATOR_PLAN picks the tier, and enterprise is the default', () => {
    process.env.OPERATOR_TENANTS = 'me';
    expect(operatorPlan('me')).toBe('enterprise');
    process.env.OPERATOR_PLAN = 'team-monthly';
    expect(operatorPlan('me')).toBe('team-monthly');
  });

  test('it is an allowlist, not a switch — an unlisted tenant is untouched', async () => {
    const t = tenant();
    process.env.OPERATOR_TENANTS = 'somebody-else';
    state.ent = { status: 'trialing', plan: 'trial', currentPeriodEnd: Date.now() - DAY };
    expect(operatorPlan(t)).toBeNull();
    expect(await isEntitled(t)).toBe(false);
    expect(await effectivePlan(t)).toBe('free');
  });

  test('unset means nobody — an empty list must not match the empty slug', () => {
    delete process.env.OPERATOR_TENANTS;
    expect(operatorPlan('')).toBeNull();
    expect(operatorPlan('anyone')).toBeNull();
    process.env.OPERATOR_TENANTS = '';
    expect(operatorPlan('')).toBeNull();
  });
});

// ── 1. Packaging ─────────────────────────────────────────────────────────────
describe("the 'free' plan in the packaging map", () => {
  test('grants nothing at all', () => {
    // 'memory' and 'scan' left this set on 2026-08-25. Reading a corpus that
    // stopped growing is not a cheaper product, so a lapsed account is refused
    // rather than degraded. requireEntitlement sends the 402 before any feature
    // gate is consulted; this asserts the map agrees, so a route that somehow
    // reaches the gate cannot quietly serve a dormant tenant.
    const f = planFeatures('free');
    for (const not of ['memory', 'scan', 'sync', 'insights', 'findings', 'alerts', 'tasks', 'toolkit', 'team', 'sso', 'audit']) {
      expect(f.has(not as never), `'free' must not grant ${not}`).toBe(false);
    }
    expect(f.size).toBe(0);
  });

  test('an UNRECORDED plan still grants memory + scan — that safety net is separate', () => {
    // planFeatures(null) is what a PAYING tenant hits when checkout failed to
    // record the plan (it has happened). Emptying 'free' must not empty this:
    // one is a lapsed account, the other is a customer we are already billing.
    const f = planFeatures(null);
    expect(f.has('memory')).toBe(true);
    expect(f.has('scan')).toBe(true);
    expect(f.has('sync')).toBe(false);
  });

  test('is never named as the tier to buy', () => {
    // The cheapest PURCHASABLE tier that grants sync is solo — telling a user to
    // "buy the free plan" is the trial bug again.
    expect(featureRequired('sync').requires).toBe('solo');
    expect(featureRequired('insights').requires).toBe('solo');
    expect(featureRequired('team').requires).toBe('team');
  });
});

// ── 2. Limits ────────────────────────────────────────────────────────────────
describe('limitsFor', () => {
  test('dormancy has no window and no meters — nothing left to ration', () => {
    const l = limitsFor('free');
    expect(l.searchWindowDays).toBeNull();
    expect(l.syncBytesPerMonth).toBeNull();
    expect(l.syncStorageBytes).toBeNull();
    // The two things that actually cost money per tenant stay withheld.
    expect(l.summaries).toBe(false);
    expect(l.embeddings).toBe(false);
    expect(l.rateMultiplier).toBe(0.2);
  });

  test.each(['solo-monthly', 'team-yearly', 'enterprise', 'selfhost'])(
    'leaves %s unmetered', (plan) => {
      expect(limitsFor(plan)).toEqual(FULL_LIMITS);
    });

  test('meters the TRIAL on total ingest only — the one unpaid plan that syncs', () => {
    const l = limitsFor('trial');
    expect(l.syncStorageBytes).toBe(5120 * MB);
    expect(l.syncBytesPerMonth).toBeNull();
    expect(l.searchWindowDays).toBeNull();
    // A trial has to demonstrate the product, so it is embedded and summarised.
    expect(l.summaries).toBe(true);
    expect(l.embeddings).toBe(true);
  });

  test('the trial cap is an env knob, not a deploy', () => {
    process.env.TRIAL_STORAGE_MB = '64';
    expect(trialLimits().syncStorageBytes).toBe(64 * MB);
  });

  test.each([null, undefined, '', 'platinum-unlimited'])(
    'fails CLOSED on %s — an unrecorded plan must not mean ingest', (plan) => {
      // The brake is the FEATURE now, not a byte meter: dormancy has no meters,
      // so a fail-closed that only checked bytes would admit everything.
      expect(planFeatures(plan as string | null).has('sync')).toBe(false);
      expect(limitsFor(plan as string | null)).toEqual(dormantLimits());
    });

  test('NO plan windows search — the window was removed on 2026-08-22', () => {
    for (const plan of ['free', 'trial', 'solo-monthly', 'team-yearly', 'enterprise', 'selfhost', null]) {
      expect(limitsFor(plan).searchWindowDays, `${plan} must not window search`).toBeNull();
    }
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
    // The downgrade takes away everything: since 2026-08-25 'free' grants none.
    expect(planFeatures(await effectivePlan(t)).size).toBe(0);
    expect((await tenantLimits(t)).searchWindowDays).toBeNull();
  });

  test("cancelled Solo → 'free' — a lapsed paid plan keeps nothing paid", async () => {
    state.ent = { status: 'canceled', plan: 'solo-monthly', currentPeriodEnd: Date.now() - 30 * DAY };
    expect(await effectivePlan(tenant())).toBe('free');
  });

  test('ENTITLED with an unrecorded/unknown plan is NEVER metered', async () => {
    // Payment-link and dashboard subscriptions record a raw price id (or null)
    // as the plan. Meters key on entitlement, not on plan-string parsing —
    // taking someone's money while metering them is the one failure this
    // block exists to prevent.
    state.ent = { status: 'active', plan: 'price_1AbCdEfGhIjKl', currentPeriodEnd: Date.now() + 20 * DAY };
    expect(await tenantLimits(tenant())).toEqual(FULL_LIMITS);
    clearEntitlementCache();
    state.ent = { status: 'active', plan: null, currentPeriodEnd: Date.now() + 20 * DAY };
    expect(await tenantLimits(tenant())).toEqual(FULL_LIMITS);
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

  test('DORMANT tenant: refused with sync_off, whatever the meters say', async () => {
    state.ent = { status: 'trialing', plan: 'trial', currentPeriodEnd: Date.now() - DAY };
    state.usage = { monthBytes: 0, totalBytes: 0 };   // wide open, and still refused
    const a = await syncAdmission(tenant(), 1 * MB);
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.status).toBe(402);
      expect(a.body.kind).toBe('sync_off');
      // The refusal has to say what still works, or it reads as data loss.
      // 'searchable' left this assertion on 2026-08-25: a dormant account is no
      // longer searchable, so promising it here would be the drift this test
      // exists to catch. Export and the one restoring command are what remain.
      expect(String(a.body.detail)).toMatch(/export/i);
      expect(String(a.body.detail)).toMatch(/sync --full/);
    }
  });

  test('a lapsed PAID plan is dormant too — not metered, refused', async () => {
    state.ent = { status: 'canceled', plan: 'solo-monthly', currentPeriodEnd: Date.now() - DAY };
    const a = await syncAdmission(tenant(), 1 * MB);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.body.kind).toBe('sync_off');
  });

  test('TRIAL over the storage cap: 402 sync_storage, no reset date — the cap does not turn over', async () => {
    state.ent = { status: 'trialing', plan: 'trial', currentPeriodEnd: Date.now() + 3 * DAY };
    process.env.TRIAL_STORAGE_MB = '300';
    // The cap reads MEASURED storage, not summed traffic: a re-shipped session
    // must not count twice, and a wiped account must read as empty.
    state.storedBytes = 299.5 * MB;
    state.usage = { monthBytes: 1 * MB, totalBytes: 999 * MB };   // traffic total is NOT the cap
    const a = await syncAdmission(tenant(), 1 * MB);
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.body.kind).toBe('sync_storage');
      expect(a.body.resetsAt).toBeUndefined();
    }
  });

  test('TRIAL inside the cap: admitted', async () => {
    state.ent = { status: 'trialing', plan: 'trial', currentPeriodEnd: Date.now() + 3 * DAY };
    state.storedBytes = 10 * MB;
    const a = await syncAdmission(tenant(), 1 * MB);
    expect(a.ok).toBe(true);
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

  test('a ZERO write records presence; garbage is ignored', async () => {
    // Zero is the presence marker refused batches leave for the retention
    // sweep — it must reach the meter table (bytes += 0 creates the row).
    await recordSyncUsage('t-rec', 0);
    await recordSyncUsage('t-rec', NaN);
    await recordSyncUsage('t-rec', -5);
    expect(state.adds).toEqual([{ tenant: 't-rec', month: currentUsageMonth(), bytes: 0 }]);
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
