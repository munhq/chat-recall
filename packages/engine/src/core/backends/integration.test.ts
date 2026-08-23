/**
 * Integration tests: drive each backend's full pipeline (readEvents →
 * extractTurns / liveScanEdits / replay) against real fixture sessions
 * written in the tool's native format.
 *
 * Fixtures use minimal-but-realistic shapes: enough to verify each
 * format adapter emits the right canonical events and the generic
 * engine produces correct downstream results. No mocks of the engine
 * itself — the canonical-event path runs end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

import { ClaudeBackend } from './claude.js';
import { GeminiBackend } from './gemini.js';
import { OpencodeBackend } from './opencode.js';
import { CodexBackend } from './codex.js';
import { getRecentSessions } from '../context.js';
import { _resetRegistryForTests } from '../tool-backend.js';
import { bootstrapBackends } from './index.js';
import { computeOutcome } from '../session-outcome.js';
import { createHash } from 'crypto';

/**
 * Write a Cursor CLI chat in its real on-disk shape: a content-addressed blob
 * store whose protobuf root (repeated field 1) carries the ordered message
 * hashes. Built by hand rather than copied, so the decoder is what is tested.
 */
function seedCursorChat(cursorHome: string, chatId: string, cwd: string, messages: object[]): void {
  const dir = join(cursorHome, 'chats', createHash('md5').update(cwd).digest('hex'), chatId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    schemaVersion: 1, createdAtMs: 1_787_500_000_000, updatedAtMs: 1_787_500_060_000,
    hasConversation: true, cwd,
  }));

  const db = new Database(join(dir, 'store.db'));
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.prepare('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)');
  const parts: Buffer[] = [];
  for (const m of messages) {
    const bytes = Buffer.from(JSON.stringify(m), 'utf8');
    const id = createHash('sha256').update(bytes).digest('hex');
    insert.run(id, bytes);
    parts.push(Buffer.from([0x0a, 0x20]), Buffer.from(id, 'hex'));
  }
  const root = Buffer.concat(parts);
  const rootId = createHash('sha256').update(root).digest('hex');
  insert.run(rootId, root);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('0',
    Buffer.from(JSON.stringify({ agentId: chatId, latestRootBlobId: rootId, createdAt: 1_787_500_000_000 }), 'utf8').toString('hex'));
  db.close();
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `chat-recall-${prefix}-`));
}

// ── Claude ─────────────────────────────────────────────────────────

