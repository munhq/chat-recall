/**
 * Promotion codes are refused on the self-hosted line.
 *
 * A coupon can be limited to products with `applies_to.products`, but this
 * account's API drops the field silently — absent from the coupon object on every
 * API version tried (2023-10-16 through 2026-07-29.dahlia), and there is no
 * /v1/promotions endpoint either — so the limit is Dashboard-only. Both founder
 * coupons are guarded by a minimum spend alone, and two self-hosted seats already
 * clear FOUNDERSOLO's $150.
 */
import { describe, test, expect } from 'vitest';
import { acceptsPromotionCodes } from './billing.js';

describe('self-hosted checkout refuses promotion codes', () => {
  test('THE HOLE THIS CLOSES: no promo box on a self-hosted line', () => {
    expect(acceptsPromotionCodes('selfhost-monthly')).toBe(false);
    expect(acceptsPromotionCodes('selfhost-yearly')).toBe(false);
    expect(acceptsPromotionCodes('SELFHOST-YEARLY')).toBe(false);
  });

  test('the hosted plans still accept them', () => {
    for (const k of ['solo-monthly', 'solo-yearly', 'team-monthly', 'team-yearly', 'enterprise']) {
      expect(acceptsPromotionCodes(k)).toBe(true);
    }
  });

  test('an unknown or missing plan key accepts', () => {
    // Failing the other way would silently kill a launch discount on a plan
    // nobody remembered to list.
    expect(acceptsPromotionCodes('some-future-plan')).toBe(true);
    expect(acceptsPromotionCodes(null)).toBe(true);
    expect(acceptsPromotionCodes(undefined)).toBe(true);
  });

  test('the prefix matches the one licence issuance uses', () => {
    // applyStripeEvent issues a self-host serial on plan.startsWith('selfhost').
    // If the two disagreed, a plan would get a licence with a promo discount, or
    // no licence at all. Asserted so a rename breaks here.
    expect(acceptsPromotionCodes('selfhost')).toBe(false);
  });
});
