/**
 * Integration tests for /api/edits/timeline.
 *
 * Mounts the route on an in-process Express app, with $HOME redirected to
 * an empty temp dir so the live-scan finds no transcripts and we can
 * exercise validation + empty-state paths without touching the dev's data.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import editsRouter from './edits.js';
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '@chat-recall/engine/test-support/home-env.js';

let tmpHome: string;
const origHome = homeEnvSnapshot();
let app: Express;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'edits-'));
  useHomeDir(tmpHome);
  app = express();
  app.use(express.json());
  app.use('/api/edits', editsRouter);
});
afterAll(() => {
  restoreHomeEnv(origHome);
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('GET /api/edits/timeline', () => {
  test('default 24h window returns shape { sinceHours, total, edits }', async () => {
    const res = await request(app).get('/api/edits/timeline');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sinceHours', 24);
    expect(res.body).toHaveProperty('total');
    expect(Array.isArray(res.body.edits)).toBe(true);
  });

  test('empty $HOME returns total=0 (no transcripts to scan)', async () => {
    const res = await request(app).get('/api/edits/timeline?since_hours=1');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.edits).toEqual([]);
  });

  test('rejects since_hours=0', async () => {
    const res = await request(app).get('/api/edits/timeline?since_hours=0');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/since_hours/i);
  });

  test('rejects negative since_hours', async () => {
    const res = await request(app).get('/api/edits/timeline?since_hours=-5');
    expect(res.status).toBe(400);
  });

  test('clamps limit to <=1000', async () => {
    const res = await request(app).get('/api/edits/timeline?limit=99999');
    expect(res.status).toBe(200);
    expect(res.body.edits.length).toBeLessThanOrEqual(1000);
  });

  test('include_reads=true is accepted (default omits read ops)', async () => {
    const r1 = await request(app).get('/api/edits/timeline?since_hours=1&include_reads=true');
    expect(r1.status).toBe(200);
  });
});
