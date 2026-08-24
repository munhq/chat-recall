/**
 * Tenant sync config over /api/sync-config — the server half of sync
 * exclusions. The dashboard writes it; every device's sync client reads it
 * and unions it with local rules. Pin: defaults are empty, round-trip works,
 * invalid tools are rejected, tenant is required.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prevDataDir: string | undefined;

beforeAll(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-sync-config-test-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function makeApp(tenant?: string) {
  const router = (await import('./sync-config.js')).default;
  const app = express();
  if (tenant) app.use((req, _res, next) => { (req as any).tenant = tenant; next(); });
  app.use('/api/sync-config', router);
  return app;
}

describe('/api/sync-config', () => {
  test('defaults empty → save → read back; unknown fields and dupes dropped', async () => {
    const app = await makeApp('t1');

    const empty = await request(app).get('/api/sync-config');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ excludeTools: [], excludeProjects: [], excludeSources: [], approveSources: [] });

    const saved = await request(app).post('/api/sync-config').send({
      excludeTools: ['gemini', 'gemini'],
      excludeProjects: ['  /home/x/secret  ', '', '.claude-pr-bot'],
      junk: 'ignored',
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ excludeTools: ['gemini'], excludeProjects: ['/home/x/secret', '.claude-pr-bot'], excludeSources: [], approveSources: [] });

    const read = await request(app).get('/api/sync-config');
    expect(read.body).toEqual({ excludeTools: ['gemini'], excludeProjects: ['/home/x/secret', '.claude-pr-bot'], excludeSources: [], approveSources: [] });
  });

  test('invalid tool name → 400; nothing persisted', async () => {
    const app = await makeApp('t2');
    const bad = await request(app).post('/api/sync-config').send({ excludeTools: ['copilot'], excludeProjects: [] });
    expect(bad.status).toBe(400);
    const read = await request(app).get('/api/sync-config');
    expect(read.body).toEqual({ excludeTools: [], excludeProjects: [], excludeSources: [], approveSources: [] });
  });

  test('tenant isolation: t1 rules invisible to t3; no tenant → 401', async () => {
    const t3 = await makeApp('t3');
    const read = await request(t3).get('/api/sync-config');
    expect(read.body).toEqual({ excludeTools: [], excludeProjects: [], excludeSources: [], approveSources: [] });

    const anon = await makeApp();
    expect((await request(anon).get('/api/sync-config')).status).toBe(401);
    expect((await request(anon).post('/api/sync-config').send({ excludeTools: [], excludeProjects: [] })).status).toBe(401);
  });

  test('excludeSources accepts ids only — a path is rejected outright', async () => {
    const app = await makeApp('t4');
    // The endpoint must never become a way to hand collectors a path to read.
    const bad = await request(app).post('/api/sync-config').send({
      excludeTools: [], excludeProjects: [], excludeSources: ['/home/user/.ssh'],
    });
    expect(bad.status).toBe(400);

    const alsoBad = await request(app).post('/api/sync-config').send({
      excludeTools: [], excludeProjects: [], excludeSources: ['src_nothex'],
    });
    expect(alsoBad.status).toBe(400);

    const ok = await request(app).post('/api/sync-config').send({
      excludeTools: [], excludeProjects: [], excludeSources: ['src_0123456789ab'],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.excludeSources).toEqual(['src_0123456789ab']);
  });
});
