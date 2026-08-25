/**
 * The lapsed-tenant HARD STOP: no live entitlement, no answers.
 *
 * requireEntitlement refuses a lapsed tenant with 402 `no_plan`, reads included.
 * Until 2026-08-25 it passed every GET through and let the free tier's feature
 * map decide, which meant a lapsed account kept answering searches from the
 * corpus it held the day it lapsed. That is the failure this file now guards
 * against: a memory product answering from a memory that stopped growing looks
 * broken rather than cheap, and the staleness banner that carried the caveat
 * only reaches an agent that reads banners.
 *
 * Both failure directions stay silent and bad: too loose and a lapsed account
 * quietly serves stale history as if it were current; too strict and the routes
 * a person needs in order to pay us stop working. The second is why /api/data,
 * /api/status, /api/account, /api/billing and /api/teams carry no `paid` gate —
 * see the mounts in server.ts.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { createControlPlane } from '../imports.js';
import { requireEntitlement, clearEntitlementCache } from './billing.js';

let dataDir: string;
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

/** A tiny app that pins req.tenant, then mounts the gate on read and write. */
function appFor(tenant: string) {
  const app = express();
  app.use((req, _res, next) => { (req as any).tenant = tenant; next(); });
  app.use(requireEntitlement);
  app.get('/thing', (_req, res) => { res.json({ ok: 'read' }); });
  app.post('/thing', (_req, res) => { res.json({ ok: 'write' }); });
  return app;
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cr-degrade-'));
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
  setEnv('STRIPE_SECRET_KEY', 'sk_test_x');   // cloud: the gate is live
  clearEntitlementCache();
});

async function seed(tenant: string, patch: Record<string, unknown>) {
  const cp = await createControlPlane();
  try { await cp.setEntitlement(tenant, patch as any); } finally { await cp.close(); }
}

describe('requireEntitlement hard stop', () => {
  test('a LAPSED tenant is REFUSED on a read', async () => {
    // This asserted 200 until 2026-08-25. The read is the whole point: a lapsed
    // account that still answers searches is the failure, not the courtesy.
    await seed('lapsed-read', { status: 'trialing', currentPeriodEnd: Date.now() - 1000 });
    const res = await request(appFor('lapsed-read')).get('/thing');
    expect(res.status).toBe(402);
    expect(res.body.kind).toBe('no_plan');
  });

  test('the refusal names the state, not a feature', async () => {
    // featureRequired('memory') would say "this feature requires the solo plan",
    // which invites the reader to think the rest still works. A dormant account
    // does not lack one capability; it lacks a plan.
    await seed('lapsed-msg', { status: 'trialing', currentPeriodEnd: Date.now() - 1000 });
    const res = await request(appFor('lapsed-msg')).get('/thing');
    expect(res.body.error).toMatch(/no active plan/i);
    // It must still say nothing was lost, or a 402 on your own history reads as
    // deletion — and point at the two things that survive.
    expect(String(res.body.detail)).toMatch(/export/i);
    expect(String(res.body.detail)).toMatch(/sync --full/);
    expect(res.body.upgradeUrl).toBeTruthy();
  });

  test('a LAPSED tenant is refused on a write too', async () => {
    await seed('lapsed-write', { status: 'trialing', currentPeriodEnd: Date.now() - 1000 });
    const res = await request(appFor('lapsed-write')).post('/thing');
    expect(res.status).toBe(402);
    expect(res.body.kind).toBe('no_plan');
  });

  test('a CANCELLED subscriber lands on the same hard stop', async () => {
    await seed('churned', { status: 'canceled' });
    expect((await request(appFor('churned')).get('/thing')).status).toBe(402);
    expect((await request(appFor('churned')).post('/thing')).status).toBe(402);
  });

  test('CORS preflight is never the thing that fails', async () => {
    // A refused OPTIONS makes the browser report a CORS error, which hides the
    // 402 the dashboard needs in order to render the subscribe prompt.
    await seed('lapsed-cors', { status: 'canceled' });
    const res = await request(appFor('lapsed-cors')).options('/thing');
    expect(res.status).not.toBe(402);
  });

  test('an ENTITLED tenant may do both', async () => {
    await seed('paying', { status: 'active', currentPeriodEnd: Date.now() + 86_400_000 });
    expect((await request(appFor('paying')).get('/thing')).status).toBe(200);
    expect((await request(appFor('paying')).post('/thing')).status).toBe(200);
  });

  test('a tenant with no history is trialed, so it may write immediately', async () => {
    // The trial is the entry path; a brand-new tenant must be able to sync.
    const res = await request(appFor('brand-new-tenant')).post('/thing');
    expect(res.status).toBe(200);
  });

  test('no tenant resolved → 401, not a silent pass', async () => {
    const app = express();
    app.use(requireEntitlement);
    app.get('/thing', (_req, res) => { res.json({ ok: true }); });
    const res = await request(app).get('/thing');
    expect(res.status).toBe(401);
  });
});
