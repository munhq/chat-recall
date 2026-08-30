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
import { trialEndingMail } from '../auth/mailer.js';

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

describe('the copy says what actually happens', () => {
  // A Stripe trial only exists after checkout, so a card is ALWAYS on file here.
  // "Do nothing" therefore means "you are charged", not "you lose access". This
  // block exists because the copy asserted the opposite for months: it reused the
  // no-card reminder's wording on the card-trial's trigger, and so warned a
  // paying customer that their access was ending three days before billing them.
  const mail = trialEndingMail('buyer@example.com', new Date(TRIAL_END * 1000), 'https://x.test/app?view=account');
  // Assert on content, not on where the hand-wrapped lines happen to break.
  const flat = mail.text.replace(/\s+/g, ' ');

  test('leads with the date, in the subject and the body', () => {
    const day = new Date(TRIAL_END * 1000).toISOString().slice(0, 10);
    expect(mail.subject).toContain(day);
    expect(mail.text).toContain(day);
  });

  test('says the subscription STARTS — it never claims access is ending', () => {
    expect(mail.subject).toMatch(/subscription starts/i);
    expect(flat).toMatch(/card on file/i);
    expect(flat).toMatch(/subscription starts the same day/i);
    // The exact three phrases from the no-card reminder that must never appear
    // in front of someone who is about to be charged.
    expect(flat).not.toMatch(/recall switches off/i);
    expect(flat).not.toMatch(/searches stop/i);
    expect(flat).not.toMatch(/stop syncing/i);
  });

  test('names the cancel path, because a surprise charge is what causes disputes', () => {
    expect(flat).toMatch(/cancel before/i);
    expect(mail.text).toContain('https://x.test/app?view=account');
    expect(flat).toMatch(/will not be charged/i);
  });

  test('keeps the promises that are still true', () => {
    expect(flat).toMatch(/deletes nothing/i);
    expect(flat).toMatch(/export always works/i);
    expect(flat).not.toMatch(/searchable/i);
  });

  test('falls back to this deployment account page when no url is passed', () => {
    const m = trialEndingMail('buyer@example.com', new Date(TRIAL_END * 1000));
    expect(m.text).toContain('/app?view=account');
  });
});
