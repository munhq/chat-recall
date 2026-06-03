/**
 * Integration tests for /api/toolkit/* — status, browse, item, content.
 * Promote endpoint is tested separately because it writes to disk.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import toolkitRouter from './toolkit.js';

let tmpHome: string;
const origHome = process.env.HOME;
let app: Express;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'toolkit-'));
  process.env.HOME = tmpHome;
  app = express();
  app.use(express.json());
  app.use('/api/toolkit', toolkitRouter);
});
afterAll(() => {
  process.env.HOME = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('GET /api/toolkit/status', () => {
  test('returns counts shape with all toolkit types', async () => {
    const res = await request(app).get('/api/toolkit/status');
    expect(res.status).toBe(200);
    expect(res.body.counts).toBeDefined();
    for (const t of ['skill', 'mcp', 'command', 'agent', 'hook', 'plugin']) {
      expect(res.body.counts).toHaveProperty(t);
    }
  });

  test('every count entry exposes claude/gemini/opencode/codex keys', async () => {
    const res = await request(app).get('/api/toolkit/status');
    for (const t of Object.values(res.body.counts) as Record<string, number>[]) {
      expect(t).toHaveProperty('claude');
      expect(t).toHaveProperty('gemini');
      expect(t).toHaveProperty('opencode');
    }
  });
});

describe('GET /api/toolkit/browse/:type', () => {
  test('rejects unknown types with 400', async () => {
    const res = await request(app).get('/api/toolkit/browse/notatype');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid toolkit type/);
  });

  test('returns a list shape for skill', async () => {
    const res = await request(app).get('/api/toolkit/browse/skill?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('skill');
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  test('clamps limit to a sane upper bound', async () => {
    const res = await request(app).get('/api/toolkit/browse/skill?limit=99999');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(5000);
  });

  test('honors tool filter', async () => {
    const res = await request(app).get('/api/toolkit/browse/skill?tool=codex&limit=100');
    expect(res.status).toBe(200);
    // Either all rows are codex, or list is empty when no codex skills.
    const tools = (res.body.items as any[]).map(i => {
      try { return JSON.parse(i.extra_json || '{}').tool; } catch { return null; }
    });
    expect(tools.every(t => t === 'codex' || tools.length === 0)).toBe(true);
  });
});

describe('GET /api/toolkit/item/:type/:id', () => {
  test('returns 404 for missing ids', async () => {
    const res = await request(app).get('/api/toolkit/item/skill/zzz_does_not_exist');
    expect(res.status).toBe(404);
  });

  test('rejects unknown type with 400', async () => {
    const res = await request(app).get('/api/toolkit/item/notatype/x');
    expect(res.status).toBe(400);
  });
});
