/**
 * The one decision four call sites used to make separately.
 *
 * It gates a paywall override, so a false positive lets a lapsed tenant past the
 * UI gate; and it gates the licence panel, so a false negative loses a paying
 * customer the only route back to their serial. Both halves are pinned here.
 */
import { describe, it, expect } from 'vitest';
import { isCheckoutSessionId, completedCheckoutSessionId, checkoutReturnPath } from './checkout';

describe('isCheckoutSessionId', () => {
  it('accepts a real Stripe session id', () => {
    expect(isCheckoutSessionId('cs_test_a1b2c3d4e5f6g7h8i9j0')).toBe(true);
    expect(isCheckoutSessionId('cs_live_' + 'A'.repeat(60))).toBe(true);
  });

  it('rejects other Stripe ids and junk', () => {
    for (const bad of ['sub_123', 'cus_123', 'cs_', 'cs_short', '', null, undefined]) {
      expect(isCheckoutSessionId(bad as string), String(bad)).toBe(false);
    }
  });

  it('rejects anything that could escape a path it is interpolated into', () => {
    // This is the security half: the value lands inside a URL path we build.
    for (const bad of [
      'cs_aaaaaaaaaa/../../etc/passwd',
      'cs_aaaaaaaaaa?x=1',
      'cs_aaaaaaaaaa#frag',
      'cs_aaaaaaaaaa&view=admin',
      'cs_aaaaaaaaaa%2F..',
      'cs_aaaaaaaaaa.evil.test',
      '//evil.test/cs_aaaaaaaaaa',
      'cs_aaaaaaaaaa\nSet-Cookie: x=1',
    ]) {
      expect(isCheckoutSessionId(bad), bad).toBe(false);
    }
  });

  it('rejects an over-long id rather than carrying it into a URL', () => {
    expect(isCheckoutSessionId('cs_' + 'a'.repeat(300))).toBe(false);
  });
});

describe('completedCheckoutSessionId', () => {
  it('requires BOTH a success marker and a valid id', () => {
    expect(completedCheckoutSessionId('?checkout=success&session_id=cs_test_a1b2c3d4e5f6'))
      .toBe('cs_test_a1b2c3d4e5f6');
    // An id with no success marker is not a completed purchase.
    expect(completedCheckoutSessionId('?session_id=cs_test_a1b2c3d4e5f6')).toBeNull();
    // A cancelled checkout is not a purchase, whatever id it carries.
    expect(completedCheckoutSessionId('?checkout=cancel&session_id=cs_test_a1b2c3d4e5f6')).toBeNull();
    // Success with a bad id gets nothing — this is the paywall-override input.
    expect(completedCheckoutSessionId('?checkout=success&session_id=nope')).toBeNull();
    expect(completedCheckoutSessionId('?checkout=success')).toBeNull();
    expect(completedCheckoutSessionId('')).toBeNull();
  });

  it('ignores other parameters around it', () => {
    expect(completedCheckoutSessionId('?view=account&checkout=success&session_id=cs_test_a1b2c3d4e5f6&x=1'))
      .toBe('cs_test_a1b2c3d4e5f6');
  });
});

describe('checkoutReturnPath', () => {
  it('lands on the account view, the only place the licence panel renders', () => {
    expect(checkoutReturnPath('?checkout=success&session_id=cs_test_a1b2c3d4e5f6'))
      .toBe('/?view=account&checkout=success&session_id=cs_test_a1b2c3d4e5f6');
  });

  it('is null when there is nothing to carry, so callers keep their own default', () => {
    expect(checkoutReturnPath('?checkout=cancel')).toBeNull();
    expect(checkoutReturnPath('')).toBeNull();
  });

  it('never yields an absolute or protocol-relative destination', () => {
    for (const q of [
      '?checkout=success&session_id=//evil.test',
      '?checkout=success&session_id=https://evil.test',
      '?checkout=success&session_id=cs_aaaaaaaaaa%2F%2Fevil.test',
    ]) {
      const out = checkoutReturnPath(q);
      if (out !== null) {
        expect(out.startsWith('/?view=account')).toBe(true);
        expect(out).not.toMatch(/^\/\//);
        expect(out).not.toMatch(/evil\.test/);
      }
    }
  });
});
