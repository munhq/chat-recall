/**
 * The Stripe Tax switch, and why it defaults to OFF.
 *
 * `automatic_tax` requires a tax behavior on every line item — set on the price,
 * or as the account-level default in Tax settings. On this account all live
 * prices carry `tax_behavior: unspecified` and the default is unset, so a
 * checkout with automatic_tax enabled is rejected by Stripe. Not degraded:
 * rejected. Every purchase on the account fails.
 *
 * So the default here is not a preference, it is the only safe default, and a
 * later "tidy up the env handling" change that makes it default-on takes the
 * whole product's revenue down. That is what the first test guards.
 *
 * The second thing pinned is that the two flags travel together. Tax
 * calculation without VAT id collection charges consumer VAT to EU business
 * buyers who were entitled to reverse charge, and they come back asking for it.
 * There is no configuration where one is wanted alone.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { taxArgs } from './billing.js';

let saved: string | undefined;
beforeEach(() => { saved = process.env.STRIPE_AUTOMATIC_TAX; });
afterEach(() => {
  if (saved === undefined) delete process.env.STRIPE_AUTOMATIC_TAX;
  else process.env.STRIPE_AUTOMATIC_TAX = saved;
});

describe('Stripe Tax is opt-in', () => {
  test('THE OUTAGE THIS BLOCKS: unset means no tax args at all', async () => {
    delete process.env.STRIPE_AUTOMATIC_TAX;
    expect(taxArgs()).toEqual({});
  });

  test('the usual falsy spellings are honoured, not merely truthiness', () => {
    // '0' and 'false' are non-empty strings. A bare `if (process.env.X)` treats
    // both as ON, which is the opposite of what an operator writing
    // STRIPE_AUTOMATIC_TAX=0 to disable it means.
    for (const v of ['0', 'false', 'False', 'FALSE', '']) {
      process.env.STRIPE_AUTOMATIC_TAX = v;
      expect(taxArgs()).toEqual({});
    }
  });

  test('enabled turns on calculation AND VAT id collection together', () => {
    process.env.STRIPE_AUTOMATIC_TAX = '1';
    expect(taxArgs()).toEqual({
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
    });
  });

  test('never emits customer_update, which is an API error without a customer', () => {
    // The checkout session does not pass an existing `customer`; Stripe creates
    // one. Sending customer_update in that case is rejected outright.
    process.env.STRIPE_AUTOMATIC_TAX = 'true';
    expect(Object.keys(taxArgs()).sort()).toEqual(['automatic_tax', 'tax_id_collection']);
  });
});
