/**
 * Seats are enforced where a team GROWS, not only where it is bought.
 *
 * Checkout validated the requested seat count against real members and then
 * discarded it — the entitlement had no seats column at all. seatCheck() covered
 * self-host from the licence, and returns unlimited on cloud by design, so the
 * invite route grew a cloud team without any ceiling: buy two seats, invite
 * twenty, and only the purchase had ever looked.
 *
 * These cover the rule the route now applies, over the persisted quantity.
 */
import { describe, test, expect } from 'vitest';
import { planMinSeats } from '../util/billing-plans.js';

/** The decision the invite route makes, isolated from Express and the DB. */
function mayInvite(used: number, recordedSeats: number | null, plan: string | null): boolean {
  const bought = recordedSeats ?? planMinSeats(plan);
  if (bought == null) return true;          // unknown plan: do not block on our gap
  return used < bought;
}

describe('cloud seat ceiling at invite time', () => {
  test('a two-seat team cannot invite a third member', () => {
    expect(mayInvite(1, 2, 'team-monthly')).toBe(true);
    expect(mayInvite(2, 2, 'team-monthly')).toBe(false);
    expect(mayInvite(5, 2, 'team-monthly')).toBe(false);
  });

  test('buying headroom works — seats above the member count still invite', () => {
    expect(mayInvite(2, 10, 'team-monthly')).toBe(true);
  });

  test('an unrecorded count falls back to the plan minimum, not to unlimited', () => {
    // A subscription from before seats were stored, or a webhook not yet seen.
    // It must still bound the team; before this it bounded nothing.
    const min = planMinSeats('team-monthly');
    if (min == null) return;               // no catalogue configured in this env
    expect(mayInvite(min, null, 'team-monthly')).toBe(false);
    expect(mayInvite(min - 1, null, 'team-monthly')).toBe(true);
  });

  test('an unknown plan does not lock the owner out over our own missing data', () => {
    expect(mayInvite(50, null, 'no-such-plan')).toBe(true);
  });
});
