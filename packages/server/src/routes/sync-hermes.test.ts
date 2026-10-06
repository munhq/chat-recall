/**
 * A Hermes Agent session reaches the server: the sync client builds it from
 * `<hermes home>/state.db` and the real /api/sync route stores it.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SID = '20260801_101500_a1b2c3';
const PROJECT = '/home/user/code/example-app';
const SECRET = 'AKIAIOSFODNN7EXAMPLE';
const T0 = 1785578100;

let home: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'cr-sync-hermes-'));
  const hermesHome = join(home, '.hermes');
  mkdirSync(hermesHome, { recursive: true });
  const env: Record<string, string | undefined> = {
    HOME: home, USERPROFILE: home,
    CHAT_RECALL_DATA_DIR: join(home, '.chat-recall'),
    CHAT_RECALL_HERMES_HOME: hermesHome, HERMES_HOME: undefined,
  };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const db = new DatabaseSync(join(hermesHome, 'state.db'));
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, cwd TEXT,
      git_repo_root TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL,
      last_activity_at REAL, message_count INTEGER DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
      timestamp REAL NOT NULL, display_kind TEXT, active INTEGER NOT NULL DEFAULT 1,
      _compressed_summary INTEGER NOT NULL DEFAULT 0);
  `);
  db.prepare(`INSERT INTO sessions (id, source, title, cwd, started_at, last_activity_at, message_count)
    VALUES (?, 'cli', 'Rotate the deploy key', ?, ?, ?, 4)`).run(SID, PROJECT, T0, T0 + 30);
  const add = db.prepare(`INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  add.run(SID, 'user', `the old key was ${SECRET}, rotate it`, null, null, null, T0);
  add.run(SID, 'assistant', 'Checking the key file.', null,
    JSON.stringify([{ id: 'call_1', type: 'function', function: { name: 'terminal', arguments: '{"command":"cat deploy.env"}' } }]),
    null, T0 + 10);
  add.run(SID, 'tool', '{"output": "KEY=rotated", "exit_code": 0, "error": null}', 'call_1', null, 'terminal', T0 + 20);
  add.run(SID, 'assistant', 'The key is rotated.', null, null, null, T0 + 30);
  db.close();
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
});

describe('a Hermes session syncs', () => {
  test('the server stores its messages and tool calls, with the secret redacted', async () => {
    const { buildConversationSync } = await import('../../../cli/src/sync-client.js');
    const { hermesBackend } = await import('@chat-recall/engine/core/backends/index.js');
    const { createControlPlane, createStore } = await import('../imports.js');
    const syncRouter = (await import('./sync.js')).default;

    const [ref] = hermesBackend.listSessions({ previews: false });
    expect(ref.prefixedId).toBe(`hermes_${SID}`);

    const built = await buildConversationSync(ref, Math.floor(ref.mtime), { includeRaw: true, includeMeta: true });
    expect(built && !('unchanged' in built)).toBe(true);
    const conv = (built as any).conv;
    expect(conv.tool).toBe('hermes');
    expect(conv.first_prompt).toContain('rotate it');
    // The raw dump is scanned too, so the key is a finding.
    expect((built as any).findings.map((f: any) => f.rule)).toContain('aws-access-token');

    const app = express();
    app.use(express.json({ limit: '64mb' }));
    app.use('/api/sync', syncRouter);
    const cp = await createControlPlane();
    const token = await cp.mintAgentToken('default', 'hermes-test');
    await cp.close();
    const r = await request(app).post('/api/sync').set('authorization', `Bearer ${token}`).send({ conversations: [conv] });
    expect(r.status).toBe(200);

    const store = await createStore();
    const stored = JSON.parse((await store.getCachedContentStale(`hermes_${SID}`, 'session'))!.content);
    const raw = await store.getRawSession(`hermes_${SID}`);
    await store.close();
    expect(stored.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(stored.messages[1].toolCalls[0].name).toBe('terminal');
    expect(stored.messages[1].toolCalls[0].result).toContain('KEY=rotated');
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(raw).toBeTruthy();
  }, 120_000);
});
