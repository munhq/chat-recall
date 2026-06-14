/**
 * /api/files/redundant — scores a target filename against the filesModified
 * telemetry of synced sessions.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpHome: string;
const origHome = process.env.HOME;
let app: Express;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'files-route-'));
  process.env.HOME = tmpHome;
  const { createStore } = await import('../imports.js');
  const filesRouter = (await import('./files.js')).default;
  const store = await createStore();
  await store.setItem({
    id: 'sess-1', sourceType: 'session', title: 's1', projectPath: '/code/app', filePath: '', mtime: 1000,
    extra: { filesModified: ['/code/app/src/auth.ts', '/code/app/src/util.ts'] },
  });
  await store.close();
  app = express();
  app.use('/api/files', filesRouter);
});
afterAll(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

describe('GET /api/files/redundant', () => {
  test('exact basename match scores 1.0', async () => {
    const res = await request(app).get('/api/files/redundant?filename=auth.ts');
    expect(res.status).toBe(200);
    const top = res.body.hits[0];
    expect(top.file).toBe('/code/app/src/auth.ts');
    expect(top.score).toBe(1.0);
    expect(top.reason).toMatch(/exact basename/);
  });

  test('same stem different extension scores 0.85', async () => {
    const res = await request(app).get('/api/files/redundant?filename=auth.js');
    expect(res.body.hits[0].score).toBe(0.85);
  });

  test('missing filename is 400', async () => {
    const res = await request(app).get('/api/files/redundant');
    expect(res.status).toBe(400);
  });
});
