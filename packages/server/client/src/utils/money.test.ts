/**
 * The pricing screen's arithmetic. It is worth testing because it is the copy a
 * buyer reads before paying: a wrong total or an unearned "save" badge is a
 * pricing claim we cannot stand behind.
 */
import { describe, it, expect } from 'vitest';
import { formatMoney, seatTotal, yearlySaving } from './money';

describe('formatMoney', () => {
  it('drops the decimals on a whole amount and keeps them otherwise', () => {
    expect(formatMoney(2500, 'usd')).toBe('$25');
    expect(formatMoney(2550, 'usd')).toBe('$25.50');
  });

  it('renders a missing price as an em dash rather than $0', () => {
    // A contact-only tier has no amount. "$0" would advertise a free plan.
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
  });

  it('survives an unknown currency instead of throwing away the price', () => {
    // Intl throws on a bad code; a card with no price at all is worse.
    const out = formatMoney(1000, 'not-a-currency');
    expect(out).toContain('10.00');
  });

  it('formats zero as a price, not as absent', () => {
    expect(formatMoney(0, 'usd')).toBe('$0');
  });
});

describe('seatTotal', () => {
  it('multiplies the unit price by the seat count', () => {
    expect(seatTotal(2500, 2)).toBe(5000);
    expect(seatTotal(1000, 7)).toBe(7000);
  });

  it('never bills less than one seat', () => {
    expect(seatTotal(2500, 0)).toBe(2500);
    expect(seatTotal(2500, -3)).toBe(2500);
  });

  it('stays absent when the unit price is', () => {
    expect(seatTotal(null, 4)).toBeNull();
  });
});

describe('yearlySaving', () => {
  it('is twelve months at the monthly rate, minus the yearly price', () => {
    // $25/mo vs $250/yr → two months free, and we say the amount, not the claim.
    expect(yearlySaving(2500, 25_000)).toBe(5000);
  });

  it('returns null when yearly is not actually cheaper', () => {
    // The badge was hardcoded "2 months free"; a Stripe price change could make
    // that a lie. No saving, no badge.
    expect(yearlySaving(2500, 30_000)).toBeNull();
    expect(yearlySaving(2500, 40_000)).toBeNull();
  });

  it('returns null when either price is missing', () => {
    expect(yearlySaving(null, 25_000)).toBeNull();
    expect(yearlySaving(2500, undefined)).toBeNull();
  });
});
