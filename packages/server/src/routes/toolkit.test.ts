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
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '@chat-recall/engine/test-support/home-env.js';

let tmpHome: string;
const origHome = homeEnvSnapshot();
let app: Express;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'toolkit-'));
  useHomeDir(tmpHome);
  app = express();
  app.use(express.json());
  app.use('/api/toolkit', toolkitRouter);
});
afterAll(() => {
  restoreHomeEnv(origHome);
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

  test('every count entry exposes a key for every supported tool', async () => {
    const res = await request(app).get('/api/toolkit/status');
    for (const t of Object.values(res.body.counts) as Record<string, number>[]) {
      expect(t).toHaveProperty('claude');
      expect(t).toHaveProperty('gemini');
      expect(t).toHaveProperty('opencode');
      expect(t).toHaveProperty('codex');
      expect(t).toHaveProperty('agy');
      expect(t).toHaveProperty('cursor');
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

describe('GET /api/toolkit/matrix', () => {
  test('covers all four sync types with id-bearing cells', async () => {
    const res = await request(app).get('/api/toolkit/matrix');
    expect(res.status).toBe(200);
    for (const t of ['skill', 'mcp', 'command', 'agent']) {
      expect(res.body).toHaveProperty(t);
    }
    // supportedTargets covers every tool, not just the original four. This
    // used to assert only four, so the server's copy of the table could (and
    // did) silently lose `agy` without failing.
    const ALL = ['claude', 'gemini', 'opencode', 'codex', 'agy', 'cursor'];
    expect(res.body.supportedTargets.skill).toEqual(expect.arrayContaining(ALL));
    expect(res.body.supportedTargets.command).toEqual(expect.arrayContaining(ALL));
  });
});

describe('POST /api/toolkit/sync-all', () => {
  test('dry-run returns a plan + totalToCopy', async () => {
    const res = await request(app).post('/api/toolkit/sync-all').send({ dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(Array.isArray(res.body.plan)).toBe(true);
    expect(typeof res.body.totalToCopy).toBe('number');
    // Every planned entry is one of the four supported sync types.
    for (const p of res.body.plan as any[]) {
      expect(['skill', 'mcp', 'command', 'agent']).toContain(p.type);
    }
  });

  test('accepts a type filter', async () => {
    const res = await request(app).post('/api/toolkit/sync-all').send({ dryRun: true, types: ['command'] });
    expect(res.status).toBe(200);
    for (const p of res.body.plan as any[]) expect(p.type).toBe('command');
  });
});

// The router-split contract: on a remote server (SaaS / self-host Docker) the
// reads must work (they come from the synced store) while the fs-mutating
// routes refuse cleanly — cross-tool copy there goes via /api/sync-intents.
describe('server mode (no local filesystem)', () => {
  const orig = process.env.CHAT_RECALL_SERVER_MODE;
  beforeAll(() => { process.env.CHAT_RECALL_SERVER_MODE = 'server'; });
  afterAll(() => {
    if (orig === undefined) delete process.env.CHAT_RECALL_SERVER_MODE;
    else process.env.CHAT_RECALL_SERVER_MODE = orig;
  });

  test('matrix read still works in server mode', async () => {
    const res = await request(app).get('/api/toolkit/matrix');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('skill');
  });

  test('browse read still works in server mode', async () => {
    const res = await request(app).get('/api/toolkit/browse/skill?limit=5');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  test('promote (fs write) is refused with 501', async () => {
    const res = await request(app).post('/api/toolkit/promote').send({ type: 'skill', sourceId: 'x', toTool: 'opencode' });
    expect(res.status).toBe(501);
  });

  test('sync-all (fs write) is refused with 501', async () => {
    const res = await request(app).post('/api/toolkit/sync-all').send({ dryRun: true });
    expect(res.status).toBe(501);
  });

  test('delete (fs write) is refused with 501', async () => {
    const res = await request(app).delete('/api/toolkit/item').send({ type: 'skill', name: 'x', tool: 'claude' });
    expect(res.status).toBe(501);
  });
});
