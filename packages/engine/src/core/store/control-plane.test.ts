/**
 * Control-plane entitlement CRUD (the billing spine's storage half).
 *
 * Proves: setEntitlement creates a row; getEntitlement reads it back; a second
 * setEntitlement UPSERTS in place; and a PARTIAL patch preserves untouched
 * columns (the webhook arrives piecemeal — subscription.updated carries status
 * + period but not the customer id we stored at checkout).
 *
 * SQLite-only here (no DATABASE_URL needed): the pg path shares the exact same
 * merge/coerce helpers, so the semantics are identical by construction.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createControlPlane, type ControlPlane } from './control-plane.js';

let tmp: string;
let cp: ControlPlane;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cr-cp-ent-'));
  cp = await createControlPlane({ sqlitePath: join(tmp, 'cache.db') });
});
afterEach(async () => {
  await cp.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('control-plane entitlements', () => {
  test('absent tenant → null', async () => {
    expect(await cp.getEntitlement('nobody')).toBeNull();
  });

  test('set → get round-trips every field', async () => {
    await cp.setEntitlement('acme', {
      plan: 'price_123',
      status: 'active',
      currentPeriodEnd: 9_999_999_999_000,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
    });
    expect(await cp.getEntitlement('acme')).toEqual({
      tenant: 'acme',
      plan: 'price_123',
      status: 'active',
      currentPeriodEnd: 9_999_999_999_000,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
    });
  });

  test('upsert overwrites supplied fields', async () => {
    await cp.setEntitlement('acme', { status: 'active', plan: 'price_a', stripeCustomerId: 'cus_1' });
    await cp.setEntitlement('acme', { status: 'past_due', plan: 'price_b' });
    const e = await cp.getEntitlement('acme');
    expect(e?.status).toBe('past_due');
    expect(e?.plan).toBe('price_b');
    // stripeCustomerId was NOT in the second patch → preserved.
    expect(e?.stripeCustomerId).toBe('cus_1');
  });

  test('partial patch on a fresh tenant fills the rest with defaults', async () => {
    await cp.setEntitlement('newco', { status: 'trialing' });
    const e = await cp.getEntitlement('newco');
    expect(e).toEqual({
      tenant: 'newco',
      plan: null,
      status: 'trialing',
      currentPeriodEnd: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
  });

  test('unknown status coerces to "none" (fail-closed)', async () => {
    // @ts-expect-error — deliberately feeding a bad status to prove coercion.
    await cp.setEntitlement('weird', { status: 'bogus' });
    expect((await cp.getEntitlement('weird'))?.status).toBe('none');
  });

  test('deleteTenant removes the entitlement row', async () => {
    await cp.ensureTenant('gone');
    await cp.setEntitlement('gone', { status: 'active' });
    expect(await cp.deleteTenant('gone')).toBe(true);
    expect(await cp.getEntitlement('gone')).toBeNull();
  });
});
