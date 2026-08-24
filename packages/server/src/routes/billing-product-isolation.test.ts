/**
 * One Stripe account, more than one product.
 *
 * Stripe fans an event out to EVERY enabled endpoint subscribed to that event
 * type. It does not route by product. So the moment a second product is sold on
 * this account, its `customer.subscription.*` events arrive at chat-recall's
 * webhook as well — and `tenantOf()` accepts any `client_reference_id` or
 * `metadata.tenant` it is given. Two products built on the same identity
 * provider produce colliding tenant ids by construction.
 *
 * The failure that follows is silent and it is revenue: buy product B, get a
 * paid chat-recall entitlement. No error, no log, nothing to notice.
 *
 * These tests pin the guard from both ends, because it has two independent
 * layers and each one covers what the other cannot:
 *
 *   1. metadata.product — decisive, but only if the other product stamps it.
 *   2. the price id — needs no cooperation from the other product at all, but
 *      only works on events that carry items[].
 *
 * And the third case, which is the one a hardening change tends to break:
 * an UNTAGGED event carrying a price we do sell must still be honoured. Every
 * subscription bought before the tag existed is untagged, and failing closed on
 * absence would stop renewals for the customers who are already paying.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { applyStripeEvent } from './billing.js';

function spyCp() {
  const writes: Array<{ tenant: string; e: Record<string, unknown> }> = [];
  return {
    writes,
    async setEntitlement(tenant: string, e: Record<string, unknown>) {
      writes.push({ tenant, e });
    },
  };
}

const OURS = 'price_ours_solo_monthly';
const THEIRS = 'price_other_product_monthly';

const subEvent = (o: Record<string, unknown> = {}) => ({
  type: 'customer.subscription.updated',
  data: {
    object: {
      id: 'sub_1',
      status: 'active',
      metadata: { tenant: 'acme' },
      items: { data: [{ price: { id: OURS } }] },
      ...o,
    },
  },
}) as unknown as Parameters<typeof applyStripeEvent>[0];

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['BILLING_PLANS', 'STRIPE_PRODUCT_TAG', 'STRIPE_PRICE_ID']) saved[k] = process.env[k];
  process.env.BILLING_PLANS = JSON.stringify([
    { key: 'solo-monthly', label: 'Solo', priceId: OURS, seats: 'fixed' },
  ]);
  delete process.env.STRIPE_PRICE_ID;
  delete process.env.STRIPE_PRODUCT_TAG;   // default tag
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('layer 1 — the product tag', () => {
  test("THE POINT: another product's subscription grants nothing here", async () => {
    const cp = spyCp();
    const out = await applyStripeEvent(
      subEvent({ metadata: { tenant: 'acme', product: 'example-app' } }),
      cp,
    );
    expect(cp.writes).toEqual([]);
    expect(out).toBeNull();
  });

  test('our own tag is honoured', async () => {
    const cp = spyCp();
    await applyStripeEvent(subEvent({ metadata: { tenant: 'acme', product: 'chat-recall' } }), cp);
    expect(cp.writes).toHaveLength(1);
    expect(cp.writes[0].e.status).toBe('active');
  });

  test('STRIPE_PRODUCT_TAG renames what counts as ours', async () => {
    // A second chat-recall deployment on the same account (staging, a rebrand)
    // must be able to disagree with this one about which events are its own.
    process.env.STRIPE_PRODUCT_TAG = 'chat-recall-staging';
    const cp = spyCp();
    await applyStripeEvent(subEvent({ metadata: { tenant: 'acme', product: 'chat-recall' } }), cp);
    expect(cp.writes).toEqual([]);
  });
});

describe('layer 2 — the price id, when the other product stamps nothing', () => {
  test("an untagged foreign price is rejected without the other product's help", async () => {
    const cp = spyCp();
    const out = await applyStripeEvent(
      subEvent({ items: { data: [{ price: { id: THEIRS } }] } }),
      cp,
    );
    expect(cp.writes).toEqual([]);
    expect(out).toBeNull();
  });

  test('the tag wins over the price when both are present', async () => {
    // A plan bought before it was added to BILLING_PLANS is still ours, and the
    // tag says so outright. Judging it by the catalogue would drop it.
    const cp = spyCp();
    await applyStripeEvent(subEvent({
      metadata: { tenant: 'acme', product: 'chat-recall' },
      items: { data: [{ price: { id: 'price_retired_grandfathered' } }] },
    }), cp);
    expect(cp.writes).toHaveLength(1);
  });
});

describe('absence is fail-OPEN, on purpose', () => {
  test('THE REGRESSION THIS BLOCKS: an untagged renewal of a price we sell still applies', async () => {
    // Every live subscription predates the tag. If this ever fails, existing
    // paying customers stop renewing — silently, on the next billing cycle.
    const cp = spyCp();
    await applyStripeEvent(subEvent(), cp);
    expect(cp.writes).toHaveLength(1);
    expect(cp.writes[0].e.status).toBe('active');
  });

  test('a legacy single-price deployment is never judged by an empty catalogue', async () => {
    delete process.env.BILLING_PLANS;
    process.env.STRIPE_PRICE_ID = 'price_legacy';
    const cp = spyCp();
    await applyStripeEvent(subEvent({ items: { data: [{ price: { id: 'price_legacy' } }] } }), cp);
    expect(cp.writes).toHaveLength(1);
  });

  test('checkout.session.completed has no items[] and is judged by the tag alone', async () => {
    const cp = spyCp();
    const ev = {
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'acme',
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { tenant: 'acme', plan: 'solo-monthly', product: 'example-app' },
        },
      },
    } as unknown as Parameters<typeof applyStripeEvent>[0];
    await applyStripeEvent(ev, cp);
    expect(cp.writes).toEqual([]);
  });
});
