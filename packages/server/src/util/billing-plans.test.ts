/**
 * Plan catalogue + seat validation.
 *
 * The seat cases are the point of this file. Under-buying seats is a revenue
 * leak that no amount of correct Stripe wiring catches, and a fixed-seat plan
 * that honours a client quantity multiplies a flat price — so both are pinned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { planCatalogue, findPlan, resolveLine, isPlanError, trialDays } from './billing-plans.js';

const CATALOGUE = JSON.stringify([
  { key: 'solo-monthly', label: 'Solo', priceId: 'price_solo_m', seats: 'fixed' },
  { key: 'solo-yearly', label: 'Solo (yearly)', priceId: 'price_solo_y', seats: 'fixed' },
  { key: 'team-monthly', label: 'Team', priceId: 'price_team_m', seats: 'per_seat', minSeats: 2, maxSeats: 50 },
  { key: 'enterprise', label: 'Enterprise', contact: 'contact@chatrecall.dev' },
]);

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    BILLING_PLANS: process.env.BILLING_PLANS,
    STRIPE_PRICE_ID: process.env.STRIPE_PRICE_ID,
    STRIPE_TRIAL_DAYS: process.env.STRIPE_TRIAL_DAYS,
  };
  delete process.env.BILLING_PLANS;
  delete process.env.STRIPE_PRICE_ID;
  delete process.env.STRIPE_TRIAL_DAYS;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('planCatalogue', () => {
  it('parses a full catalogue', () => {
    process.env.BILLING_PLANS = CATALOGUE;
    const all = planCatalogue();
    expect(all.map((p) => p.key)).toEqual(['solo-monthly', 'solo-yearly', 'team-monthly', 'enterprise']);
    expect(all.find((p) => p.key === 'team-monthly')?.seats).toBe('per_seat');
    expect(all.find((p) => p.key === 'enterprise')?.priceId).toBeUndefined();
  });

  it('falls back to the legacy single price rather than breaking an existing deploy', () => {
    process.env.STRIPE_PRICE_ID = 'price_legacy';
    const all = planCatalogue();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ key: 'default', priceId: 'price_legacy', seats: 'fixed' });
  });

  it('survives malformed JSON instead of crashing the server', () => {
    process.env.BILLING_PLANS = '{not json';
    process.env.STRIPE_PRICE_ID = 'price_legacy';
    expect(planCatalogue().map((p) => p.key)).toEqual(['default']);
  });

  it('returns [] when nothing at all is configured', () => {
    expect(planCatalogue()).toEqual([]);
  });

  it('drops entries that have neither a price nor a contact', () => {
    process.env.BILLING_PLANS = JSON.stringify([
      { key: 'ghost', label: 'Ghost' },
      { key: 'real', label: 'Real', priceId: 'price_x' },
    ]);
    expect(planCatalogue().map((p) => p.key)).toEqual(['real']);
  });
});

describe('findPlan', () => {
  beforeEach(() => { process.env.BILLING_PLANS = CATALOGUE; });

  it('finds by key', () => {
    expect(findPlan('team-monthly')?.label).toBe('Team');
  });

  it('returns null for an unknown key rather than silently selling something else', () => {
    expect(findPlan('nope')).toBeNull();
  });

  it('defaults to the first self-serve plan when no key is given', () => {
    expect(findPlan(null)?.key).toBe('solo-monthly');
  });
});

describe('resolveLine — seats', () => {
  beforeEach(() => { process.env.BILLING_PLANS = CATALOGUE; });

  it('forces quantity 1 on a fixed plan even when the client asks for more', () => {
    const r = resolveLine('solo-monthly', 25, 1);
    expect(isPlanError(r)).toBe(false);
    if (!isPlanError(r)) expect(r.quantity).toBe(1);
  });

  it('bills the requested seats on a per-seat plan', () => {
    const r = resolveLine('team-monthly', 5, 3);
    if (isPlanError(r)) throw new Error(r.message);
    expect(r.quantity).toBe(5);
    expect(r.plan.priceId).toBe('price_team_m');
  });

  it('refuses fewer seats than the team has members', () => {
    const r = resolveLine('team-monthly', 2, 10);
    expect(isPlanError(r)).toBe(true);
    if (isPlanError(r)) {
      expect(r.code).toBe('bad_seats');
      expect(r.message).toContain('10 member(s)');
    }
  });

  it('enforces the plan minimum', () => {
    const r = resolveLine('team-monthly', 1, 1);
    expect(isPlanError(r)).toBe(true);
    if (isPlanError(r)) expect(r.message).toContain('at least 2 seats');
  });

  it('allows buying headroom above the member count', () => {
    const r = resolveLine('team-monthly', 20, 3);
    if (isPlanError(r)) throw new Error(r.message);
    expect(r.quantity).toBe(20);
  });

  it('enforces the plan maximum', () => {
    const r = resolveLine('team-monthly', 51, 3);
    expect(isPlanError(r)).toBe(true);
    if (isPlanError(r)) expect(r.message).toContain('tops out at 50');
  });

  it('defaults seats to the floor when none is supplied', () => {
    const r = resolveLine('team-monthly', undefined, 4);
    if (isPlanError(r)) throw new Error(r.message);
    expect(r.quantity).toBe(4);
  });

  it.each([0, -3, 2.5, 'lots', NaN])('rejects a non-positive-integer seat count: %s', (bad) => {
    const r = resolveLine('team-monthly', bad, 1);
    expect(isPlanError(r)).toBe(true);
  });
});

describe('resolveLine — plan kinds', () => {
  beforeEach(() => { process.env.BILLING_PLANS = CATALOGUE; });

  it('refuses enterprise as contact-only, with the address', () => {
    const r = resolveLine('enterprise', 1, 1);
    expect(isPlanError(r)).toBe(true);
    if (isPlanError(r) && r.code === 'contact_only') {
      expect(r.contact).toBe('contact@chatrecall.dev');
    } else {
      throw new Error('expected contact_only');
    }
  });

  it('reports an unknown plan', () => {
    const r = resolveLine('platinum', 1, 1);
    expect(isPlanError(r)).toBe(true);
    if (isPlanError(r)) expect(r.code).toBe('unknown_plan');
  });

  it('reports no configuration at all', () => {
    delete process.env.BILLING_PLANS;
    const r = resolveLine(null, 1, 1);
    expect(isPlanError(r)).toBe(true);
    if (isPlanError(r)) expect(r.code).toBe('unknown_plan');
  });

  it('sells the yearly plan when asked for it', () => {
    const r = resolveLine('solo-yearly', undefined, 1);
    if (isPlanError(r)) throw new Error(r.message);
    expect(r.plan.priceId).toBe('price_solo_y');
  });
});

describe('trialDays', () => {
  it('defaults to 7', () => {
    expect(trialDays()).toBe(7);
  });

  it('honours the env override', () => {
    process.env.STRIPE_TRIAL_DAYS = '14';
    expect(trialDays()).toBe(14);
  });

  it('falls back to 7 on a garbage value rather than 0 days of trial', () => {
    process.env.STRIPE_TRIAL_DAYS = 'abc';
    expect(trialDays()).toBe(7);
  });
});
