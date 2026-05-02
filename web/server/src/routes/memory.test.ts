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
let app: Express;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'mem-route-'));
  process.env.HOME = tmpHome;
  app = express();
  app.use(express.json());
  app.use('/api/memory', memoryRouter);
});
afterAll(() => {
  process.env.HOME = origHome;
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
});
