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
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '@chat-recall/engine/test-support/home-env.js';

let tmpHome: string;
const origHome = homeEnvSnapshot();
let app: Express;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'conv-'));
  useHomeDir(tmpHome);
  app = express();
  app.use(express.json());
  app.use('/api/conversations', conversationsRouter);
});
afterAll(() => {
  restoreHomeEnv(origHome);
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

describe('GET /api/conversations/:id/outcome/badge', () => {
  test('404 for unknown Claude session id', async () => {
    const res = await request(app).get('/api/conversations/zzz-nonexistent/outcome/badge');
    expect(res.status).toBe(404);
  });

  test('404 for unknown Codex session id', async () => {
    // Same 404 contract for non-Claude tools — when the session truly
    // doesn't exist (no rollout file, no MemoryStore row), the endpoint
    // should fail rather than return a phantom badge.
    const res = await request(app).get('/api/conversations/codex_no-such-session/outcome/badge');
    expect(res.status).toBe(404);
  });

  test('404 for unknown Gemini/OpenCode session ids', async () => {
    // Both go through the MemoryStore lookup path.
    const r1 = await request(app).get('/api/conversations/gemini_no-such-session/outcome/badge');
    const r2 = await request(app).get('/api/conversations/opencode_no-such-session/outcome/badge');
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
  });
});
