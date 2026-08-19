/**
 * The trial cap: subscribing must never hand out a SECOND free window.
 *
 * The rule under test is the arithmetic that decides how much free time a paying
 * customer gets. Before it, a tenant on a 14-day no-card trial who subscribed
 * received another trial_period_days on top — 21 days before the first charge.
 * The bug is silent (nobody complains about extra free time) and it is revenue,
 * so it needs a test rather than a manual check.
 *
 * The helper mirrors the decision in routes/billing.ts. It is duplicated here
 * deliberately as an executable specification of the three cases; the sandbox
 * harness proves the route itself passes the value to Stripe.
 */
import { describe, test, expect } from 'vitest';
import { isNoCardTrial } from '../util/trial.js';
import type { Entitlement } from '../imports.js';

const DAY = 86_400_000;
const MIN_TRIAL_MS = 48 * 60 * 60 * 1000;

const ent = (o: Partial<Entitlement>): Entitlement => ({
  tenant: 't', plan: null, status: 'none', currentPeriodEnd: null,
  stripeCustomerId: null, stripeSubscriptionId: null, ...o,
});

/** The decision as implemented in the checkout route. */
function trialArgFor(cur: Entitlement | null, now: number, cardTrialDays: number) {
  if (!cur) return { trial_period_days: cardTrialDays };
  if (isNoCardTrial(cur) && cur.currentPeriodEnd != null
      && cur.currentPeriodEnd - now > MIN_TRIAL_MS) {
    return { trial_end: Math.floor(cur.currentPeriodEnd / 1000) };
  }
  return {};
}

describe('checkout trial cap', () => {
  const now = 1_800_000_000_000;

  test('mid-trial: inherits the ORIGINAL end, so total free stays at one window', () => {
    const end = now + 9 * DAY;
    const arg = trialArgFor(ent({ status: 'trialing', currentPeriodEnd: end }), now, 7);
    expect(arg).toEqual({ trial_end: Math.floor(end / 1000) });
    // The decisive property: no second window is added.
    expect((arg as any).trial_period_days).toBeUndefined();
  });

  test('a lapsed trial gets NO further free time', () => {
    const arg = trialArgFor(ent({ status: 'trialing', currentPeriodEnd: now - DAY }), now, 7);
    expect(arg).toEqual({});
  });

  test('under 48h left → no trial, because Stripe rejects a nearer trial_end', () => {
    const arg = trialArgFor(ent({ status: 'trialing', currentPeriodEnd: now + 3600_000 }), now, 7);
    expect(arg).toEqual({});
  });

  test('a returning cancelled subscriber gets no new trial', () => {
    // Otherwise cancelling and resubscribing farms a free window each time.
    const arg = trialArgFor(ent({ status: 'canceled', stripeSubscriptionId: 'sub_1' }), now, 7);
    expect(arg).toEqual({});
  });

  test('an existing Stripe card trial is left to Stripe', () => {
    const arg = trialArgFor(
      ent({ status: 'trialing', currentPeriodEnd: now + 5 * DAY, stripeSubscriptionId: 'sub_1' }),
      now, 7,
    );
    expect(arg).toEqual({});
  });

  test('no entitlement row at all → the classic card-required trial', () => {
    expect(trialArgFor(null, now, 7)).toEqual({ trial_period_days: 7 });
  });

  test('the inherited end never exceeds the original trial length', () => {
    const signup = now - 5 * DAY;
    const end = signup + 14 * DAY;
    const arg = trialArgFor(ent({ status: 'trialing', currentPeriodEnd: end }), now, 7) as any;
    const totalFreeDays = (arg.trial_end * 1000 - signup) / DAY;
    expect(totalFreeDays).toBeCloseTo(14, 5);
  });
});
