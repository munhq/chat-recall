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
