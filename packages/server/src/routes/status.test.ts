import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HERMETIC: /api/status counts sessions across every AI tool's home dir. Left
// unset, that walks the DEVELOPER'S real ~/.claude (10k+ sessions on a dogfood
// machine) — this test intermittently timed out under full-suite load for
// exactly that reason. Point every backend at an empty temp tree BEFORE the
// route module loads (import-time path resolution).
let tmpHome: string;
const saved: Record<string, string | undefined> = {};
const VARS = ['CHAT_RECALL_CLAUDE_HOME', 'CHAT_RECALL_GEMINI_HOME', 'CHAT_RECALL_OPENCODE_DB', 'CHAT_RECALL_CODEX_HOME', 'CHAT_RECALL_DATA_DIR'];

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'status-route-'));
  for (const v of VARS) saved[v] = process.env[v];
  process.env.CHAT_RECALL_CLAUDE_HOME = join(tmpHome, '.claude');
  process.env.CHAT_RECALL_GEMINI_HOME = join(tmpHome, '.gemini');
  process.env.CHAT_RECALL_OPENCODE_DB = join(tmpHome, 'opencode.db');
  process.env.CHAT_RECALL_CODEX_HOME = join(tmpHome, '.codex');
  process.env.CHAT_RECALL_DATA_DIR = join(tmpHome, '.chat-recall');
});

afterAll(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('GET /api/status', () => {
  test('returns the status shape (totalChunks, totalSessions, projects, indexPath)', async () => {
    const statusRouter = (await import('./status.js')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/status', statusRouter);

    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalChunks');
    expect(res.body).toHaveProperty('totalSessions');
    expect(res.body).toHaveProperty('projects');
    expect(typeof res.body.totalSessions).toBe('number');
  });
});
