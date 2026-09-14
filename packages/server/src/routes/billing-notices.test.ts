/**
 * The two events that only send mail, and the entitlement they must NOT touch.
 *
 * Both existed as promises with no implementation. The pricing page says, twice,
 * "We email you before the trial ends" — and nothing sent it: the live webhook
 * endpoint was not subscribed to `customer.subscription.trial_will_end`, no case
 * handled it, and no such mail existed. A trial lapsed in silence and the
 * customer found out when sync stopped.
 *
 * `invoice.payment_failed` is deliberately NOT handled: Stripe owns dunning, its
 * Smart Retries pick better times than we could, and its own mail carries a
 * hosted payment-update link. A second email about one event is worse than none.
 *
 * What these tests pin, beyond "a mail goes out":
 *
 *   THE EVENT MAY NOT WRITE AN ENTITLEMENT. During trial_will_end the customer
 *   is still trialing and still entitled. Downgrading here would cut off a
 *   paying customer three days early — and it is the kind of mistake that looks
 *   correct in a diff, which is why it is asserted rather than assumed.
 *
 * The mail transport is not exercised. sendMail's own failure path is already
 * swallowed in the handler (a mail error must not 5xx a webhook, or Stripe
 * retries an event whose entitlement work is done); what matters here is the
 * mapper's contract and the copy the customer receives.
 */
import { describe, test, expect } from 'vitest';
import { applyStripeEvent } from './billing.js';

/** A control plane that records writes instead of performing them. */
function spyCp() {
  const writes: Array<{ tenant: string; e: Record<string, unknown> }> = [];
  return {
    writes,
    async setEntitlement(tenant: string, e: Record<string, unknown>) {
      writes.push({ tenant, e });
    },
  };
}

const TRIAL_END = 1_800_000_000; // epoch seconds

const trialEvent = (o: Record<string, unknown> = {}) => ({
  type: 'customer.subscription.trial_will_end',
  data: {
    object: {
      id: 'sub_1',
      metadata: { tenant: 'acme', email: 'buyer@example.com' },
      status: 'trialing',
      trial_end: TRIAL_END,
      ...o,
    },
  },
}) as unknown as Parameters<typeof applyStripeEvent>[0];

describe('trial_will_end notifies without changing entitlement', () => {
  test('THE POINT: a trialing customer is not downgraded three days early', async () => {
    const cp = spyCp();
    const out = await applyStripeEvent(trialEvent(), cp);
    expect(cp.writes).toEqual([]);
    expect(out).toBeNull();
  });

  test('no email on the subscription means no mail and still no write', async () => {
    const cp = spyCp();
    await applyStripeEvent(trialEvent({ metadata: { tenant: 'acme' } }), cp);
    expect(cp.writes).toEqual([]);
  });

  test('a missing trial_end is tolerated rather than throwing', async () => {
    // Stripe should always send one on this event, but a handler that throws
    // makes Stripe retry forever.
    const cp = spyCp();
    await expect(applyStripeEvent(trialEvent({ trial_end: null }), cp)).resolves.toBeNull();
  });

  test('an event with no tenant is ignored', async () => {
    const cp = spyCp();
    await applyStripeEvent(trialEvent({ metadata: {} }), cp);
    expect(cp.writes).toEqual([]);
  });
});

/*
 * The copy assertions that stood here moved out with the words.
 *
 * They guarded a real regression: the card-trial notice once reused the
 * no-card reminder's wording, so a paying customer was warned their access was
 * ending three days before they were billed. That claim is about WORDING, and
 * the wording is now a pack this repository does not carry.
 *
 * It is guarded where the words live: k8s_gpu/scripts/check-mail-pack.mjs reads
 * the mounted pack, and `billing.trial_ending` is one of the ids it requires to
 * exist. What stays here is which notice fires, and when.
 */
