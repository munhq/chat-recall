/**
 * The paid collaboration gate — who may invite a teammate.
 *
 * This exists because the gate cannot be observed in production: openBeta() is
 * on, so collaborationOr402 returns true before it ever looks at a plan. A live
 * smoke test therefore proves the BETA path and says nothing about the paid one,
 * which is the branch that decides whether a Solo subscriber gets Team for free.
 *
 * planGrantsTeam is the whole decision, so the matrix below is the contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { planGrantsTeam } from '../routes/billing.js';

const CATALOGUE = JSON.stringify([
  { key: 'solo-monthly', label: 'Solo', priceId: 'price_solo_m', seats: 'fixed' },
  { key: 'solo-yearly', label: 'Solo', priceId: 'price_solo_y', seats: 'fixed' },
  { key: 'team-monthly', label: 'Team', priceId: 'price_team_m', seats: 'per_seat', minSeats: 2 },
  { key: 'team-yearly', label: 'Team', priceId: 'price_team_y', seats: 'per_seat', minSeats: 2 },
]);

let saved: string | undefined;
beforeEach(() => { saved = process.env.BILLING_PLANS; process.env.BILLING_PLANS = CATALOGUE; });
afterEach(() => { if (saved === undefined) delete process.env.BILLING_PLANS; else process.env.BILLING_PLANS = saved; });

describe('planGrantsTeam — the paid collaboration decision', () => {
  it.each(['team-monthly', 'team-yearly', 'Team-Monthly', 'TEAM-YEARLY', 'enterprise'])(
    'grants team for %s', (plan) => {
      expect(planGrantsTeam(plan)).toBe(true);
    });

  it.each(['solo-monthly', 'solo-yearly', 'Solo-Monthly'])(
    'REFUSES team for %s — this is the revenue leak', (plan) => {
      expect(planGrantsTeam(plan)).toBe(false);
    });

  it.each([null, undefined, ''])('fails closed on %s', (plan) => {
    // A missing plan must not grant team. The entitlement recorded null for every
    // customer before planOf() was fixed, so this is the case that mattered most.
    expect(planGrantsTeam(plan as string | null | undefined)).toBe(false);
  });

  it('fails closed on an unrecognised plan key', () => {
    expect(planGrantsTeam('platinum-unlimited')).toBe(false);
  });

  it('classifies a RAW PRICE ID via the catalogue, not the key name', () => {
    // Older entitlements stored a price id rather than a catalogue key, and a
    // price id carries no hint of its tier — it has to be looked up.
    expect(planGrantsTeam('price_team_m')).toBe(true);
    expect(planGrantsTeam('price_team_y')).toBe(true);
    expect(planGrantsTeam('price_solo_m')).toBe(false);
    expect(planGrantsTeam('price_solo_y')).toBe(false);
  });

  it('fails closed on a price id that is no longer in the catalogue', () => {
    // An archived price: the subscription lives on, the catalogue moved. Granting
    // team to an unknown id would make deleting a price a security change.
    expect(planGrantsTeam('price_deleted_last_year')).toBe(false);
  });

  it('fails closed when no catalogue is configured at all', () => {
    delete process.env.BILLING_PLANS;
    expect(planGrantsTeam('price_team_m')).toBe(false);
    // The prefix rule still works without a catalogue, which is what keeps a
    // key-based entitlement valid during a config gap.
    expect(planGrantsTeam('team-monthly')).toBe(true);
  });
});
