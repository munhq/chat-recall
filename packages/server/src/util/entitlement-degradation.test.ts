/**
 * The lapsed-tenant degradation: reads pass, writes get 402.
 *
 * This is the behaviour that replaces locking a lapsed tenant out entirely. It
 * has to be asserted rather than assumed, because both failure directions are
 * silent and bad: too strict and a former customer cannot reach their own
 * history; too loose and an unpaid tenant keeps syncing forever.
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

describe('requireEntitlement degradation', () => {
  test('a LAPSED tenant may READ', async () => {
    await seed('lapsed-read', { status: 'trialing', currentPeriodEnd: Date.now() - 1000 });
    const res = await request(appFor('lapsed-read')).get('/thing');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe('read');
  });

  test('a LAPSED tenant may NOT write, and is told access is read-only', async () => {
    await seed('lapsed-write', { status: 'trialing', currentPeriodEnd: Date.now() - 1000 });
    const res = await request(appFor('lapsed-write')).post('/thing');
    expect(res.status).toBe(402);
    // The message must say the history is kept: a bare "payment required" on a
    // sync failure reads as data loss.
    expect(res.body.detail).toMatch(/read-only/i);
    expect(res.body.detail).toMatch(/kept/i);
    expect(res.body.checkoutHint).toBeTruthy();
  });

  test('a CANCELLED subscriber keeps read access too', async () => {
    // Same principle as a lapsed trial: they may come back, and the data is theirs.
    await seed('churned', { status: 'canceled' });
    expect((await request(appFor('churned')).get('/thing')).status).toBe(200);
    expect((await request(appFor('churned')).post('/thing')).status).toBe(402);
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
