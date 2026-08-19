/**
 * Billing spine — gate logic + webhook mapping, with NO live Stripe.
 *
 * Two halves:
 *   1. isEntitled() — the self-host vs cloud gate. Toggles STRIPE_SECRET_KEY
 *      around assertions: self-host (no key) is always entitled; cloud (key set)
 *      is entitled only for an active/unlapsed subscription.
 *   2. applyStripeEvent() — the pure event→setEntitlement mapper, fed fake
 *      event objects directly (no signature verification, no Stripe SDK). Proves
 *      a checkout.session.completed flips the right tenant to active.
 *
 * Isolated CHAT_RECALL_DATA_DIR so the control plane writes to a temp sqlite.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { createControlPlane } from '../imports.js';
import { billingEnabled, isEntitled, clearEntitlementCache } from '../util/billing.js';
import { applyStripeEvent } from './billing.js';
import billingRouter from './billing.js';

let dataDir: string;
const saved: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cr-billing-'));
  setEnv('CHAT_RECALL_DATA_DIR', dataDir);
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Default each test to self-host (no Stripe) unless it opts into cloud.
  setEnv('STRIPE_SECRET_KEY', undefined);
  setEnv('FREE_TRIAL_DAYS', '14');
  // Entitlement lookups are TTL-cached (30s) in-process — reset between tests.
  clearEntitlementCache();
});

describe('billingEnabled / isEntitled gate', () => {
  test('self-host (no STRIPE_SECRET_KEY): billing disabled, every tenant entitled', async () => {
    expect(billingEnabled()).toBe(false);
    expect(await isEntitled('anyone')).toBe(true);
  });

  test('cloud: an unknown tenant is GRANTED the no-card trial and is entitled', async () => {
    setEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    expect(billingEnabled()).toBe(true);
    // The trial is the entry path: first contact provisions a dated entitlement
    // instead of refusing. Access is still decided by a row, not by a flag.
    expect(await isEntitled('cloud-newcomer')).toBe(true);

    const cp = await createControlPlane();
    try {
      const ent = await cp.getEntitlement('cloud-newcomer');
      expect(ent?.status).toBe('trialing');
      // A trial must NOT carry a team plan — collaboration stays paid.
      expect(ent?.plan).toBeNull();
      expect(ent?.stripeSubscriptionId).toBeNull();
      const daysOut = Math.round(((ent!.currentPeriodEnd as number) - Date.now()) / 86_400_000);
      expect(daysOut).toBe(14);
    } finally { await cp.close(); }
  });

  test('cloud: a LAPSED trial is not entitled, and is never re-granted', async () => {
    setEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    const cp = await createControlPlane();
    try {
      // An expired trial: the row exists, so it is the record that a trial was
      // already given. Re-granting here would renew the trial forever.
      await cp.setEntitlement('cloud-expired', {
        status: 'trialing', plan: null, currentPeriodEnd: Date.now() - 1000,
      });
    } finally { await cp.close(); }
    expect(await isEntitled('cloud-expired')).toBe(false);

    const cp2 = await createControlPlane();
    try {
      const ent = await cp2.getEntitlement('cloud-expired');
      expect(ent!.currentPeriodEnd as number).toBeLessThan(Date.now());   // untouched
    } finally { await cp2.close(); }
  });

  test('cloud: canceled subscription is NOT entitled', async () => {
    setEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    const cp = await createControlPlane();
    try {
      await cp.setEntitlement('cloud-canceled', { status: 'canceled' });
    } finally { await cp.close(); }
    expect(await isEntitled('cloud-canceled')).toBe(false);
  });

  test('cloud: active subscription IS entitled', async () => {
    setEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    const cp = await createControlPlane();
    try {
      await cp.setEntitlement('cloud-active', { status: 'active', currentPeriodEnd: Date.now() + 86_400_000 });
    } finally { await cp.close(); }
    expect(await isEntitled('cloud-active')).toBe(true);
  });

  test('cloud: active but LAPSED period is NOT entitled', async () => {
    setEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    const cp = await createControlPlane();
    try {
      await cp.setEntitlement('cloud-lapsed', { status: 'active', currentPeriodEnd: Date.now() - 1000 });
    } finally { await cp.close(); }
    expect(await isEntitled('cloud-lapsed')).toBe(false);
  });

  test('cloud: no env flag can bypass the gate', async () => {
    setEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    // OPEN_BETA used to short-circuit isEntitled() to true, which meant the paid
    // path never ran in production and its defects stayed invisible until GA.
    // Setting it must now do nothing at all.
    setEnv('OPEN_BETA', '1');
    const cp = await createControlPlane();
    try {
      await cp.setEntitlement('cloud-cancelled-in-beta', { status: 'canceled' });
    } finally { await cp.close(); }
    expect(await isEntitled('cloud-cancelled-in-beta')).toBe(false);
  });

  test('cloud: trialing with null period IS entitled', async () => {
    setEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    const cp = await createControlPlane();
    try {
      await cp.setEntitlement('cloud-trial', { status: 'trialing', currentPeriodEnd: null });
    } finally { await cp.close(); }
    expect(await isEntitled('cloud-trial')).toBe(true);
  });
});

describe('applyStripeEvent webhook mapping', () => {
  test('checkout.session.completed with no stamped plan → ids only, never status/plan/period', async () => {
    const calls: Array<{ tenant: string; e: Record<string, unknown> }> = [];
    const fakeCp = {
      async setEntitlement(tenant: string, e: Record<string, unknown>) { calls.push({ tenant, e }); },
    };
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'team-acme',
          customer: 'cus_42',
          subscription: 'sub_42',
        },
      },
    };
    const result = await applyStripeEvent(event, fakeCp);
    expect(result).toEqual({ tenant: 'team-acme', status: 'active' });
    expect(calls).toHaveLength(1);
    expect(calls[0].tenant).toBe('team-acme');
    expect(calls[0].e.stripeCustomerId).toBe('cus_42');
    expect(calls[0].e.stripeSubscriptionId).toBe('sub_42');

    // ANTI-CLOBBER: it fires alongside customer.subscription.created for one
    // purchase and the later write wins, so a status/period written here erases
    // what the subscription event knows. Observed live: it hardcoded 'active'
    // over the accurate 'trialing', and a session has no items[]/trial_end so its
    // period was null and erased the real one. Asserting absence keeps that out.
    expect(calls[0].e.status).toBeUndefined();
    expect(calls[0].e.currentPeriodEnd).toBeUndefined();

    // Plan stays absent when the session does not state one. A session has no
    // items[], so deriving it here would fall through to the STRIPE_PRICE_ID env
    // default and overwrite a correct plan with a stale global value.
    expect(calls[0].e.plan).toBeUndefined();
  });

  test('checkout.session.completed WITH a stamped plan → records the plan', async () => {
    // customer.subscription.created is the only other event that carries a plan,
    // so an endpoint not subscribed to it leaves the entitlement at plan=NULL —
    // and a NULL plan is not team, which denies collaboration to a paying Team
    // customer. /checkout stamps metadata.plan onto the session precisely so this
    // event can record it, making the plan independent of the event subscription.
    const calls: Array<{ tenant: string; e: Record<string, unknown> }> = [];
    const fakeCp = {
      async setEntitlement(tenant: string, e: Record<string, unknown>) { calls.push({ tenant, e }); },
    };
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'team-acme',
          customer: 'cus_42',
          subscription: 'sub_42',
          metadata: { tenant: 'team-acme', plan: 'team-monthly', seats: '3' },
        },
      },
    };
    await applyStripeEvent(event, fakeCp);
    expect(calls[0].e.plan).toBe('team-monthly');
    // Still no status/period from this event — the plan is the sole exception.
    expect(calls[0].e.status).toBeUndefined();
    expect(calls[0].e.currentPeriodEnd).toBeUndefined();
  });

  test('a stamped plan survives a later ids-only session event', async () => {
    // The two events for one purchase land in either order. Replaying them
    // against a real control plane proves the merge keeps the plan either way —
    // this is what a fake setEntitlement cannot show.
    setEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    const cp = await createControlPlane();
    try {
      await applyStripeEvent({
        type: 'customer.subscription.created',
        data: { object: { id: 'sub_m', status: 'trialing', customer: 'cus_m',
                          metadata: { tenant: 'merge-acme', plan: 'team-monthly' } } },
      }, cp);
      await applyStripeEvent({
        type: 'checkout.session.completed',
        data: { object: { client_reference_id: 'merge-acme', customer: 'cus_m', subscription: 'sub_m' } },
      }, cp);
      const ent = await cp.getEntitlement('merge-acme');
      expect(ent?.plan).toBe('team-monthly');   // not erased by the ids-only write
      expect(ent?.status).toBe('trialing');     // nor is the accurate status
    } finally { await cp.close(); }
  });

  test('customer.subscription.updated → maps Stripe status + resolves tenant from metadata', async () => {
    const calls: Array<{ tenant: string; e: Record<string, unknown> }> = [];
    const fakeCp = {
      async setEntitlement(tenant: string, e: Record<string, unknown>) { calls.push({ tenant, e }); },
    };
    const event = {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_99',
          status: 'past_due',
          customer: 'cus_99',
          current_period_end: 2_000_000_000, // seconds
          metadata: { tenant: 'team-beta' },
        },
      },
    };
    const result = await applyStripeEvent(event, fakeCp);
    expect(result).toEqual({ tenant: 'team-beta', status: 'past_due' });
    expect(calls[0].e.currentPeriodEnd).toBe(2_000_000_000 * 1000); // converted to ms
  });

  test('customer.subscription.deleted → canceled', async () => {
    const calls: Array<{ tenant: string; e: Record<string, unknown> }> = [];
    const fakeCp = {
      async setEntitlement(tenant: string, e: Record<string, unknown>) { calls.push({ tenant, e }); },
    };
    const event = {
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_7', metadata: { tenant: 'team-gamma' } } },
    };
    expect(await applyStripeEvent(event, fakeCp)).toEqual({ tenant: 'team-gamma', status: 'canceled' });
    expect(calls[0].e.status).toBe('canceled');
  });

  test('no resolvable tenant → no write, returns null', async () => {
    let wrote = false;
    const fakeCp = { async setEntitlement() { wrote = true; } };
    const event = { type: 'checkout.session.completed', data: { object: { customer: 'cus_x' } } };
    expect(await applyStripeEvent(event, fakeCp)).toBeNull();
    expect(wrote).toBe(false);
  });

  test('unhandled event type → ignored (null), no write', async () => {
    let wrote = false;
    const fakeCp = { async setEntitlement() { wrote = true; } };
    const event = { type: 'invoice.paid', data: { object: { client_reference_id: 't' } } };
    expect(await applyStripeEvent(event, fakeCp)).toBeNull();
    expect(wrote).toBe(false);
  });
});

describe('GET /api/billing/plan (public)', () => {
  test('Stripe unset → { configured:false } with the trial length, no auth', async () => {
    setEnv('STRIPE_SECRET_KEY', undefined);
    setEnv('STRIPE_TRIAL_DAYS', '14');
    const app = express();
    app.use('/api/billing', billingRouter);
    const res = await request(app).get('/api/billing/plan');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.trialDays).toBe(14);
    expect(res.body.openBeta).toBeUndefined();   // the beta flag is gone
  });

  test('the public plan advertises the no-card trial length', async () => {
    setEnv('FREE_TRIAL_DAYS', '21');
    const app = express();
    app.use('/api/billing', billingRouter);
    const res = await request(app).get('/api/billing/plan');
    expect(res.status).toBe(200);
    // The landing page renders this number, so it must follow config and never
    // be hardcoded in the copy.
    expect(res.body.freeTrialDays).toBe(21);
  });
});

describe('POST /api/billing/checkout guards', () => {
  test('501 when billing is not enabled', async () => {
    setEnv('STRIPE_SECRET_KEY', undefined);
    const app = express();
    app.use('/api/billing', billingRouter);
    const res = await request(app).post('/api/billing/checkout');
    expect(res.status).toBe(501);
  });
});
