/**
 * A plan boundary must not present as a broken product.
 *
 * The toolkit view threw `Failed to load toolkit matrix: ${res.statusText}` on a
 * 402. HTTP/2 carries no status text, so every deployed response made that the
 * empty string and a trialing user saw a colon and nothing — a plan boundary
 * reading as a crash, at the exact moment they were deciding whether to pay.
 *
 * `throwForResponse` fixes both halves: it recognises a feature-level 402 as a
 * gate, and it never builds a message out of `statusText` alone.
 */
import { describe, it, expect } from 'vitest';
import { throwForResponse, FeatureGateError } from './api';

/** A Response whose statusText is '' — what HTTP/2 actually delivers. */
function res(status: number, body?: unknown, statusText = ''): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, statusText });
}

describe('throwForResponse', () => {
  it('turns a feature-level 402 into a gate carrying the plan and the upgrade link', async () => {
    const r = res(402, {
      error: 'this feature requires the team plan',
      feature: 'toolkit',
      requires: 'team',
      upgradeUrl: 'https://chatrecall.dev/pricing',
    });

    await expect(throwForResponse(r, 'Failed to load toolkit matrix'))
      .rejects.toBeInstanceOf(FeatureGateError);

    const err = await throwForResponse(r, 'x').catch((e) => e as FeatureGateError);
    expect(err.feature).toBe('toolkit');
    expect(err.requires).toBe('team');
    expect(err.upgradeUrl).toBe('https://chatrecall.dev/pricing');
    expect(err.message).toBe('this feature requires the team plan');
  });

  it('leaves a whole-account 402 as an ordinary error — only a feature gate is a gate', async () => {
    // No `feature` key: the tenant has no live entitlement at all. That is the
    // full-screen paywall's business, not this view's.
    const err = await throwForResponse(res(402, { error: 'subscription required' }), 'Failed')
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(FeatureGateError);
    expect(err.message).toBe('Failed: subscription required');
  });

  it('never produces a bare "what:" when statusText is empty', async () => {
    for (const r of [res(500), res(404), res(403, { error: 'forbidden' })]) {
      const err = await throwForResponse(r, 'Failed to load toolkit matrix').catch((e) => e);
      expect(err.message).not.toMatch(/:\s*$/);
      expect(err.message.length).toBeGreaterThan('Failed to load toolkit matrix: '.length);
    }
  });

  it('prefers the server sentence over the status code', async () => {
    const err = await throwForResponse(res(400, { error: 'device id is required' }), 'Nope')
      .catch((e) => e);
    expect(err.message).toBe('Nope: device id is required');
  });

  it('falls back to the status code for a non-JSON body', async () => {
    const err = await throwForResponse(new Response('<html>gateway</html>', { status: 502 }), 'Nope')
      .catch((e) => e);
    expect(err.message).toBe('Nope: HTTP 502');
  });
});