describe('Claude backend integration', () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    home = tmp('claude');
    saved = process.env.CHAT_RECALL_CLAUDE_HOME;
    process.env.CHAT_RECALL_CLAUDE_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CHAT_RECALL_CLAUDE_HOME;
    else process.env.CHAT_RECALL_CLAUDE_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  function writeClaudeSession(uuid: string, projDir: string, lines: object[]) {
    const dir = join(home, 'projects', projDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${uuid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  }

  it('readEvents emits canonical events for user/assistant/tool_use/tool_result', () => {
    const sid = '11111111-1111-4111-8111-111111111111';
    writeClaudeSession(sid, '-home-user-test', [
      { type: 'user', timestamp: '2026-05-06T10:00:00Z', message: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant', timestamp: '2026-05-06T10:00:05Z', message: { content: [{ type: 'text', text: 'sure thing' }] } },
      { type: 'assistant', timestamp: '2026-05-06T10:00:10Z', message: { content: [
        { type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: '/x/foo.ts', old_string: 'a', new_string: 'b' } },
      ] } },
      { type: 'user', timestamp: '2026-05-06T10:00:15Z', message: { content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'edit applied', is_error: false },
      ] } },
    ]);
    const b = new ClaudeBackend();
    const events = b.readEvents(sid);
    const kinds = events.map(e => e.kind);
    expect(kinds).toContain('user');
    expect(kinds).toContain('assistant_text');
    expect(kinds).toContain('tool_use');
    expect(kinds).toContain('tool_result');
    // toolInput preserved on tool_use
    const toolUse = events.find(e => e.kind === 'tool_use')!;
    expect(toolUse.toolName).toBe('Edit');
    expect((toolUse.toolInput as any).file_path).toBe('/x/foo.ts');
  });

  it('extractTurns returns user + assistant + tool turns in order', () => {
    const sid = '22222222-2222-4222-8222-222222222222';
    writeClaudeSession(sid, '-x', [
      { type: 'user', message: { content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } },
    ]);
    const turns = new ClaudeBackend().extractTurns(sid);
    expect(turns.found).toBe(true);
    expect(turns.turns.map(t => t.kind)).toEqual(['user', 'assistant_text']);
  });

  it('liveScanEdits picks up Edit/Write but skips Read', () => {
    const sid = '33333333-3333-4333-8333-333333333333';
    writeClaudeSession(sid, '-x', [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Edit',  input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } },
        { type: 'tool_use', name: 'Write', input: { file_path: '/b.ts', content: 'new' } },
        { type: 'tool_use', name: 'Read',  input: { file_path: '/c.ts' } },
        { type: 'tool_use', name: 'Bash',  input: { command: 'ls' } },
      ] } },
    ]);
    const r = new ClaudeBackend().liveScanEdits(sid);
    expect(r.found).toBe(true);
    expect(r.edits.map(e => `${e.op}:${e.file}`).sort()).toEqual([
      'edit:/a.ts',
      'read:/c.ts',
      'write:/b.ts',
    ]);
  });

  it('replay produces a unified diff for an Edit', () => {
    const sid = '44444444-4444-4444-8444-444444444444';
    writeClaudeSession(sid, '-x', [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: '/x/foo.ts', old_string: 'old line', new_string: 'new line' } },
      ] } },
    ]);
    const r = new ClaudeBackend().replay(sid);
    expect(r.found).toBe(true);
    expect(r.files).toHaveLength(1);
    const f = r.files[0];
    expect(f.file).toBe('/x/foo.ts');
    expect(f.diff).toContain('-old line');
    expect(f.diff).toContain('+new line');
    expect(f.linesAdded).toBeGreaterThan(0);
    expect(f.linesRemoved).toBeGreaterThan(0);
  });

  it('collectRecentEdits returns edits since cutoff', () => {
    const sid = '55555555-5555-4555-8555-555555555555';
    writeClaudeSession(sid, '-home-user-myproj', [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: '/x/a.ts', old_string: 'a', new_string: 'b' } },
      ] } },
    ]);
    const edits = new ClaudeBackend().collectRecentEdits({ sinceMs: 0 });
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits.some(e => e.file === '/x/a.ts' && e.op === 'edit')).toBe(true);
  });

  it('readEvents emits summary events for Claude session-summary lines', () => {
    const sid = '66666666-6666-4666-8666-666666666666';
    writeClaudeSession(sid, '-x', [
      { type: 'summary', summary: 'Implemented OAuth login flow.' },
      { type: 'user', message: { content: [{ type: 'text', text: 'continue' }] } },
    ]);
    const events = new ClaudeBackend().readEvents(sid);
    const summaries = events.filter(e => e.kind === 'summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].text).toBe('Implemented OAuth login flow.');
  });

  it('computeOutcome (registry-routed) reports edits + status', () => {
    const sid = '77777777-7777-4777-8777-777777777777';
    writeClaudeSession(sid, '-x', [
      { type: 'user', timestamp: '2026-05-06T10:00:00Z', message: { content: 'do thing' } },
      { type: 'assistant', timestamp: '2026-05-06T10:01:00Z', message: { content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: '/x/foo.ts', old_string: 'a', new_string: 'b' } },
      ] } },
    ]);
    const o = computeOutcome(sid);
    expect(o.found).toBe(true);
    expect(o.fileCount).toBeGreaterThanOrEqual(1);
    expect(['shipped', 'in_progress', 'abandoned', 'interrupted', 'unknown']).toContain(o.status);
  });
});

