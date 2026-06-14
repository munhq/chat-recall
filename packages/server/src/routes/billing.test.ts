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
import { createControlPlane } from '../imports.js';
import { billingEnabled, isEntitled } from '../util/billing.js';
import { applyStripeEvent } from './billing.js';

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
});

describe('billingEnabled / isEntitled gate', () => {
  test('self-host (no STRIPE_SECRET_KEY): billing disabled, every tenant entitled', async () => {
    expect(billingEnabled()).toBe(false);
    expect(await isEntitled('anyone')).toBe(true);
  });

  test('cloud: unknown tenant is NOT entitled (fail-closed)', async () => {
    setEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    expect(billingEnabled()).toBe(true);
    expect(await isEntitled('cloud-no-sub')).toBe(false);
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
  test('checkout.session.completed → active for the client_reference_id tenant', async () => {
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
    expect(calls[0].e.status).toBe('active');
    expect(calls[0].e.stripeCustomerId).toBe('cus_42');
    expect(calls[0].e.stripeSubscriptionId).toBe('sub_42');
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
