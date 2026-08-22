/**
 * Regenerate-summary retry behavior (generateSummaryWithRetry) — a transient
 * upstream failure (gateway 5xx/429, dropped connection) must be retried with
 * backoff instead of surfacing to the user; non-transient errors must fail
 * fast; a persistent outage must still throw after the attempts run out.
 * Motivated by the 2026-07-03 incident: Ollama Cloud 503'd for ~3s and the
 * raw upstream_failed reached the dashboard on the first click.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import conversationsRouter, { generateSummaryWithRetry } from './conversations.js';
import type { SessionContent } from '../imports.js';

const CONTENT = {} as SessionContent;

function generator(outcomes: Array<string | Error>): { generate: () => Promise<string>; calls: () => number } {
  let i = 0;
  return {
    calls: () => i,
    generate: async () => {
      const o = outcomes[Math.min(i++, outcomes.length - 1)];
      if (o instanceof Error) throw o;
      return o;
    },
  };
}

describe('generateSummaryWithRetry', () => {
  test('retries a transient 502/upstream_failed and returns the eventual summary', async () => {
    const g = generator([
      new Error('openai-compat API error: 502 Bad Gateway {"error":{"code":"upstream_failed","message":"Retryable status=503"}}'),
      'the summary',
    ]);
    await expect(generateSummaryWithRetry(g, CONTENT, 1)).resolves.toBe('the summary');
    expect(g.calls()).toBe(2);
  });

  test('retries a dropped connection (ECONNRESET)', async () => {
    const g = generator([new Error('fetch failed: ECONNRESET'), 'ok']);
    await expect(generateSummaryWithRetry(g, CONTENT, 1)).resolves.toBe('ok');
    expect(g.calls()).toBe(2);
  });

  test('fails fast on a non-transient error (no retry)', async () => {
    const g = generator([new Error('openai-compat embedder requires OPENAI_COMPAT_BASE_URL')]);
    await expect(generateSummaryWithRetry(g, CONTENT, 1)).rejects.toThrow(/OPENAI_COMPAT_BASE_URL/);
    expect(g.calls()).toBe(1);
  });

  test('gives up after 3 attempts on a persistent transient failure', async () => {
    const g = generator([new Error('Retryable status=503')]);
    await expect(generateSummaryWithRetry(g, CONTENT, 1)).rejects.toThrow(/503/);
    expect(g.calls()).toBe(3);
  });
});

/**
 * POST /:id/regenerate-summary — the free-tier gate. A free (lapsed) tenant is
 * refused BEFORE any provider/config/session lookup: the background sweep skips
 * free tenants, so an on-demand path that still generated would be the loophole.
 * The refusal is the canonical featureRequired('insights') 402 payload.
 */
describe('POST /:id/regenerate-summary — free-tier gate', () => {
  let dataDir: string;
  const saved: Record<string, string | undefined> = {
    dataDir: process.env.CHAT_RECALL_DATA_DIR,
    stripe: process.env.STRIPE_SECRET_KEY,
  };

  function appFor(tenant: string): express.Express {
    const app = express();
    app.use(express.json());
    // tenantAuth normally resolves req.tenant; stub just that.
    app.use((req, _res, next) => { (req as any).tenant = tenant; next(); });
    app.use('/api/conversations', conversationsRouter);
    return app;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'regen-gate-'));
    process.env.CHAT_RECALL_DATA_DIR = dataDir;
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { clearEntitlementCache } = await import('../util/billing.js');
    clearEntitlementCache();
    const { createControlPlane } = await import('../imports.js');
    const cp = await createControlPlane();
    try {
      // Lapsed entitlement = the free plan; its existence stops a trial re-grant.
      await cp.setEntitlement('regenfree', {
        status: 'active', plan: 'solo', currentPeriodEnd: Date.now() - 1000,
      });
      await cp.setEntitlement('regenpaid', {
        status: 'active', plan: 'solo', currentPeriodEnd: Date.now() + 86_400_000,
      });
    } finally { await cp.close(); }
  });

  afterAll(async () => {
    for (const [k, env] of [['dataDir', 'CHAT_RECALL_DATA_DIR'], ['stripe', 'STRIPE_SECRET_KEY']] as const) {
      if (saved[k] === undefined) delete process.env[env];
      else process.env[env] = saved[k];
    }
    const { clearEntitlementCache } = await import('../util/billing.js');
    clearEntitlementCache();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('402 with the insights payload for a free (lapsed) tenant', async () => {
    const res = await request(appFor('regenfree'))
      .post('/api/conversations/some-session/regenerate-summary');
    expect(res.status).toBe(402);
    expect(res.body.feature).toBe('insights');
    // The cheapest purchasable tier that restores summaries, never 'trial'.
    expect(res.body.requires).toBe('solo');
    expect(res.body.upgradeUrl).toBeTruthy();
  });

  test('an entitled tenant passes the gate (fails later on the missing session, never 402)', async () => {
    // Full-run interference guard: other suites in the same worker share the
    // process-wide 30s entitlement caches; a stale 'not entitled' answer for
    // this tenant turns the pass-through into a 402.
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    // The gate decision is the only thing under test, so everything AFTER the
    // gate must return immediately — no store, no filesystem, no network.
    //
    // This test was intermittently red: it passed alone and timed out at 30s in
    // a full parallel run, because past the gate the handler did real work
    // whose duration depended on how loaded the machine was. Deleting
    // SUMMARY_PROVIDER was not enough; the developer's .env also supplies the
    // base URLs, so it could still reach a real upstream and retry with backoff.
    //
    // Server mode with NO provider configured hits `if (!config) return 501`
    // as the first statement after the gate. 501 is not 402, which is exactly
    // and only what this test claims.
    const savedEnv = {
      SUMMARY_PROVIDER: process.env.SUMMARY_PROVIDER,
      SUMMARY_BASE_URL: process.env.SUMMARY_BASE_URL,
      SUMMARY_MODEL: process.env.SUMMARY_MODEL,
      OPENAI_COMPAT_BASE_URL: process.env.OPENAI_COMPAT_BASE_URL,
      CHAT_RECALL_SERVER_MODE: process.env.CHAT_RECALL_SERVER_MODE,
    };
    for (const k of Object.keys(savedEnv)) delete process.env[k];
    process.env.CHAT_RECALL_SERVER_MODE = 'server';

    const { clearEntitlementCache } = await import('../util/billing.js');
    clearEntitlementCache();
    const res = await request(appFor('regenpaid'))
      .post('/api/conversations/no-such-session/regenerate-summary');
    expect(res.status).not.toBe(402);
    // And specifically the fast path, so a future change that reintroduces real
    // work after the gate fails here loudly instead of going flaky again.
    expect(res.status).toBe(501);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, 30_000);
});