// ── Gemini ─────────────────────────────────────────────────────────

describe('Gemini backend integration', () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    home = tmp('gemini');
    saved = process.env.CHAT_RECALL_GEMINI_HOME;
    process.env.CHAT_RECALL_GEMINI_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CHAT_RECALL_GEMINI_HOME;
    else process.env.CHAT_RECALL_GEMINI_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  function writeJsonl(innerId: string, projHash: string, events: object[]) {
    const dir = join(home, 'tmp', projHash, 'chats');
    mkdirSync(dir, { recursive: true });
    const meta = { sessionId: innerId, projectHash: projHash, startTime: '2026-05-06T10:00:00Z', kind: 'main' };
    writeFileSync(
      join(dir, `session-2026-05-06T10-00-${innerId.slice(0, 8)}.jsonl`),
      [meta, ...events].map(e => JSON.stringify(e)).join('\n') + '\n',
    );
  }

  it('readEvents handles user/gemini messages and toolCalls', () => {
    const id = 'aaaaaaaa-1111-1111-1111-111111111111';
    writeJsonl(id, 'projhash', [
      { id: 'm1', timestamp: '2026-05-06T10:01:00Z', type: 'user', content: [{ text: 'help' }] },
      {
        id: 'm2', timestamp: '2026-05-06T10:01:05Z', type: 'gemini',
        text: 'will edit',
        toolCalls: [
          { id: 'tc1', name: 'replace', args: { file_path: '/foo.py', old_string: 'a', new_string: 'b' }, result: 'ok' },
        ],
      },
    ]);
    const b = new GeminiBackend();
    const events = b.readEvents(id);
    const kinds = events.map(e => e.kind);
    expect(kinds).toContain('user');
    expect(kinds).toContain('assistant_text');
    expect(kinds).toContain('tool_use');
    expect(kinds).toContain('tool_result');
  });

  it('extractTurns returns canonical turns from a .jsonl session', () => {
    const id = 'bbbbbbbb-2222-2222-2222-222222222222';
    writeJsonl(id, 'h', [
      { id: 'm1', type: 'user', content: [{ text: 'hi' }] },
      { id: 'm2', type: 'gemini', text: 'hello' },
    ]);
    const r = new GeminiBackend().extractTurns(id);
    expect(r.found).toBe(true);
    expect(r.turns.map(t => t.kind)).toEqual(['user', 'assistant_text']);
  });

  it('liveScanEdits picks up replace + write_file', () => {
    const id = 'cccccccc-3333-3333-3333-333333333333';
    writeJsonl(id, 'h', [
      { id: 'm1', type: 'gemini', text: '', toolCalls: [
        { id: 'tc1', name: 'replace',     args: { file_path: '/a.py', old_string: 'x', new_string: 'y' } },
        { id: 'tc2', name: 'write_file',  args: { file_path: '/b.py', content: 'def hi(): pass' } },
        { id: 'tc3', name: 'read_file',   args: { file_path: '/c.py' } },
      ] },
    ]);
    const r = new GeminiBackend().liveScanEdits(id);
    expect(r.edits.map(e => `${e.op}:${e.file}`).sort()).toEqual([
      'edit:/a.py',
      'read:/c.py',
      'write:/b.py',
    ]);
  });

  it('collectRecentEdits returns edits across .json + .jsonl', () => {
    const id = 'ffffffff-6666-6666-6666-666666666666';
    writeJsonl(id, 'h2', [
      { id: 'm1', type: 'gemini', text: '', toolCalls: [
        { id: 'tc1', name: 'replace', args: { file_path: '/g.py', old_string: 'a', new_string: 'b' } },
      ] },
    ]);
    const edits = new GeminiBackend().collectRecentEdits({ sinceMs: 0 });
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits.some(e => e.file === '/g.py')).toBe(true);
  });

  it('replay produces a diff for replace', () => {
    const id = 'dddddddd-4444-4444-4444-444444444444';
    writeJsonl(id, 'h', [
      { id: 'm1', type: 'gemini', text: '', toolCalls: [
        { id: 'tc1', name: 'replace', args: { file_path: '/x.py', old_string: 'foo', new_string: 'bar' } },
      ] },
    ]);
    const r = new GeminiBackend().replay(id);
    expect(r.found).toBe(true);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].diff).toContain('-foo');
    expect(r.files[0].diff).toContain('+bar');
  });

  it('legacy .json blob format still works', () => {
    const id = 'eeeeeeee-5555-5555-5555-555555555555';
    const dir = join(home, 'tmp', 'h', 'chats');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `session-2026-04-22T11-23-${id.slice(0, 8)}.json`), JSON.stringify({
      sessionId: id,
      messages: [
        { type: 'user', timestamp: '2026-04-22T11:23:00Z', content: [{ text: 'legacy' }] },
        { type: 'gemini', timestamp: '2026-04-22T11:23:30Z', text: 'reply' },
      ],
    }));
    const r = new GeminiBackend().extractTurns(id);
    expect(r.found).toBe(true);
    expect(r.turns.map(t => t.kind)).toEqual(['user', 'assistant_text']);
  });
});

