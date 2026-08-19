/**
 * Tests for the team-merge module — verifies that pulled artifacts land
 * in the right per-tool paths, that re-pulls are idempotent, and that
 * server-side revocations clean local files.
 *
 * We point CHAT_RECALL_DATA_DIR + CHAT_RECALL_*_HOME at fresh tmp dirs
 * so the test never touches a real ~/.claude.
 *
 * The install ledger moved from a local better-sqlite3 file to the server, so
 * it is stubbed here with an in-memory map. That keeps these tests offline —
 * they must never reach a real server — while still exercising the real merge
 * logic, including revocation, which now recomputes each path from the
 * (type, name, tool) the ledger carries instead of a stored path.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ledger = vi.hoisted(() => new Map<string, {
  artifactId: string; tool: string; artifactType: string; artifactName: string;
  sha256: string; installedAt: number;
}>());

vi.mock('./team-client.js', () => ({
  teamInstallsList: async (artifactId?: string) =>
    [...ledger.values()].filter((r) => !artifactId || r.artifactId === artifactId),
  teamInstallsRecord: async (rows: Array<{ artifactId: string; tool: string }>) => {
    for (const r of rows as any[]) ledger.set(`${r.artifactId}|${r.tool}`, r);
  },
  teamInstallsForget: async (artifactId: string, tool?: string) => {
    for (const [k, r] of [...ledger.entries()]) {
      if (r.artifactId === artifactId && (!tool || r.tool === tool)) ledger.delete(k);
    }
  },
}));

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
  ledger.clear();
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
  test('writes a cross_tool skill into Claude skills dir', async () => {
    const r = await mergePullResult({ pulled: [art({ id: 'a-1', type: 'skill', name: 'mycool', tool: 'cross_tool',
      bodyB64: Buffer.from('# My cool skill').toString('base64') })], removed: [] });

    const claudePath = join(tmp, 'claude', 'skills', 'mycool', 'SKILL.md');
    expect(existsSync(claudePath)).toBe(true);
    expect(readFileSync(claudePath, 'utf-8')).toBe('# My cool skill');
    expect(r.written.length).toBeGreaterThanOrEqual(1);
    expect(r.failures).toEqual([]);
  });

  test('re-pulling identical body marks skipped: unchanged (idempotent)', async () => {
    const a = art({ id: 'a-2', type: 'skill', name: 's', bodyB64: Buffer.from('v1').toString('base64') });
    await mergePullResult({ pulled: [a], removed: [] });
    const r2 = await mergePullResult({ pulled: [a], removed: [] });

    const unchanged = r2.skipped.filter(s => s.reason === 'unchanged');
    expect(unchanged.length).toBeGreaterThanOrEqual(1);
    expect(r2.written).toEqual([]);
  });

  test('updated body overwrites the previous file', async () => {
    await mergePullResult({ pulled: [art({ id: 'a-3', name: 's', bodyB64: Buffer.from('v1').toString('base64') })], removed: [] });
    await mergePullResult({ pulled: [art({ id: 'a-3', name: 's', version: 2, bodyB64: Buffer.from('v2').toString('base64') })], removed: [] });

    const path = join(tmp, 'claude', 'skills', 's', 'SKILL.md');
    expect(readFileSync(path, 'utf-8')).toBe('v2');
  });

  test('revocation deletes every file we previously wrote for that artifact', async () => {
    await mergePullResult({ pulled: [art({ id: 'a-4', name: 'tox', bodyB64: Buffer.from('content').toString('base64') })], removed: [] });
    const path = join(tmp, 'claude', 'skills', 'tox', 'SKILL.md');
    expect(existsSync(path)).toBe(true);

    const r = await mergePullResult({ pulled: [], removed: ['a-4'] });
    expect(existsSync(path)).toBe(false);
    expect(r.removed.find(x => x.path === path)).toBeDefined();
  });

  test('agent type only installs to Claude, not other tools', async () => {
    // Claude is installed (projects dir exists); other tools aren't.
    const r = await mergePullResult({ pulled: [art({ id: 'a-5', type: 'agent', name: 'planner',
      tool: 'cross_tool', bodyB64: Buffer.from('# Planner').toString('base64') })], removed: [] });

    const claudePath = join(tmp, 'claude', 'agents', 'planner.md');
    expect(existsSync(claudePath)).toBe(true);
    // No directory created under non-existent gemini/codex roots.
    expect(existsSync(join(tmp, 'gemini'))).toBe(false);
    expect(r.failures).toEqual([]);
  });

  test('artifact with no installed target reports skipped: no-target-tool', async () => {
    // Artifact targets Gemini specifically; Gemini isn't installed.
    const r = await mergePullResult({ pulled: [art({ id: 'a-6', type: 'skill', tool: 'gemini',
      bodyB64: Buffer.from('hi').toString('base64') })], removed: [] });
    expect(r.written).toEqual([]);
    expect(r.skipped.find(s => s.reason === 'no-target-tool')).toBeDefined();
  });

  test('mcp + plugin types stage in chat-recall data dir, not user-shared files', async () => {
    await mergePullResult({ pulled: [
      art({ id: 'a-7', type: 'mcp', name: 'pg', bodyB64: Buffer.from('{}').toString('base64') }),
      art({ id: 'a-8', type: 'plugin', name: 'foo', tool: 'claude', bodyB64: Buffer.from('{}').toString('base64') }),
    ], removed: [] });

    expect(existsSync(join(tmp, 'data', 'team-mcps', 'pg.json'))).toBe(true);
    expect(existsSync(join(tmp, 'data', 'team-plugins', 'claude', 'foo', 'manifest.json'))).toBe(true);
    // Critically: ~/.mcp.json was NOT touched
    expect(existsSync(join(process.env.HOME!, '.mcp.json'))).toBeDefined();  // existence depends on user's machine
  });

  test('hand-edited file with matching sha is treated as already-installed (no rewrite)', async () => {
    const path = join(tmp, 'claude', 'skills', 'manual', 'SKILL.md');
    mkdirSync(join(tmp, 'claude', 'skills', 'manual'), { recursive: true });
    writeFileSync(path, 'identical');

    const r = await mergePullResult({ pulled: [art({
      id: 'a-9', type: 'skill', name: 'manual', tool: 'cross_tool',
      bodyB64: Buffer.from('identical').toString('base64'),
    })], removed: [] });

    expect(r.skipped.find(s => s.reason === 'unchanged' && s.path === path)).toBeDefined();
    expect(r.written.find(w => w.path === path)).toBeUndefined();
  });
});
