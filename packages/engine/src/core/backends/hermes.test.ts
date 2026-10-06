/**
 * Hermes Agent keeps its chats in SQLite: `<home>/state.db`, and one more for
 * each named profile under `<home>/profiles/<name>/`. These tests build that
 * layout with the columns Hermes writes and read it through the backend, the
 * generic transcript bridge and the archive dump.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir, type HomeEnvSnapshot } from '../../test-support/home-env.js';

const PROJECT = '/home/user/code/example-app';
const SID = '20260801_101500_a1b2c3';
const PROFILE_SID = '20260801_120000_d4e5f6';
const T0 = 1785578100;   // 2026-08-01T10:15:00Z, in seconds as Hermes stores it

let home: string;
let hermesHome: string;
let prevHome: HomeEnvSnapshot;
const savedEnv: Record<string, string | undefined> = {};

function createDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, model TEXT, cwd TEXT,
      git_branch TEXT, git_repo_root TEXT, parent_session_id TEXT,
      started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, last_activity_at REAL,
      message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0, estimated_cost_usd REAL, actual_cost_usd REAL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL,
      display_kind TEXT, active INTEGER NOT NULL DEFAULT 1,
      _compressed_summary INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

type Msg = {
  role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string;
  tool_name?: string; t: number; display_kind?: string; active?: 0 | 1; summary?: 1;
};

function addMessages(db: DatabaseSync, sessionId: string, msgs: Msg[]): void {
  const insert = db.prepare(`INSERT INTO messages
    (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, display_kind, active, _compressed_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const m of msgs) {
    insert.run(sessionId, m.role, m.content ?? null, m.tool_call_id ?? null,
      m.tool_calls ? JSON.stringify(m.tool_calls) : null, m.tool_name ?? null,
      T0 + m.t, m.display_kind ?? null, m.active ?? 1, m.summary ?? 0);
  }
}

const call = (id: string, name: string, args: object) =>
  ({ id, call_id: id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function seedRoot(): void {
  const db = createDb(join(hermesHome, 'state.db'));
  db.prepare(`INSERT INTO sessions (id, source, title, model, cwd, git_repo_root, started_at, last_activity_at, message_count)
    VALUES (?, 'cli', 'Add a health check', 'example-model', ?, ?, ?, ?, 11)`)
    .run(SID, `${PROJECT}/src`, PROJECT, T0, T0 + 50);
  addMessages(db, SID, [
    { role: 'user', content: 'add a health check endpoint', t: 0 },
    { role: 'assistant', content: 'Your request was not processed.', t: 1, display_kind: 'failed_turn' },
    { role: 'assistant', content: 'I will look at the server first.', t: 2, tool_calls: [
      call('call_1', 'terminal', { command: 'ls src' }),
      call('call_2', 'write_file', { path: `${PROJECT}/src/health.ts`, content: 'export const ok = true;\n' }),
    ] },
    { role: 'tool', content: '{"output": "server.ts", "exit_code": 0, "error": null}', tool_call_id: 'call_1', tool_name: 'terminal', t: 3 },
    { role: 'tool', content: '{"ok": true}', tool_call_id: 'call_2', tool_name: 'write_file', t: 4 },
    { role: 'assistant', content: '', t: 5, tool_calls: [
      call('call_3', 'patch', { mode: 'replace', path: `${PROJECT}/src/health.ts`, old_string: 'true', new_string: 'false' }),
      call('call_4', 'terminal', { command: 'npm test' }),
    ] },
    { role: 'tool', content: '{"ok": true}', tool_call_id: 'call_3', tool_name: 'patch', t: 6 },
    { role: 'tool', content: '{"output": "1 failed", "exit_code": 1, "error": null}', tool_call_id: 'call_4', tool_name: 'terminal', t: 7 },
    { role: 'user', content: '[IMPORTANT: Background process proc_1 completed normally (exit code 0).', t: 8, display_kind: 'process_complete' },
    { role: 'assistant', content: 'an answer the person rewound', t: 9, active: 0 },
    { role: 'assistant', content: '', t: 10, display_kind: 'hidden' },
    { role: 'assistant', content: 'The endpoint is in src/health.ts.', t: 50 },
  ]);
  db.close();
}

function seedProfile(name: string): void {
  const dir = join(hermesHome, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  const db = createDb(join(dir, 'state.db'));
  db.prepare(`INSERT INTO sessions (id, source, title, cwd, started_at) VALUES (?, 'cli', 'Profile chat', ?, ?)`)
    .run(PROFILE_SID, PROJECT, T0 + 7200);
  addMessages(db, PROFILE_SID, [{ role: 'user', content: 'hello from a profile', t: 7200 }]);
  db.close();
}

async function load() {
  const backends = await import('./index.js');
  backends.hermesBackend._clearDbRouting();
  return backends;
}

beforeEach(() => {
  prevHome = homeEnvSnapshot();
  home = mkdtempSync(join(tmpdir(), 'cr-hermes-'));
  useHomeDir(home);
  hermesHome = join(home, '.hermes');
  mkdirSync(hermesHome, { recursive: true });
  writeFileSync(join(hermesHome, 'SOUL.md'), 'You are Hermes.\n');
  for (const k of ['CHAT_RECALL_HERMES_HOME', 'HERMES_HOME', 'CHAT_RECALL_DATA_DIR']) savedEnv[k] = process.env[k];
  // The default home is `%LOCALAPPDATA%\hermes` on Windows and `~/.hermes`
  // elsewhere, so the fixture home is set explicitly.
  process.env.CHAT_RECALL_HERMES_HOME = hermesHome;
  delete process.env.HERMES_HOME;
  process.env.CHAT_RECALL_DATA_DIR = join(home, '.chat-recall');
  seedRoot();
});

afterEach(() => {
  restoreHomeEnv(prevHome);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
});

describe('HermesBackend', () => {
  test('ids carry the hermes_ prefix', async () => {
    const { hermesBackend } = await load();
    expect(hermesBackend.toPrefixedId(SID)).toBe(`hermes_${SID}`);
    expect(hermesBackend.toRawId(`hermes_${SID}`)).toBe(SID);
    expect(hermesBackend.matchesId(SID)).toBe(false);
    const { toolOfId } = await import('../extractor-version.js');
    expect(toolOfId(`hermes_${SID}`)).toBe('hermes');
    const { resumeCommandFor } = await import('../resume-command.js');
    expect(resumeCommandFor(`hermes_${SID}`)).toBe(`hermes --resume ${SID}`);
  });

  test('lists a session with its project, newest activity and first prompt', async () => {
    const { hermesBackend } = await load();
    expect(hermesBackend.isAvailable()).toBe(true);
    const refs = hermesBackend.listSessions();
    expect(refs).toHaveLength(1);
    const r = refs[0];
    expect(r.toolId).toBe('hermes');
    expect(r.prefixedId).toBe(`hermes_${SID}`);
    expect(r.projectPath).toBe(PROJECT);
    expect(r.mtime).toBe((T0 + 50) * 1000);
    expect(r.firstPrompt).toBe('add a health check endpoint');
    expect(hermesBackend.getNativeTitle(SID)).toBe('Add a health check');
    expect(hermesBackend.findSession(`hermes_${SID}`)?.mtime).toBe((T0 + 50) * 1000);
  });

  test('a sinceMs cutoff after the last message leaves the session out', async () => {
    const { hermesBackend } = await load();
    expect(hermesBackend.listSessions({ sinceMs: (T0 + 51) * 1000 })).toHaveLength(0);
    expect(hermesBackend.listSessions({ sinceMs: (T0 + 50) * 1000 })).toHaveLength(1);
  });

  test('the transcript keeps the chat and drops rewound, refused and hidden rows', async () => {
    await load();
    const { parseTranscript } = await import('../../transcript/index.js');
    const t = await parseTranscript(`hermes_${SID}`, 'hermes');
    expect(t).not.toBeNull();
    const msgs = t!.messages;
    // The calls of an assistant row with no text join the assistant message
    // before them.
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(msgs[0].origin).toBeUndefined();
    expect(msgs[2].origin).toBe('task-notification');
    const text = JSON.stringify(msgs);
    expect(text).not.toContain('not processed');
    expect(text).not.toContain('rewound');

    const calls = msgs.flatMap((m) => m.toolCalls ?? []);
    expect(calls.map((c) => c.name)).toEqual(['terminal', 'write_file', 'patch', 'terminal']);
    expect(calls[0].result).toContain('server.ts');
    expect(calls[0].isError).toBe(false);
    expect(calls[3].isError).toBe(true);
  });

  test('replay builds the diff from write_file and patch', async () => {
    const { hermesBackend } = await load();
    const d = hermesBackend.replay(SID);
    expect(d.found).toBe(true);
    expect(d.files.map((f) => f.file)).toEqual([`${PROJECT}/src/health.ts`]);
    expect(d.totalLinesAdded).toBeGreaterThan(0);
    const ops = hermesBackend.liveScanEdits(SID).edits.map((e) => e.op);
    expect(ops).toEqual(['write', 'edit']);
  });

  test('the archive dump reads back to the same events', async () => {
    const { hermesBackend } = await load();
    const exp = hermesBackend.exportRawSession(SID);
    expect(exp?.tool).toBe('hermes');
    expect(exp?.mtime).toBe((T0 + 50) * 1000);
    const text = exp!.files[0].bytes.toString('utf-8');
    expect(hermesBackend.readEventsFromText(text)).toEqual(hermesBackend.readEvents(SID));
  });

  test('an archive holding a row twice reads its newest copy', async () => {
    const { hermesBackend } = await load();
    const row = (id: number, content: string, active: 0 | 1) => JSON.stringify({ kind: 'message', row: {
      id, role: 'assistant', content, tool_calls: null, tool_call_id: null, tool_name: null,
      timestamp: T0 + id, display_kind: null, active, _compressed_summary: 0 } });
    // The shadow joins the lines of two dumps: row 2 was rewound in between.
    const text = [row(1, 'kept', 1), row(2, 'rewound later', 1), row(2, 'rewound later', 0)].join('\n');
    expect(hermesBackend.readEventsFromText(text).map((e) => e.text)).toEqual(['kept']);
  });

  test('a named profile is read once its home is approved', async () => {
    seedProfile('work');
    const { hermesBackend } = await load();
    // A home that appears without a decision is pending, so it is not read.
    expect(hermesBackend.listSessions().map((r) => r.rawId)).toEqual([SID]);
    const { approveHome } = await import('../home-approval.js');
    approveHome(join(hermesHome, 'profiles', 'work'));
    hermesBackend._clearDbRouting();
    expect(hermesBackend.listSessions().map((r) => r.rawId)).toEqual([PROFILE_SID, SID]);
    expect(hermesBackend.findSession(PROFILE_SID)?.path).toBe(join(hermesHome, 'profiles', 'work', 'state.db'));
  });

  test('home discovery knows a Hermes home and its profiles', async () => {
    seedProfile('work');
    writeFileSync(join(hermesHome, 'profiles', 'work', 'SOUL.md'), 'You are Hermes.\n');
    const { identifyHome, discoverHomes } = await import('../home-discovery.js');
    expect(identifyHome(hermesHome)).toBe('hermes');
    // Discovery reports resolved paths: a macOS temp dir is under /private.
    const found = discoverHomes({ includeRunning: false }).filter((h) => h.tool === 'hermes').map((h) => h.path);
    expect(found).toContain(realpathSync(hermesHome));
    expect(found).toContain(realpathSync(join(hermesHome, 'profiles', 'work')));
  });
});
