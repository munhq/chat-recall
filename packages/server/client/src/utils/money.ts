/**
 * Money formatting, in one place.
 *
 * Amounts arrive from Stripe in minor units and are never written in our source,
 * so a price change in the Stripe dashboard needs no deploy and our copy can
 * never disagree with the charge. This lived privately inside PlanPicker until a
 * second surface (the feature gate) needed the same rendering; copying it would
 * have let two screens drift on the same number.
 */

/** Minor units → a localised price. Whole amounts drop the ".00". */
export function formatMoney(amount: number | null | undefined, currency?: string): string {
  if (amount == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: (currency || 'usd').toUpperCase(),
      maximumFractionDigits: amount % 100 === 0 ? 0 : 2,
    }).format(amount / 100);
  } catch {
    // An unknown currency code throws rather than degrading, and a pricing card
    // with no price is worse than one with a plain number.
    return `${(amount / 100).toFixed(2)} ${(currency || '').toUpperCase()}`.trim();
  }
}

/**
 * What a per-seat plan actually costs at this seat count.
 *
 * Kept next to the formatter because the two are always used together: showing a
 * unit price without the total is what made buyers ask why they were "buying two
 * of these".
 */
export function seatTotal(amount: number | null | undefined, seats: number): number | null {
  if (amount == null) return null;
  return amount * Math.max(1, seats);
}

/**
 * Yearly saving against twelve months at the monthly rate, in minor units.
 * Returns null when either price is missing or yearly is not actually cheaper —
 * an unearned "save" badge is worse than none.
 */
export function yearlySaving(monthlyAmount?: number | null, yearlyAmount?: number | null): number | null {
  if (monthlyAmount == null || yearlyAmount == null) return null;
  const saving = monthlyAmount * 12 - yearlyAmount;
  return saving > 0 ? saving : null;
}