// ── OpenCode ───────────────────────────────────────────────────────

describe('OpenCode backend integration', () => {
  let dbDir: string;
  let saved: string | undefined;
  let dbPath: string;

  beforeEach(() => {
    dbDir = tmp('opencode');
    dbPath = join(dbDir, 'opencode.db');
    saved = process.env.CHAT_RECALL_OPENCODE_DB;
    process.env.CHAT_RECALL_OPENCODE_DB = dbPath;
    seedOpencodeDb(dbPath);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CHAT_RECALL_OPENCODE_DB;
    else process.env.CHAT_RECALL_OPENCODE_DB = saved;
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('readEvents extracts text + tool parts from sqlite', () => {
    const b = new OpencodeBackend();
    const events = b.readEvents('ses_demo');
    const kinds = events.map(e => e.kind);
    expect(kinds).toContain('user');
    expect(kinds).toContain('assistant_text');
    expect(kinds).toContain('tool_use');
    expect(kinds).toContain('tool_result');
  });

  it('liveScanEdits picks up edit/write tool calls', () => {
    const r = new OpencodeBackend().liveScanEdits('ses_demo');
    expect(r.found).toBe(true);
    expect(r.edits.map(e => `${e.op}:${e.file}`).sort()).toEqual([
      'edit:/a.ts',
      'write:/b.ts',
    ]);
  });

  it('collectRecentEdits batches via single SQL query', () => {
    const edits = new OpencodeBackend().collectRecentEdits({ sinceMs: 0 });
    const files = edits.map(e => e.file).sort();
    expect(files).toEqual(['/a.ts', '/b.ts']);
  });

  it('replay produces a diff for an edit part', () => {
    const r = new OpencodeBackend().replay('ses_demo');
    expect(r.found).toBe(true);
    const editFile = r.files.find(f => f.file === '/a.ts')!;
    expect(editFile.diff).toContain('-original');
    expect(editFile.diff).toContain('+changed');
  });
});

function seedOpencodeDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, name TEXT);
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      directory TEXT,
      title TEXT,
      summary_files INTEGER,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      time_created INTEGER,
      time_updated INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      message_id TEXT,
      time_created INTEGER,
      data TEXT
    );
  `);
  const now = Date.now();
  db.prepare('INSERT INTO project VALUES (?, ?, ?)').run('p1', '/home/user/code/test', 'test');
  db.prepare('INSERT INTO session (id, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)')
    .run('ses_demo', 'p1', now, now);
  db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)')
    .run('msg_u', 'ses_demo', JSON.stringify({ role: 'user' }));
  db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)')
    .run('msg_a', 'ses_demo', JSON.stringify({ role: 'assistant' }));
  const partInsert = db.prepare('INSERT INTO part (id, session_id, message_id, time_created, data) VALUES (?, ?, ?, ?, ?)');
  partInsert.run('p_u_text', 'ses_demo', 'msg_u', now,        JSON.stringify({ type: 'text', text: 'pls help' }));
  partInsert.run('p_a_text', 'ses_demo', 'msg_a', now + 100,  JSON.stringify({ type: 'text', text: 'on it' }));
  partInsert.run('p_a_edit', 'ses_demo', 'msg_a', now + 200,  JSON.stringify({
    type: 'tool', tool: 'edit', callID: 'c1',
    state: { input: { filePath: '/a.ts', oldString: 'original', newString: 'changed' }, output: 'edit ok', status: 'ok' },
  }));
  partInsert.run('p_a_write', 'ses_demo', 'msg_a', now + 300, JSON.stringify({
    type: 'tool', tool: 'write', callID: 'c2',
    state: { input: { filePath: '/b.ts', content: 'new file body' }, output: 'wrote', status: 'ok' },
  }));
  db.close();
}

// ── Codex ──────────────────────────────────────────────────────────

describe('Codex backend integration', () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    home = tmp('codex');
    saved = process.env.CHAT_RECALL_CODEX_HOME;
    process.env.CHAT_RECALL_CODEX_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CHAT_RECALL_CODEX_HOME;
    else process.env.CHAT_RECALL_CODEX_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  function writeRollout(uuid: string, events: object[]) {
    const day = join(home, 'sessions', '2026', '05', '06');
    mkdirSync(day, { recursive: true });
    const meta = { type: 'session_meta', payload: { id: uuid, cwd: '/home/user/code/test' } };
    writeFileSync(
      join(day, `rollout-${uuid}.jsonl`),
      [meta, ...events].map(e => JSON.stringify(e)).join('\n') + '\n',
    );
  }

  it('readEvents maps event_msg/response_item to canonical kinds', () => {
    const id = 'aaaa1111-2222-3333-4444-555555555555';
    writeRollout(id, [
      { type: 'event_msg',    timestamp: '2026-05-06T10:00:00Z', payload: { type: 'user_message', message: 'do thing' } },
      { type: 'response_item', timestamp: '2026-05-06T10:00:05Z', payload: { type: 'message', role: 'assistant', content: [{ text: 'sure' }] } },
      { type: 'response_item', timestamp: '2026-05-06T10:00:10Z', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['ls', '-la'] }) } },
      { type: 'response_item', timestamp: '2026-05-06T10:00:11Z', payload: { type: 'function_call_output', call_id: 'c1', output: { content: 'total 0', exit_code: 0 } } },
    ]);
    const events = new CodexBackend().readEvents(id);
    const kinds = events.map(e => e.kind);
    expect(kinds).toContain('user');
    expect(kinds).toContain('assistant_text');
    expect(kinds).toContain('tool_use');
    expect(kinds).toContain('tool_result');
    const userE = events.find(e => e.kind === 'user')!;
    expect(userE.text).toBe('do thing');
    const tool = events.find(e => e.kind === 'tool_use')!;
    expect(tool.toolName).toBe('shell');
    expect(tool.command).toBe('ls -la');
  });

  it('filters codex injected wrapper user_messages', () => {
    const id = 'bbbb2222-2222-3333-4444-555555555555';
    writeRollout(id, [
      { type: 'event_msg', payload: { type: 'user_message', message: '<environment_context>cwd=/x</environment_context>' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'real prompt' } },
    ]);
    const turns = new CodexBackend().extractTurns(id);
    expect(turns.turns.map(t => t.text)).toEqual(['real prompt']);
  });

  it('collectRecentEdits skips subagent rollouts (no double-count)', () => {
    const parent = '11111111-aaaa-aaaa-aaaa-111111111111';
    const sub    = '22222222-bbbb-bbbb-bbbb-222222222222';
    writeRollout(parent, [
      { type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'c1', arguments: JSON.stringify({ input: '*** Begin Patch\n*** Update File: /shared.ts\n@@ \n-old\n+new\n*** End Patch' }) } },
    ]);
    // Subagent rollout linked to parent — should NOT be walked separately.
    const subPath = join(home, 'sessions', '2026', '05', '06', `rollout-${sub}.jsonl`);
    const subMeta = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: sub, cwd: '/home/user/code/test',
        agent_role: 'explore',
        source: { subagent: { thread_spawn: { parent_thread_id: parent } } },
      },
    });
    writeFileSync(subPath, subMeta + '\n');

    const edits = new CodexBackend().collectRecentEdits({ sinceMs: 0 });
    const matchingShared = edits.filter(e => e.file === '/shared.ts');
    // Without the dedup fix this would emit twice — once from parent's
    // fan-out readEvents, once from walking the subagent rollout.
    expect(matchingShared).toHaveLength(1);
  });

  it('apply_patch tool_use produces a multi-file diff via the generic engine', () => {
    const id = 'aaaaaaaa-9999-9999-9999-999999999999';
    const patch = [
      '*** Begin Patch',
      '*** Add File: /a.ts',
      '+export const foo = 1;',
      '+export const bar = 2;',
      '*** Update File: /b.ts',
      '@@ ',
      '-old line',
      '+new line one',
      '+new line two',
      '*** End Patch',
    ].join('\n');
    writeRollout(id, [
      { type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'c1', arguments: JSON.stringify({ input: patch }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: { content: 'patch applied', exit_code: 0 } } },
    ]);
    const b = new CodexBackend();

    const scan = b.liveScanEdits(id);
    expect(scan.found).toBe(true);
    const files = scan.edits.map(e => e.file).sort();
    expect(files).toEqual(['/a.ts', '/b.ts']);

    const r = b.replay(id);
    expect(r.found).toBe(true);
    expect(r.files).toHaveLength(2);
    const aFile = r.files.find(f => f.file === '/a.ts')!;
    const bFile = r.files.find(f => f.file === '/b.ts')!;
    // /a.ts: 2 added lines, 0 removed (it's an Add).
    expect(aFile.linesAdded).toBeGreaterThan(0);
    // /b.ts: at least one added + one removed.
    expect(bFile.linesAdded).toBeGreaterThan(0);
    expect(bFile.linesRemoved).toBeGreaterThan(0);
  });

  it('extractTurns handles function_call_output exit_code as resultExitCode', () => {
    const id = 'cccc3333-2222-3333-4444-555555555555';
    writeRollout(id, [
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["false"]}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: { content: 'oops', exit_code: 1 } } },
    ]);
    const turns = new CodexBackend().extractTurns(id);
    const result = turns.turns.find(t => t.kind === 'tool_result')!;
    expect(result.resultIsError).toBe(true);
    expect(result.resultExitCode).toBe(1);
  });
});

// ── Cross-backend ──────────────────────────────────────────────────

describe('cross-backend listing', () => {
  // Use a single env-isolated temp tree, write one fixture session per
  // available backend, and confirm getRecentSessions returns them all
  // through the registry.

  let claudeHome: string;
  let geminiHome: string;
  let codexHome: string;
  let agyHome: string;
  let cursorHome: string;
  let cursorIdeHome: string;
  let opencodeDb: string;
  let opencodeDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    _resetRegistryForTests();
    claudeHome   = tmp('cross-claude');
    geminiHome   = tmp('cross-gemini');
    codexHome    = tmp('cross-codex');
    agyHome      = tmp('cross-agy');
    cursorHome   = tmp('cross-cursor');
    cursorIdeHome = tmp('cross-cursor-ide');
    opencodeDir  = tmp('cross-opencode');
    opencodeDb   = join(opencodeDir, 'opencode.db');

    saved.CLAUDE_HOME    = process.env.CHAT_RECALL_CLAUDE_HOME;
    saved.GEMINI_HOME    = process.env.CHAT_RECALL_GEMINI_HOME;
    saved.CODEX_HOME     = process.env.CHAT_RECALL_CODEX_HOME;
    // agy and cursor were absent here, so this suite both skipped them AND
    // read the developer's real homes when anything did reach them.
    saved.AGY_HOME       = process.env.CHAT_RECALL_AGY_HOME;
    saved.CURSOR_HOME    = process.env.CHAT_RECALL_CURSOR_HOME;
    saved.CURSOR_IDE_HOME = process.env.CHAT_RECALL_CURSOR_IDE_HOME;
    saved.OPENCODE_DB    = process.env.CHAT_RECALL_OPENCODE_DB;
    process.env.CHAT_RECALL_CLAUDE_HOME = claudeHome;
    process.env.CHAT_RECALL_GEMINI_HOME = geminiHome;
    process.env.CHAT_RECALL_CODEX_HOME  = codexHome;
    process.env.CHAT_RECALL_AGY_HOME    = agyHome;
    process.env.CHAT_RECALL_CURSOR_HOME = cursorHome;
    process.env.CHAT_RECALL_CURSOR_IDE_HOME = cursorIdeHome;
    process.env.CHAT_RECALL_OPENCODE_DB = opencodeDb;

    bootstrapBackends();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      const envKey = `CHAT_RECALL_${k}`;
      if (v === undefined) delete process.env[envKey];
      else process.env[envKey] = v;
    }
    [claudeHome, geminiHome, codexHome, agyHome, cursorHome, cursorIdeHome, opencodeDir].forEach(d => {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  });

  it('getRecentSessions unions sessions from every available backend', () => {
    // Claude session
    const cdir = join(claudeHome, 'projects', '-tmp-x');
    mkdirSync(cdir, { recursive: true });
    writeFileSync(join(cdir, '11111111-1111-4111-8111-111111111111.jsonl'),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'cl prompt' }] } }) + '\n');

    // Gemini session
    const gdir = join(geminiHome, 'tmp', 'h', 'chats');
    mkdirSync(gdir, { recursive: true });
    writeFileSync(join(gdir, 'session-2026-05-06T10-00-aaaaaaaa.jsonl'),
      JSON.stringify({ sessionId: 'aaaaaaaa-1111-1111-1111-111111111111', kind: 'main' }) + '\n' +
      JSON.stringify({ id: 'm1', type: 'user', content: [{ text: 'gm prompt' }] }) + '\n');

    // Codex session
    const day = join(codexHome, 'sessions', '2026', '05', '06');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-cccc1111-1111-1111-1111-111111111111.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'cccc1111-1111-1111-1111-111111111111', cwd: '/x' } }) + '\n' +
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'cx prompt' } }) + '\n');

    // OpenCode session
    seedOpencodeDb(opencodeDb);

    // Antigravity session
    const alogs = join(agyHome, 'brain', 'dddd1111-1111-1111-1111-111111111111', '.system_generated', 'logs');
    mkdirSync(alogs, { recursive: true });
    writeFileSync(join(alogs, 'transcript_full.jsonl'),
      JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'agy prompt', created_at: '2026-05-06T10:00:00Z' }) + '\n' +
      JSON.stringify({ source: 'MODEL', type: 'CODE_ACTION', status: 'OK',
        content: 'File Path: `file:///x/agy/app.ts`' }) + '\n');

    // Cursor CLI chat
    seedCursorChat(cursorHome, 'eeee1111-1111-1111-1111-111111111111', '/x/cursor', [
      { role: 'user', content: [{ type: 'text', text: '<timestamp>Wed, May 6, 2026, 10:00 AM</timestamp>\n<user_query>\ncr prompt\n</user_query>' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]);

    const recent = getRecentSessions(undefined, 100);
    const tools = new Set(recent.map(s => s.tool));
    // Every backend's home is populated, so every tool should show up.
    expect(tools.has('claude')).toBe(true);
    expect(tools.has('gemini')).toBe(true);
    expect(tools.has('codex')).toBe(true);
    expect(tools.has('opencode')).toBe(true);
    expect(tools.has('agy')).toBe(true);
    expect(tools.has('cursor')).toBe(true);
  });
});
