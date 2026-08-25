/**
 * The property that matters most is NEGATIVE: measurement must never be able to
 * break a request. So these tests are mostly about what does not happen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIG = { ...process.env };
afterEach(() => { process.env = { ...ORIG }; vi.resetModules(); });
beforeEach(() => { vi.resetModules(); });

async function load(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return import('./growth.js');
}

describe('growthEnabled — all three must be present', () => {
  it('off when METRICS_ENABLED is not exactly "true"', async () => {
    const m = await load({ METRICS_ENABLED: 'yes', METRICS_PRODUCT: 'p', METRICS_DSN: 'postgres://x' });
    expect(m.growthEnabled()).toBe(false);
  });

  it('off when the DSN is missing, even if enabled', async () => {
    const m = await load({ METRICS_ENABLED: 'true', METRICS_PRODUCT: 'p', METRICS_DSN: undefined });
    expect(m.growthEnabled()).toBe(false);
  });

  it('off when the product is missing — an unlabelled event is worse than none', async () => {
    const m = await load({ METRICS_ENABLED: 'true', METRICS_PRODUCT: undefined, METRICS_DSN: 'postgres://x' });
    expect(m.growthEnabled()).toBe(false);
  });

  it('on when all three are present', async () => {
    const m = await load({ METRICS_ENABLED: 'true', METRICS_PRODUCT: 'chat-recall', METRICS_DSN: 'postgres://x' });
    expect(m.growthEnabled()).toBe(true);
  });
});

describe('growth() never throws, in any configuration', () => {
  it('disabled: returns immediately and does nothing', async () => {
    const m = await load({ METRICS_ENABLED: undefined, METRICS_PRODUCT: undefined, METRICS_DSN: undefined });
    expect(() => m.growth('install', { tenant: 't' })).not.toThrow();
  });

  it('enabled with an unreachable DSN: still does not throw', async () => {
    // The port is closed on purpose. A growth database that is down has to be
    // invisible to the caller — this is the whole design.
    const m = await load({
      METRICS_ENABLED: 'true', METRICS_PRODUCT: 'chat-recall',
      METRICS_DSN: 'postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1',
    });
    expect(() => m.growth('activate', { tenant: 't' })).not.toThrow();
    expect(() => m.growth('convert', {})).not.toThrow();
    // Give the detached microtask a chance to reject; an unhandled rejection here
    // would fail the suite, which is exactly the regression we care about.
    await new Promise((r) => setTimeout(r, 300));
    await m.closeGrowth();
  });

  it('a garbage DSN does not throw at call time either', async () => {
    const m = await load({ METRICS_ENABLED: 'true', METRICS_PRODUCT: 'p', METRICS_DSN: 'not-a-dsn' });
    expect(() => m.growth('install', { tenant: 't' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    await m.closeGrowth();
  });

  it('returns void, so it cannot be awaited into the request path by accident', async () => {
    const m = await load({ METRICS_ENABLED: 'true', METRICS_PRODUCT: 'p', METRICS_DSN: 'postgres://x' });
    expect(m.growth('install', {})).toBeUndefined();
    await m.closeGrowth();
  });

  it('closeGrowth is safe when nothing was ever opened', async () => {
    const m = await load({ METRICS_ENABLED: undefined });
    await expect(m.closeGrowth()).resolves.toBeUndefined();
  });
});
