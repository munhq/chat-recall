/**
 * Integration tests for /api/conversations — recent listing + the
 * /files-live endpoint we added.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import conversationsRouter from './conversations.js';

let tmpHome: string;
const origHome = process.env.HOME;
let app: Express;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'conv-'));
  process.env.HOME = tmpHome;
  app = express();
  app.use(express.json());
  app.use('/api/conversations', conversationsRouter);
});
afterAll(() => {
  process.env.HOME = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('GET /api/conversations/recent', () => {
  test('returns the recent sessions shape', async () => {
    const res = await request(app).get('/api/conversations/recent');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(typeof res.body.count).toBe('number');
  });

  test('honors limit param', async () => {
    const res = await request(app).get('/api/conversations/recent?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.sessions.length).toBeLessThanOrEqual(3);
  });

  test('honors tool filter', async () => {
    const res = await request(app).get('/api/conversations/recent?tool=gemini');
    expect(res.status).toBe(200);
    // All returned sessions (if any) should be gemini.
    expect(res.body.sessions.every((s: { tool?: string }) => (s.tool || 'claude') === 'gemini')).toBe(true);
  });

  test('honors since_hours filter', async () => {
    const res = await request(app).get('/api/conversations/recent?since_hours=1');
    expect(res.status).toBe(200);
    const cutoff = Date.now() - 3600 * 1000;
    expect(res.body.sessions.every((s: { fileMtime?: number }) => (s.fileMtime || 0) >= cutoff)).toBe(true);
  });
});

describe('GET /api/conversations/:id/files-live', () => {
  test('404 for unknown session id', async () => {
    const res = await request(app).get('/api/conversations/zzz-nonexistent/files-live');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/conversations/:id', () => {
  test('404 for unknown session id', async () => {
    const res = await request(app).get('/api/conversations/zzz-nonexistent');
    expect(res.status).toBe(404);
  });
});
