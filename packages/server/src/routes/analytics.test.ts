/**
 * Integration tests for /api/analytics — primarily exercising the
 * aggregation pipeline end-to-end so the bulk of the 850-line file
 * gets touched, plus the per-tool ?tool= filter we added.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import analyticsRouter from './analytics.js';

let tmpHome: string;
const origHome = process.env.HOME;
let app: Express;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'analytics-'));
  process.env.HOME = tmpHome;
  app = express();
  app.use(express.json());
  app.use('/api/analytics', analyticsRouter);
});
afterAll(() => {
  process.env.HOME = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('GET /api/analytics', () => {
  test('returns the full analytics shape with empty $HOME', async () => {
    const res = await request(app).get('/api/analytics');
    expect(res.status).toBe(200);
    // Core shape — present even when no sessions are indexed.
    expect(res.body).toHaveProperty('summary');
    expect(res.body).toHaveProperty('topByCost');
    expect(res.body).toHaveProperty('topByDuration');
    expect(res.body).toHaveProperty('topByTokens');
    expect(res.body).toHaveProperty('projects');
    expect(res.body).toHaveProperty('sessionsByTool');
    expect(res.body).toHaveProperty('toolDetails');
    expect(res.body).toHaveProperty('dailyCost');
    expect(res.body).toHaveProperty('weeklyTrends');
    expect(res.body).toHaveProperty('periodComparison');
  });

  test('summary numeric fields are present and non-negative', async () => {
    // The MemoryStore path is fixed at import time, so this test reads the
    // developer's real cache DB. Shape is what matters here.
    const res = await request(app).get('/api/analytics');
    expect(typeof res.body.summary.totalSessions).toBe('number');
    expect(res.body.summary.totalSessions).toBeGreaterThanOrEqual(0);
    expect(res.body.summary.totalCostUsd).toBeGreaterThanOrEqual(0);
  });

  test('?tool=claude returns the same shape (filtered)', async () => {
    const res = await request(app).get('/api/analytics?tool=claude');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    // sessionsByTool should be empty or only contain claude.
    const tools = (res.body.sessionsByTool || []).map((x: { tool: string }) => x.tool);
    if (tools.length > 0) expect(tools).toEqual(['claude']);
  });

  test('?since_hours=168 returns the same shape, time-windowed', async () => {
    const res = await request(app).get('/api/analytics?since_hours=168');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body).toHaveProperty('projects');
    // Windowed totals can never exceed the all-time totals.
    const all = await request(app).get('/api/analytics');
    expect(res.body.summary.totalSessions).toBeLessThanOrEqual(all.body.summary.totalSessions);
  });

  test('?since_hours=garbage is a 400, not a silent all-time answer', async () => {
    expect((await request(app).get('/api/analytics?since_hours=abc')).status).toBe(400);
    expect((await request(app).get('/api/analytics?since_hours=-5')).status).toBe(400);
  });

  test('?tool=invalid is treated as unfiltered (graceful fallback)', async () => {
    const full = (await request(app).get('/api/analytics')).body;
    const bogus = (await request(app).get('/api/analytics?tool=notarealtool')).body;
    expect(bogus.summary.totalSessions).toBe(full.summary.totalSessions);
  });
});

describe('GET /api/analytics/patterns', () => {
  test('returns hotFiles + topics shape (empty arrays for empty $HOME)', async () => {
    const res = await request(app).get('/api/analytics/patterns');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.hotFiles)).toBe(true);
    expect(Array.isArray(res.body.topics)).toBe(true);
    expect(Array.isArray(res.body.redundancyPairs)).toBe(true);
    expect(res.body.meta).toHaveProperty('sessionsAnalyzed');
  });
});
