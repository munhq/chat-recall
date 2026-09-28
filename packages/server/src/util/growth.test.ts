/**
 * The property that matters most is NEGATIVE: measurement must never be able to
 * break a request. The insert itself is @munhq/product-kit's and is tested there
 * against the real tables; these run the real kit through this server's seam.
 * Skipped on a build without the kit, which is optional and private.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { loadProductKit, productKit } from './product-kit.js';

const ORIG = { ...process.env };
afterEach(() => { process.env = { ...ORIG }; });

await loadProductKit();
const g = await import('./growth.js');

describe.skipIf(!productKit())('through the real kit', () => {
  it('measurement is on only when all three variables are set', () => {
    process.env.METRICS_ENABLED = 'true';
    process.env.METRICS_PRODUCT = 'chat-recall';
    process.env.METRICS_DSN = 'postgres://x';
    expect(g.growthEnabled()).toBe(true);
    process.env.METRICS_ENABLED = 'yes';
    expect(g.growthEnabled()).toBe(false);
    process.env.METRICS_ENABLED = 'true';
    delete process.env.METRICS_PRODUCT;
    expect(g.growthEnabled()).toBe(false);
  });

  it('an unreachable database never reaches the caller', async () => {
    process.env.METRICS_ENABLED = 'true';
    process.env.METRICS_PRODUCT = 'chat-recall';
    process.env.METRICS_DSN = 'postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1';
    expect(() => g.growth('activate', { tenant: 't' })).not.toThrow();
    expect(() => g.recordMailSent({ kind: 'trial.setup.final', recipient: 'a@example.com' })).not.toThrow();
    // An unhandled rejection from the detached insert would fail the suite.
    await new Promise((r) => setTimeout(r, 300));
    await g.closeGrowth();
  });
});
