/**
 * The no-card trial: granting, dating, and the rule that it is granted ONCE.
 *
 * The once-only rule is the one worth guarding hardest. `ensureTrial` runs on the
 * read path, so a mistake there does not fail loudly — it silently renews every
 * lapsed tenant's trial on their next request, and the product simply never
 * charges anyone again.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { trialLengthDays, isNoCardTrial, trialDaysLeft, ensureTrial } from './trial.js';
import type { Entitlement } from '../imports.js';

const DAY = 86_400_000;

/** In-memory stand-in for the control plane's entitlement half. */
function fakeCp(seed?: Entitlement) {
  let row: Entitlement | null = seed ?? null;
  return {
    writes: 0,
    async getEntitlement() { return row; },
    async setEntitlement(tenant: string, patch: Partial<Omit<Entitlement, 'tenant'>>) {
      this.writes++;
      row = {
        tenant,
        plan: patch.plan ?? row?.plan ?? null,
        status: patch.status ?? row?.status ?? 'none',
        currentPeriodEnd: patch.currentPeriodEnd ?? row?.currentPeriodEnd ?? null,
        stripeCustomerId: patch.stripeCustomerId ?? row?.stripeCustomerId ?? null,
        stripeSubscriptionId: patch.stripeSubscriptionId ?? row?.stripeSubscriptionId ?? null,
      };
    },
  };
}

const ent = (o: Partial<Entitlement>): Entitlement => ({
  tenant: 't', plan: null, status: 'none', currentPeriodEnd: null,
  stripeCustomerId: null, stripeSubscriptionId: null, ...o,
});

const saved = process.env.FREE_TRIAL_DAYS;
beforeEach(() => { delete process.env.FREE_TRIAL_DAYS; });
afterEach(() => {
  if (saved === undefined) delete process.env.FREE_TRIAL_DAYS;
  else process.env.FREE_TRIAL_DAYS = saved;
});

describe('trialLengthDays', () => {
  test('defaults to 14', () => {
    expect(trialLengthDays()).toBe(14);
  });

  test('honours FREE_TRIAL_DAYS', () => {
    process.env.FREE_TRIAL_DAYS = '30';
    expect(trialLengthDays()).toBe(30);
  });

  test('rejects junk and non-positive values, falling back to the default', () => {
    // A typo in an env var must not produce a zero-day or negative trial, which
    // would lock out every new tenant the moment they arrive.
    for (const bad of ['0', '-5', 'abc', '']) {
      process.env.FREE_TRIAL_DAYS = bad;
      expect(trialLengthDays()).toBe(14);
    }
  });
});

describe('isNoCardTrial', () => {
  test('true only for a trialing entitlement with no subscription behind it', () => {
    expect(isNoCardTrial(ent({ status: 'trialing' }))).toBe(true);
  });

  test('false for a Stripe card trial — Stripe owns that lifecycle', () => {
    // The distinction matters: we must not send our own expiry reminders to a
    // customer who already gave Stripe a card and is being dunned by Stripe.
    expect(isNoCardTrial(ent({ status: 'trialing', stripeSubscriptionId: 'sub_1' }))).toBe(false);
  });

  test('false for active, canceled, none, and null', () => {
    expect(isNoCardTrial(ent({ status: 'active' }))).toBe(false);
    expect(isNoCardTrial(ent({ status: 'canceled' }))).toBe(false);
    expect(isNoCardTrial(ent({ status: 'none' }))).toBe(false);
    expect(isNoCardTrial(null)).toBe(false);
  });
});

describe('trialDaysLeft', () => {
  test('rounds UP so a part-day still reads as a day left', () => {
    // A user with six hours left has access, so the banner must not say 0.
    const now = Date.now();
    expect(trialDaysLeft(ent({ currentPeriodEnd: now + DAY / 4 }), now)).toBe(1);
  });

  test('never negative once lapsed', () => {
    const now = Date.now();
    expect(trialDaysLeft(ent({ currentPeriodEnd: now - 5 * DAY }), now)).toBe(0);
  });

  test('null when no end date is recorded', () => {
    // "No deadline known" is not the same as expired; callers must not treat it
    // as a zero-day trial.
    expect(trialDaysLeft(ent({ currentPeriodEnd: null }))).toBeNull();
    expect(trialDaysLeft(null)).toBeNull();
  });
});

describe('ensureTrial', () => {
  test('grants a dated trial to a tenant with no history', async () => {
    const cp = fakeCp();
    const now = 1_000_000_000_000;
    const got = await ensureTrial(cp, 'fresh', now);
    expect(got?.status).toBe('trialing');
    expect(got?.currentPeriodEnd).toBe(now + 14 * DAY);
    // 'trial', not null: a null plan resolves to the FREE set, which would make the
    // trial demonstrate none of the product. It must still not grant collaboration.
    expect(got?.plan).toBe('trial');
    expect(cp.writes).toBe(1);
  });

  test('does NOT re-grant to a lapsed trial — the row is the record', async () => {
    const past = Date.now() - DAY;
    const cp = fakeCp(ent({ tenant: 'lapsed', status: 'trialing', currentPeriodEnd: past }));
    const got = await ensureTrial(cp, 'lapsed');
    expect(got?.currentPeriodEnd).toBe(past);   // untouched
    expect(cp.writes).toBe(0);                  // no write at all
  });

  test('does NOT re-grant to a cancelled subscriber', async () => {
    // Otherwise cancelling would be a way to farm a fresh trial every fortnight.
    const cp = fakeCp(ent({ tenant: 'churned', status: 'canceled' }));
    const got = await ensureTrial(cp, 'churned');
    expect(got?.status).toBe('canceled');
    expect(cp.writes).toBe(0);
  });

  test('leaves a paying subscriber untouched', async () => {
    const cp = fakeCp(ent({ tenant: 'payer', status: 'active', plan: 'team-monthly' }));
    const got = await ensureTrial(cp, 'payer');
    expect(got?.status).toBe('active');
    expect(got?.plan).toBe('team-monthly');
    expect(cp.writes).toBe(0);
  });

  test('a second call is a no-op, so the read path cannot renew a trial', async () => {
    const cp = fakeCp();
    const now = Date.now();
    await ensureTrial(cp, 'once', now);
    const again = await ensureTrial(cp, 'once', now + 10 * DAY);
    expect(again?.currentPeriodEnd).toBe(now + 14 * DAY);   // the ORIGINAL end
    expect(cp.writes).toBe(1);
  });
});
