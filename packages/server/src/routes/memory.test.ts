/**
 * Integration tests for /api/memory/* — validator + browse error paths.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import memoryRouter from './memory.js';
import { runWithTenant } from '@chat-recall/engine/core/store/tenant-context.js';

let tmpHome: string;
const origHome = process.env.HOME;
const origDataDir = process.env.CHAT_RECALL_DATA_DIR;
let app: Express;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'mem-route-'));
  process.env.HOME = tmpHome;
  // Pin the engine data dir so seeding via createStore and the routes'
  // per-request createStore() resolve the same sqlite file.
  process.env.CHAT_RECALL_DATA_DIR = join(tmpHome, '.chat-recall');
  app = express();
  app.use(express.json());
  app.use('/api/memory', memoryRouter);
});
afterAll(() => {
  process.env.HOME = origHome;
  if (origDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = origDataDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('Memory route validator', () => {
  test('GET /api/memory/browse/skill is REJECTED — skill is a toolkit type', async () => {
    const res = await request(app).get('/api/memory/browse/skill');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid source type/);
  });

  test('GET /api/memory/browse/mcp is REJECTED', async () => {
    const res = await request(app).get('/api/memory/browse/mcp');
    expect(res.status).toBe(400);
  });

  test('GET /api/memory/browse/plan is accepted', async () => {
    const res = await request(app).get('/api/memory/browse/plan?limit=5');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  test('GET /api/memory/browse/notreal returns 400', async () => {
    const res = await request(app).get('/api/memory/browse/notreal');
    expect(res.status).toBe(400);
  });

  test('GET /api/memory/item/:type/:id returns 404 for missing ids', async () => {
    const res = await request(app).get('/api/memory/item/plan/zzz-does-not-exist');
    expect(res.status).toBe(404);
  });

  test('GET /api/memory/status returns shape with bySourceAndTool', async () => {
    const res = await request(app).get('/api/memory/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('bySourceType');
    // bySourceAndTool is the per-tool breakdown my work added.
    expect(res.body).toHaveProperty('bySourceAndTool');
  });

  test('GET /api/memory/wake-up returns highFacts + kg shape', async () => {
    const res = await request(app).get('/api/memory/wake-up');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.highFacts)).toBe(true);
    expect(res.body).toHaveProperty('kg');
    expect(Array.isArray(res.body.kg.facts)).toBe(true);
  });
});

describe('selectWakeUpFacts — wake-up fact cleanup', () => {
  const chunk = (itemId: string, text: string, type = 'assistant:decision:imp5') => ({
    itemId,
    chunkType: type,
    text,
  });

  test('truncates at a word boundary with an ellipsis, not mid-word', async () => {
    const { selectWakeUpFacts } = await import('./memory.js');
    const long = `We chose Postgres over DynamoDB because the relational model fits our join-heavy queries and the team already operates CloudNativePG in production today, verified`;
    const [fact] = selectWakeUpFacts([chunk('i1', long)], 10);
    expect(fact.text.length).toBeLessThanOrEqual(160);
    expect(fact.text.endsWith('…')).toBe(true);
    // The cut lands on a word boundary: the char before the ellipsis is a word end.
    expect(fact.text).toMatch(/\S…$/);
    expect(fact.text).not.toMatch(/\w{1,2}…$/); // no obvious mid-word stump like "verifi…"
  });

  test('drops chunks that start with a mid-word fragment and have no sentence restart', async () => {
    const { selectWakeUpFacts } = await import('./memory.js');
    const facts = selectWakeUpFacts(
      [chunk('i1', 'ed server hardware with very subtle pulsing cyan LED lights and anamorphic lens flare across the whole frame')],
      10,
    );
    expect(facts).toHaveLength(0);
  });

  test('recovers the first clean sentence after a fragment start', async () => {
    const { selectWakeUpFacts } = await import('./memory.js');
    const facts = selectWakeUpFacts(
      [chunk('i1', 'ng the old driver. We chose Postgres over DynamoDB because the relational model fits the workload here.')],
      10,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].text.startsWith('We chose Postgres')).toBe(true);
  });

  test('keeps legitimate lowercase sentence starts', async () => {
    const { selectWakeUpFacts } = await import('./memory.js');
    const facts = selectWakeUpFacts(
      [chunk('i1', 'we decided to keep the sqlite driver for unit tests only, never as a user-facing storage mode')],
      10,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].text.startsWith('we decided')).toBe(true);
  });

  test('dedups near-identical chunks and caps facts per item at 2', async () => {
    const { selectWakeUpFacts } = await import('./memory.js');
    const facts = selectWakeUpFacts(
      [
        chunk('i1', 'Switched the embedder to a 1024-dimension model behind the gateway.'),
        chunk('i2', 'Switched the embedder to a 1024-dimension model behind the gateway.'), // dup text
        chunk('i1', 'Milestone one from the same session: the sync matrix went green.'),
        chunk('i1', 'Milestone two from the same session: the health page shipped.'),
        chunk('i1', 'Milestone three from the same session must be capped away entirely.'),
        chunk('i3', 'A fact from another session survives the per-item cap unharmed.'),
      ],
      10,
    );
    const texts = facts.map((f) => f.text);
    expect(texts.filter((t) => t.startsWith('Switched the embedder'))).toHaveLength(1);
    // i1 contributes at most 2 facts total.
    expect(texts.filter((t) => t.includes('from the same session'))).toHaveLength(1);
    expect(texts.some((t) => t.startsWith('A fact from another session'))).toBe(true);
  });

  test('extracts the classifier type from the chunk tag', async () => {
    const { selectWakeUpFacts } = await import('./memory.js');
    const facts = selectWakeUpFacts(
      [chunk('i1', 'Milestone: all 752 tests green and pushed to main.', 'assistant:milestone:imp4')],
      10,
    );
    expect(facts[0].type).toBe('milestone');
  });
});

describe('GET /api/memory/item/:type/:id/content — server-mode reconstruction', () => {
  test('rebuilds content from stored chunks when the item has no file on disk', async () => {
    const { createStore } = await import('../imports.js');
    const id = 'plan-from-chunks-1';
    const mtime = 1750000000000;

    const store = await createStore();
    try {
      // Seed a synced plan: metadata row with NO usable file_path, plus the
      // FTS chunks that are the canonical server-side copy of its content.
      await store.setItem({
        id,
        sourceType: 'plan',
        title: 'Synced plan',
        projectPath: 'p_synced_proj',
        filePath: '', // synced items carry no local path
        mtime,
        contentPreview: 'Step 1',
      });
      await store.addChunksFTS([
        {
          chunkId: `${id}:plan:0`, itemId: id, sourceType: 'plan',
          title: 'Synced plan', text: 'Step 1: replace the zorbofrang coil',
          chunkType: 'plan_section', projectPath: 'p_synced_proj', filePath: '', mtime,
        },
        {
          chunkId: `${id}:plan:1`, itemId: id, sourceType: 'plan',
          title: 'Synced plan', text: 'Step 2: ship the flux capacitor',
          chunkType: 'plan_section', projectPath: 'p_synced_proj', filePath: '', mtime,
        },
      ]);
    } finally {
      await store.close();
    }

    const res = await request(app).get(`/api/memory/item/plan/${id}/content`);
    expect(res.status).toBe(200);
    expect(res.body.fromChunks).toBe(true);
    // Chunks come back joined in chunk-id order.
    expect(res.body.content).toContain('replace the zorbofrang coil');
    expect(res.body.content).toContain('ship the flux capacitor');
    expect(res.body.content.indexOf('Step 1')).toBeLessThan(res.body.content.indexOf('Step 2'));
  });

  test('404 when the item has neither a file nor any chunks', async () => {
    const { createStore } = await import('../imports.js');
    const id = 'plan-empty-1';
    const store = await createStore();
    try {
      await store.setItem({
        id, sourceType: 'plan', title: 'Empty plan',
        projectPath: 'p_x', filePath: '', mtime: 1750000000001, contentPreview: '',
      });
    } finally {
      await store.close();
    }
    const res = await request(app).get(`/api/memory/item/plan/${id}/content`);
    expect(res.status).toBe(404);
  });
});

describe('cross-tenant response-cache isolation (regression)', () => {
  test('/api/memory/status cached for tenant A is never served to tenant B', async () => {
    // Regression for the pre-multi-tenancy module-level status cache: the
    // first caller's counts were served to EVERY tenant for the 30s TTL.
    // Strategy (works on the single-file sqlite test backend, where store
    // data is shared): warm the cache as tenant A, mutate the store, then
    // read as tenant B. A leak serves B the stale payload A cached; the
    // tenant-scoped cache recomputes for B and sees the new item.
    const tenantApp = express();
    tenantApp.use((req, _res, next) => {
      runWithTenant(String(req.headers['x-test-tenant'] || 'default'), () => next());
    });
    tenantApp.use('/api/memory', memoryRouter);

    const planItems = (body: any): number =>
      Object.values((body.bySourceAndTool?.plan ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);

    const a1 = await request(tenantApp).get('/api/memory/status').set('x-test-tenant', 'team-a');
    expect(a1.status).toBe(200);
    const planCountA = planItems(a1.body);

    const { createStore } = await import('../imports.js');
    const store = await createStore();
    try {
      await store.setItem({
        id: 'iso-plan-1', sourceType: 'plan', title: 'Isolation probe',
        projectPath: 'p_iso', filePath: '', mtime: 1750000000002, contentPreview: 'probe',
      });
    } finally {
      await store.close();
    }

    // Tenant A within the TTL still gets its cached (stale) payload…
    const a2 = await request(tenantApp).get('/api/memory/status').set('x-test-tenant', 'team-a');
    expect(planItems(a2.body)).toBe(planCountA);

    // …but tenant B must NOT inherit A's cache entry: it recomputes and
    // sees the freshly-inserted plan.
    const b1 = await request(tenantApp).get('/api/memory/status').set('x-test-tenant', 'team-b');
    expect(b1.status).toBe(200);
    expect(planItems(b1.body)).toBe(planCountA + 1);
  });
});
