/**
 * Per-backend unit tests focused on the things Phase 1 owns: id handling,
 * homeDir env-var override, and isAvailable() against an empty install.
 *
 * Heavier integration tests (real fixture sessions, listSessions content,
 * extractTurns) live in Phase 7's e2e suite — those require fixtures we
 * can't keep in this test file without bloating it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ClaudeBackend, claudeBackend } from './claude.js';
import { OpencodeBackend, opencodeBackend } from './opencode.js';
import { CodexBackend, codexBackend } from './codex.js';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `chat-recall-${prefix}-`));
}

// ── Claude ─────────────────────────────────────────────────────────

describe('ClaudeBackend', () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    home = makeTmpDir('claude');
    saved = process.env.CHAT_RECALL_CLAUDE_HOME;
    process.env.CHAT_RECALL_CLAUDE_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CHAT_RECALL_CLAUDE_HOME;
    else process.env.CHAT_RECALL_CLAUDE_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it('homeDir respects CHAT_RECALL_CLAUDE_HOME', () => {
    expect(new ClaudeBackend().homeDir()).toBe(home);
  });

  it('exposes typed subpath helpers anchored at homeDir', () => {
    const b = new ClaudeBackend();
    expect(b.projectsDir()).toBe(join(home, 'projects'));
    expect(b.plansDir()).toBe(join(home, 'plans'));
    expect(b.todosDir()).toBe(join(home, 'todos'));
    expect(b.historyFile()).toBe(join(home, 'history.jsonl'));
  });

  it('isAvailable false when projects dir missing, true when present', () => {
    const b = new ClaudeBackend();
    expect(b.isAvailable()).toBe(false);
    mkdirSync(b.projectsDir(), { recursive: true });
    expect(b.isAvailable()).toBe(true);
  });

  it('matchesId only accepts uuids, rejects other tools prefixes', () => {
    const b = new ClaudeBackend();
    expect(b.matchesId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(b.matchesId('codex_550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(b.matchesId('opencode_x')).toBe(false);
    expect(b.matchesId('codex_x')).toBe(false);
    expect(b.matchesId('garbage')).toBe(false);
  });

  it('toRawId / toPrefixedId are no-ops for claude', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(claudeBackend.toRawId(id)).toBe(id);
    expect(claudeBackend.toPrefixedId(id)).toBe(id);
  });

  it('listSessions returns [] on an empty install', () => {
    expect(new ClaudeBackend().listSessions()).toEqual([]);
  });

  it('listSessions discovers sessions written under projects/', () => {
    const b = new ClaudeBackend();
    const proj = join(b.projectsDir(), '-home-user-code-test');
    mkdirSync(proj, { recursive: true });
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    // Minimal Claude transcript: one user line with text content.
    const userLine = JSON.stringify({
      type: 'user',
      timestamp: '2026-05-06T06:00:00Z',
      message: { content: [{ type: 'text', text: 'hello world' }] },
    });
    writeFileSync(join(proj, `${sessionId}.jsonl`), userLine + '\n');

    const sessions = b.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].rawId).toBe(sessionId);
    expect(sessions[0].prefixedId).toBe(sessionId);
    expect(sessions[0].toolId).toBe('claude');
    expect(sessions[0].projectPath).toBe('/home/user/code/test');
    expect(sessions[0].firstPrompt).toContain('hello world');
  });

  it('listSessions respects projectFilter, limit, sinceMs', () => {
    const b = new ClaudeBackend();
    const projA = join(b.projectsDir(), '-home-a-foo');
    const projB = join(b.projectsDir(), '-home-b-bar');
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    const userLine = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'x' }] },
    });
    writeFileSync(join(projA, '11111111-1111-1111-1111-111111111111.jsonl'), userLine);
    writeFileSync(join(projB, '22222222-2222-2222-2222-222222222222.jsonl'), userLine);

    expect(b.listSessions({ projectFilter: 'foo' })).toHaveLength(1);
    expect(b.listSessions({ limit: 1 })).toHaveLength(1);
    expect(b.listSessions({ sinceMs: Date.now() + 86_400_000 })).toEqual([]);
  });
});


// ── OpenCode ───────────────────────────────────────────────────────

describe('OpencodeBackend', () => {
  let saved: string | undefined;
  let dbDir: string;
  beforeEach(() => {
    dbDir = makeTmpDir('opencode');
    saved = process.env.CHAT_RECALL_OPENCODE_DB;
    process.env.CHAT_RECALL_OPENCODE_DB = join(dbDir, 'opencode.db');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CHAT_RECALL_OPENCODE_DB;
    else process.env.CHAT_RECALL_OPENCODE_DB = saved;
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('dbPath / homeDir respect CHAT_RECALL_OPENCODE_DB', () => {
    const b = new OpencodeBackend();
    expect(b.dbPath()).toBe(join(dbDir, 'opencode.db'));
    expect(b.homeDir()).toBe(dbDir);
  });

  it('isAvailable false when db file missing', () => {
    expect(new OpencodeBackend().isAvailable()).toBe(false);
  });

  it('id round-trip', () => {
    expect(opencodeBackend.matchesId('opencode_ses_x')).toBe(true);
    expect(opencodeBackend.matchesId('ses_x')).toBe(false);
    expect(opencodeBackend.toRawId('opencode_ses_x')).toBe('ses_x');
    expect(opencodeBackend.toPrefixedId('ses_x')).toBe('opencode_ses_x');
  });
});

// ── Codex ──────────────────────────────────────────────────────────

describe('CodexBackend', () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    home = makeTmpDir('codex');
    saved = process.env.CHAT_RECALL_CODEX_HOME;
    process.env.CHAT_RECALL_CODEX_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CHAT_RECALL_CODEX_HOME;
    else process.env.CHAT_RECALL_CODEX_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it('homeDir + sessionsDir respect env override', () => {
    const b = new CodexBackend();
    expect(b.homeDir()).toBe(home);
    expect(b.sessionsDir()).toBe(join(home, 'sessions'));
  });

  it('isAvailable false when sessions/ missing', () => {
    expect(new CodexBackend().isAvailable()).toBe(false);
  });

  it('id round-trip', () => {
    const raw = 'aaaa-bbbb-cccc';
    expect(codexBackend.matchesId('codex_' + raw)).toBe(true);
    expect(codexBackend.matchesId(raw)).toBe(false);
    expect(codexBackend.toRawId('codex_' + raw)).toBe(raw);
    expect(codexBackend.toPrefixedId(raw)).toBe('codex_' + raw);
  });

  it('listSessions walks YYYY/MM/DD rollouts and skips subagents', () => {
    const b = new CodexBackend();
    const day = join(b.sessionsDir(), '2026', '05', '06');
    mkdirSync(day, { recursive: true });

    const parentId = 'aaaa1111-2222-3333-4444-555555555555';
    const parentMeta = JSON.stringify({
      type: 'session_meta',
      payload: { id: parentId, cwd: '/home/user/code/test' },
    });
    const userEvent = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'codex parent prompt' },
    });
    writeFileSync(join(day, `rollout-${parentId}.jsonl`), parentMeta + '\n' + userEvent + '\n');

    // Subagent should be skipped (carries agent_role)
    const subId = 'bbbb2222-3333-4444-5555-666666666666';
    const subMeta = JSON.stringify({
      type: 'session_meta',
      payload: { id: subId, cwd: '/home/user/code/test', agent_role: 'explore' },
    });
    writeFileSync(join(day, `rollout-${subId}.jsonl`), subMeta + '\n');

    const sessions = b.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].rawId).toBe(parentId);
    expect(sessions[0].firstPrompt).toContain('codex parent prompt');
  });
});
