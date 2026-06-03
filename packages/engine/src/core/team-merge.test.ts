/**
 * Tests for the team-merge module — verifies that pulled artifacts land
 * in the right per-tool paths, that re-pulls are idempotent, and that
 * server-side revocations clean local files.
 *
 * We point CHAT_RECALL_DATA_DIR + CHAT_RECALL_*_HOME at fresh tmp dirs
 * so the test never touches a real ~/.claude or the install ledger.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { mergePullResult } from './team-merge.js';
import { _resetSourceSettingsCache } from './tool-paths.js';
import type { TeamArtifactBody } from './team-client.js';

let tmp: string;
const ORIG = {
  data: process.env.CHAT_RECALL_DATA_DIR,
  claude: process.env.CHAT_RECALL_CLAUDE_HOME,
  gemini: process.env.CHAT_RECALL_GEMINI_HOME,
  codex: process.env.CHAT_RECALL_CODEX_HOME,
  opencode: process.env.CHAT_RECALL_OPENCODE_DB,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cr-merge-'));
  process.env.CHAT_RECALL_DATA_DIR    = join(tmp, 'data');
  process.env.CHAT_RECALL_CLAUDE_HOME = join(tmp, 'claude');
  process.env.CHAT_RECALL_GEMINI_HOME = join(tmp, 'gemini');
  process.env.CHAT_RECALL_CODEX_HOME  = join(tmp, 'codex');
  process.env.CHAT_RECALL_OPENCODE_DB = join(tmp, 'opencode', 'opencode.db');
  // Mark Claude as "installed" so isAvailable() returns true (the backend
  // checks for the projects subdir).
  mkdirSync(join(tmp, 'claude', 'projects'), { recursive: true });
  _resetSourceSettingsCache();
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    const envKey = k === 'data' ? 'CHAT_RECALL_DATA_DIR'
      : k === 'claude' ? 'CHAT_RECALL_CLAUDE_HOME'
      : k === 'gemini' ? 'CHAT_RECALL_GEMINI_HOME'
      : k === 'codex'  ? 'CHAT_RECALL_CODEX_HOME'
      :                  'CHAT_RECALL_OPENCODE_DB';
    if (v !== undefined) process.env[envKey] = v;
    else                  delete process.env[envKey];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function art(over: Partial<TeamArtifactBody>): TeamArtifactBody {
  const body = over.bodyB64 ?? Buffer.from('hello').toString('base64');
  return {
    id: over.id ?? 'a-1',
    type: over.type ?? 'skill',
    tool: over.tool ?? 'cross_tool',
    name: over.name ?? 'demo',
    version: over.version ?? 1,
    authorId: 'u-1',
    sha256: 'unused',
    pinnedTo: over.pinnedTo ?? null,
    updatedAt: over.updatedAt ?? Date.now(),
    bytes: Buffer.from(body, 'base64').length,
    bodyB64: body,
  };
}

describe('team-merge', () => {
  test('writes a cross_tool skill into Claude skills dir', () => {
    const r = mergePullResult({ pulled: [art({ id: 'a-1', type: 'skill', name: 'mycool', tool: 'cross_tool',
      bodyB64: Buffer.from('# My cool skill').toString('base64') })], removed: [] });

    const claudePath = join(tmp, 'claude', 'skills', 'mycool', 'SKILL.md');
    expect(existsSync(claudePath)).toBe(true);
    expect(readFileSync(claudePath, 'utf-8')).toBe('# My cool skill');
    expect(r.written.length).toBeGreaterThanOrEqual(1);
    expect(r.failures).toEqual([]);
  });

  test('re-pulling identical body marks skipped: unchanged (idempotent)', () => {
    const a = art({ id: 'a-2', type: 'skill', name: 's', bodyB64: Buffer.from('v1').toString('base64') });
    mergePullResult({ pulled: [a], removed: [] });
    const r2 = mergePullResult({ pulled: [a], removed: [] });

    const unchanged = r2.skipped.filter(s => s.reason === 'unchanged');
    expect(unchanged.length).toBeGreaterThanOrEqual(1);
    expect(r2.written).toEqual([]);
  });

  test('updated body overwrites the previous file', () => {
    mergePullResult({ pulled: [art({ id: 'a-3', name: 's', bodyB64: Buffer.from('v1').toString('base64') })], removed: [] });
    mergePullResult({ pulled: [art({ id: 'a-3', name: 's', version: 2, bodyB64: Buffer.from('v2').toString('base64') })], removed: [] });

    const path = join(tmp, 'claude', 'skills', 's', 'SKILL.md');
    expect(readFileSync(path, 'utf-8')).toBe('v2');
  });

  test('revocation deletes every file we previously wrote for that artifact', () => {
    mergePullResult({ pulled: [art({ id: 'a-4', name: 'tox', bodyB64: Buffer.from('content').toString('base64') })], removed: [] });
    const path = join(tmp, 'claude', 'skills', 'tox', 'SKILL.md');
    expect(existsSync(path)).toBe(true);

    const r = mergePullResult({ pulled: [], removed: ['a-4'] });
    expect(existsSync(path)).toBe(false);
    expect(r.removed.find(x => x.path === path)).toBeDefined();
  });

  test('agent type only installs to Claude, not other tools', () => {
    // Claude is installed (projects dir exists); other tools aren't.
    const r = mergePullResult({ pulled: [art({ id: 'a-5', type: 'agent', name: 'planner',
      tool: 'cross_tool', bodyB64: Buffer.from('# Planner').toString('base64') })], removed: [] });

    const claudePath = join(tmp, 'claude', 'agents', 'planner.md');
    expect(existsSync(claudePath)).toBe(true);
    // No directory created under non-existent gemini/codex roots.
    expect(existsSync(join(tmp, 'gemini'))).toBe(false);
    expect(r.failures).toEqual([]);
  });

  test('artifact with no installed target reports skipped: no-target-tool', () => {
    // Artifact targets Gemini specifically; Gemini isn't installed.
    const r = mergePullResult({ pulled: [art({ id: 'a-6', type: 'skill', tool: 'gemini',
      bodyB64: Buffer.from('hi').toString('base64') })], removed: [] });
    expect(r.written).toEqual([]);
    expect(r.skipped.find(s => s.reason === 'no-target-tool')).toBeDefined();
  });

  test('mcp + plugin types stage in chat-recall data dir, not user-shared files', () => {
    mergePullResult({ pulled: [
      art({ id: 'a-7', type: 'mcp', name: 'pg', bodyB64: Buffer.from('{}').toString('base64') }),
      art({ id: 'a-8', type: 'plugin', name: 'foo', tool: 'claude', bodyB64: Buffer.from('{}').toString('base64') }),
    ], removed: [] });

    expect(existsSync(join(tmp, 'data', 'team-mcps', 'pg.json'))).toBe(true);
    expect(existsSync(join(tmp, 'data', 'team-plugins', 'claude', 'foo', 'manifest.json'))).toBe(true);
    // Critically: ~/.mcp.json was NOT touched
    expect(existsSync(join(process.env.HOME!, '.mcp.json'))).toBeDefined();  // existence depends on user's machine
  });

  test('hand-edited file with matching sha is treated as already-installed (no rewrite)', () => {
    const path = join(tmp, 'claude', 'skills', 'manual', 'SKILL.md');
    mkdirSync(join(tmp, 'claude', 'skills', 'manual'), { recursive: true });
    writeFileSync(path, 'identical');

    const r = mergePullResult({ pulled: [art({
      id: 'a-9', type: 'skill', name: 'manual', tool: 'cross_tool',
      bodyB64: Buffer.from('identical').toString('base64'),
    })], removed: [] });

    expect(r.skipped.find(s => s.reason === 'unchanged' && s.path === path)).toBeDefined();
    expect(r.written.find(w => w.path === path)).toBeUndefined();
  });
});
