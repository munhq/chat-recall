/**
 * Integration tests for the Model-B sync-intent queue: enqueue → drain →
 * ack against the real tenant store.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HERMETIC: without CHAT_RECALL_DATA_DIR this suite wrote its intents into the
// DEVELOPER'S real ~/.chat-recall store — every run leaked one pending
// sync_all intent into the real queue (the watch daemon would try to execute
// them!), and once the real queue crossed the pending-list's oldest-first
// LIMIT 50, the round-trip test started failing on unrelated data. Env must
// be set BEFORE the route module loads (store path resolves at import).
let tmpDir: string;
let app: Express;
const origDataDir = process.env.CHAT_RECALL_DATA_DIR;
const origStripe = process.env.STRIPE_SECRET_KEY;
const TENANT = 'intents-test';
beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sync-intents-'));
  process.env.CHAT_RECALL_DATA_DIR = tmpDir;
  // ENQUEUE is toolkit-gated (the free plan excludes it), so the harness runs
  // as a cloud tenant on a live Team plan: billing on, an entitlement row in
  // the hermetic control plane, and req.tenant pinned like tenantAuth would.
  process.env.STRIPE_SECRET_KEY = 'sk_test_sync_intents';
  const { createControlPlane } = await import('../imports.js');
  const cp = await createControlPlane();
  try {
    await cp.setEntitlement(TENANT, { plan: 'team-monthly', status: 'active', currentPeriodEnd: Date.now() + 86_400_000 });
  } finally { await cp.close(); }
  const { clearEntitlementCache } = await import('../util/billing.js');
  clearEntitlementCache();
  const syncIntentsRouter = (await import('./sync-intents.js')).default;
  app = express();
  app.use((req, _res, next) => { (req as express.Request).tenant = TENANT; next(); });
  app.use(express.json());
  app.use('/api/sync-intents', syncIntentsRouter);
});
afterAll(() => {
  if (origDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = origDataDir;
  if (origStripe === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = origStripe;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/sync-intents (validation)', () => {
  test('rejects unknown kind', async () => {
    const res = await request(app).post('/api/sync-intents').send({ kind: 'wat' });
    expect(res.status).toBe(400);
  });
  test('copy requires type/name/tools', async () => {
    const res = await request(app).post('/api/sync-intents').send({ kind: 'copy', name: 'x' });
    expect(res.status).toBe(400);
  });
  test('copy rejects same from/to tool', async () => {
    const res = await request(app).post('/api/sync-intents')
      .send({ kind: 'copy', artifactType: 'skill', name: 'x', fromTool: 'claude', toTool: 'claude' });
    expect(res.status).toBe(400);
  });

  test('a FREE tenant may not enqueue, but may still drain — the lapse contract', async () => {
    // Enqueue executes the cross-tool toolkit sync, which the free plan
    // excludes; before the gate, the only stop was requireEntitlement's blanket
    // write-402, which the free tier removed. Draining stays open so a CLI can
    // finish intents enqueued while the tenant was entitled.
    const { createControlPlane } = await import('../imports.js');
    const { clearEntitlementCache } = await import('../util/billing.js');
    const cp = await createControlPlane();
    try {
      await cp.setEntitlement(TENANT, { currentPeriodEnd: 1000 });   // lapse it
    } finally { await cp.close(); }
    clearEntitlementCache();
    const refused = await request(app).post('/api/sync-intents').send({ kind: 'sync_all' });
    expect(refused.status).toBe(402);
    expect(refused.body.feature).toBe('toolkit');
    const drain = await request(app).get('/api/sync-intents/pending');
    expect(drain.status).toBe(200);
    // Restore the live plan for the tests that follow.
    const cp2 = await createControlPlane();
    try {
      await cp2.setEntitlement(TENANT, { currentPeriodEnd: Date.now() + 86_400_000 });
    } finally { await cp2.close(); }
    clearEntitlementCache();
  });

  test('copy ACCEPTS the instructions (Rules/MD) artifact type', async () => {
    // Regression: VALID_TYPES was hardcoded to {skill,mcp,command,agent}, so
    // every `instructions` copy the client + engine support was 400'd — the
    // exact "POST /api/sync-intents 400" the sync UI hit. VALID_TYPES now derives
    // from the engine's ALL_SYNC_TYPES, which includes `instructions`.
    const res = await request(app).post('/api/sync-intents')
      .send({ kind: 'copy', artifactType: 'instructions', name: 'CLAUDE.md', fromTool: 'claude', toTool: 'gemini' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('enqueue → pending → ack round-trip', () => {
  test('a sync_all intent is enqueued, appears in pending, then acked away', async () => {
    const enq = await request(app).post('/api/sync-intents').send({ kind: 'sync_all' });
    expect(enq.status).toBe(200);
    const id = enq.body.id as string;
    expect(id).toMatch(/^si_/);

    // It shows up in the (untargeted) pending list.
    const pending = await request(app).get('/api/sync-intents/pending');
    expect(pending.status).toBe(200);
    expect((pending.body.intents as any[]).some(i => i.id === id)).toBe(true);

    // Ack it done.
    const ack = await request(app).post(`/api/sync-intents/${id}/ack`).send({ status: 'done', result: '{"copied":3}' });
    expect(ack.status).toBe(200);

    // No longer pending.
    const after = await request(app).get('/api/sync-intents/pending');
    expect((after.body.intents as any[]).some(i => i.id === id)).toBe(false);

    // But visible in the recent list with status done.
    const recent = await request(app).get('/api/sync-intents?limit=100');
    const row = (recent.body.intents as any[]).find(i => i.id === id);
    expect(row?.status).toBe('done');
  });

  test('ack of a missing intent is 404', async () => {
    const res = await request(app).post('/api/sync-intents/si_does_not_exist/ack').send({ status: 'done' });
    expect(res.status).toBe(404);
  });

  test('a copy intent carries its fields through to pending', async () => {
    const enq = await request(app).post('/api/sync-intents')
      .send({ kind: 'copy', artifactType: 'command', name: 'review', fromTool: 'claude', toTool: 'gemini' });
    expect(enq.status).toBe(200);
    const pending = await request(app).get('/api/sync-intents/pending?limit=100');
    const row = (pending.body.intents as any[]).find(i => i.id === enq.body.id);
    expect(row.kind).toBe('copy');
    expect(row.artifact_type).toBe('command');
    expect(row.name).toBe('review');
    expect(row.from_tool).toBe('claude');
    expect(row.to_tool).toBe('gemini');
  });
});
