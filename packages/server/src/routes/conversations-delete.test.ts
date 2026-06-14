/**
 * DELETE /api/conversations/:id — purges + tombstones a session so a later
 * sync can't resurrect it (the thin-collector `chat-recall delete` path).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpHome: string;
const origHome = process.env.HOME;
const origDataDir = process.env.CHAT_RECALL_DATA_DIR;
let app: Express;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'conv-del-'));
  process.env.HOME = tmpHome;
  process.env.CHAT_RECALL_DATA_DIR = join(tmpHome, '.chat-recall');
  const conversationsRouter = (await import('./conversations.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api/conversations', conversationsRouter);
});
afterAll(() => {
  process.env.HOME = origHome;
  if (origDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = origDataDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('DELETE /api/conversations/:id', () => {
  const id = 'del-sess-1';

  test('purges the session and records a tombstone', async () => {
    const { createStore } = await import('../imports.js');
    const store = await createStore();
    try {
      await store.setItem({ id, sourceType: 'session', title: 's', projectPath: '/p', filePath: '', mtime: 1000, extra: { tool: 'claude', inputTokens: 1 } });
    } finally { await store.close(); }

    const res = await request(app).delete(`/api/conversations/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(id);

    const check = await createStore();
    try {
      expect(await check.getItem(id, 'session')).toBeNull();
      const dead = (await check.listTombstones()).map((t) => t.session_id);
      expect(dead).toContain(id);
    } finally { await check.close(); }
  });
});
