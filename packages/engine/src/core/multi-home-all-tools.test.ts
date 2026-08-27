/**
 * Multi-profile support for EVERY tool, not just Claude.
 *
 * Each tool nests differently and one of them (OpenCode) keeps sessions in a
 * SQLite file rather than a directory, so "scan every home" needs a per-tool
 * root list. Getting this wrong is invisible: a secondary profile's sessions
 * simply never appear, with no error anywhere.
 *
 *   claude    <home>/projects/<project>/<id>.jsonl
 *   gemini    <home>/tmp/<project>/chats/session-*.json[l]
 *   codex     <home>/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   agy       <home>/brain/<id>/.system_generated/logs/*.jsonl
 *   opencode  <data-dir>/opencode.db          (a file, siblings are sibling DIRS)
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useHomeDir } from '../test-support/home-env.js';

let home: string;
const saved: Record<string, string | undefined> = {};
const ENV = [
  'HOME', 'CHAT_RECALL_CLAUDE_HOME', 'CHAT_RECALL_GEMINI_HOME',
  'CHAT_RECALL_CODEX_HOME', 'CHAT_RECALL_AGY_HOME', 'CHAT_RECALL_OPENCODE_DB',
  'CHAT_RECALL_CURSOR_HOME', 'CHAT_RECALL_CURSOR_IDE_HOME',
  'CLAUDE_DIRS', 'CHAT_RECALL_DATA_DIR',
];

function put(rel: string, body = '{"uuid":"x"}\n') {
  const full = join(home, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

async function paths() { return await import('./tool-paths.js'); }

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'cr-multihome-'));
  useHomeDir(home);
  // Any explicit override disables sibling discovery for that tool — clear them.
  for (const k of ENV.slice(1)) delete process.env[k];
  process.env.CHAT_RECALL_DATA_DIR = join(home, '.chat-recall');
  const { _clearSourceExclusions } = await import('./source-discovery.js');
  _clearSourceExclusions();
});

afterEach(async () => {
  const { _clearSourceExclusions } = await import('./source-discovery.js');
  _clearSourceExclusions();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('every tool discovers sibling profiles', () => {
  test('gemini: ~/.gemini and ~/.gemini-work both scanned', async () => {
    put('.gemini/tmp/projA/chats/session-1.jsonl');
    put('.gemini-work/tmp/projB/chats/session-2.jsonl');
    const { geminiTmpDirs } = await paths();
    const roots = geminiTmpDirs();
    expect(roots).toHaveLength(2);
    expect(roots[0]).toContain('.gemini/tmp');           // primary first
    expect(roots.some((r) => r.includes('.gemini-work'))).toBe(true);
  });

  test('codex: sessions/ roots from every home', async () => {
    put('.codex/sessions/2026/08/03/rollout-a.jsonl');
    put('.codex-t2/sessions/2026/08/03/rollout-b.jsonl');
    const { codexSessionDirs } = await paths();
    const roots = codexSessionDirs();
    expect(roots).toHaveLength(2);
    expect(roots[0]).toContain('.codex/sessions');
  });

  test('agy: brain/ roots from every home', async () => {
    put('.gemini/antigravity-cli/brain/s1/.system_generated/logs/a.jsonl');
    put('.gemini/antigravity-cli-alt/brain/s2/.system_generated/logs/b.jsonl');
    const { agyBrainDirs } = await paths();
    const roots = agyBrainDirs();
    expect(roots).toHaveLength(2);
    expect(roots[0]).toContain('antigravity-cli/brain');
  });

  test('opencode: a FILE, so siblings come from sibling data dirs', async () => {
    put('.local/share/opencode/opencode.db', 'sqlite');
    put('.local/share/opencode-work/opencode.db', 'sqlite');
    const { opencodeDbPaths } = await paths();
    const dbs = opencodeDbPaths();
    expect(dbs).toHaveLength(2);
    expect(dbs[0]).toContain('share/opencode/opencode.db');
    expect(dbs.some((d) => d.includes('opencode-work'))).toBe(true);
  });

  test('an explicit override pins the tool to one home', async () => {
    put('.codex/sessions/2026/08/03/rollout-a.jsonl');
    put('.codex-t2/sessions/2026/08/03/rollout-b.jsonl');
    process.env.CHAT_RECALL_CODEX_HOME = join(home, '.codex');
    const { codexSessionDirs } = await paths();
    // The operator said exactly where to look; discovery must not second-guess.
    expect(codexSessionDirs()).toHaveLength(1);
  });

  test('a home with no session root is not reported', async () => {
    put('.codex/sessions/2026/08/03/rollout-a.jsonl');
    mkdirSync(join(home, '.codex-empty'), { recursive: true });   // no sessions/
    const { codexSessionDirs } = await paths();
    expect(codexSessionDirs()).toHaveLength(1);
  });
});

describe('discovery reports every tool with a usable count', () => {
  test('per-tool nesting is counted correctly, not just Claude\'s', async () => {
    put('.claude/projects/projA/11111111-1111-1111-1111-111111111111.jsonl');
    put('.gemini/tmp/projA/chats/session-1.json');           // .json, two deep
    put('.codex/sessions/2026/08/03/rollout-a.jsonl');       // three deep
    put('.gemini/antigravity-cli/brain/s1/.system_generated/logs/a.jsonl'); // four deep
    put('.local/share/opencode/opencode.db', 'sqlite');

    const { discoverSessionSources } = await import('./source-discovery.js');
    const byTool = new Map(discoverSessionSources().map((s) => [s.tool, s]));

    expect(byTool.get('claude')?.sessions).toBe(1);
    expect(byTool.get('gemini')?.sessions).toBe(1);   // would be 0 if only .jsonl counted
    expect(byTool.get('codex')?.sessions).toBe(1);    // would be 0 at one level deep
    expect(byTool.get('agy')?.sessions).toBe(1);      // would be 0 at one level deep
    expect(byTool.get('opencode')).toBeTruthy();      // present even though rows aren't counted
    for (const s of byTool.values()) expect(s.id).toMatch(/^src_[0-9a-f]{12}$/);
  });

  test('secondary profiles appear as separate, non-primary sources', async () => {
    put('.gemini/tmp/projA/chats/session-1.jsonl');
    put('.gemini-work/tmp/projB/chats/session-2.jsonl');
    const { discoverSessionSources } = await import('./source-discovery.js');
    const gem = discoverSessionSources().filter((s) => s.tool === 'gemini');
    expect(gem).toHaveLength(2);
    expect(gem.filter((s) => s.isPrimary)).toHaveLength(1);
    expect(gem.filter((s) => !s.isPrimary)).toHaveLength(1);
  });
});

describe('exclusions apply to every tool, not only Claude', () => {
  test('excluding a gemini profile stops it being scanned', async () => {
    put('.gemini/tmp/projA/chats/session-1.jsonl');
    put('.gemini-work/tmp/projB/chats/session-2.jsonl');
    const { discoverSessionSources, installSourceExclusions } = await import('./source-discovery.js');
    const { geminiTmpDirs } = await paths();

    const work = discoverSessionSources().find((s) => s.path.includes('.gemini-work'))!;
    installSourceExclusions([work.id]);

    const roots = geminiTmpDirs();
    expect(roots).toHaveLength(1);
    expect(roots[0]).not.toContain('.gemini-work');
    // Still discoverable, so the dashboard can switch it back on.
    expect(discoverSessionSources().map((s) => s.id)).toContain(work.id);
  });

  test('excluding an opencode profile stops that db being opened', async () => {
    put('.local/share/opencode/opencode.db', 'sqlite');
    put('.local/share/opencode-work/opencode.db', 'sqlite');
    const { discoverSessionSources, installSourceExclusions } = await import('./source-discovery.js');
    const { opencodeDbPaths } = await paths();

    const work = discoverSessionSources().find((s) => s.path.includes('opencode-work'))!;
    installSourceExclusions([work.id]);
    expect(opencodeDbPaths()).toHaveLength(1);
  });

  test('excluding every profile of a tool falls back rather than scanning none', async () => {
    put('.codex/sessions/2026/08/03/rollout-a.jsonl');
    put('.codex-t2/sessions/2026/08/03/rollout-b.jsonl');
    const { discoverSessionSources, installSourceExclusions } = await import('./source-discovery.js');
    const { codexSessionDirs } = await paths();

    installSourceExclusions(
      discoverSessionSources().filter((s) => s.tool === 'codex').map((s) => s.id),
    );
    // "Nothing to scan" is indistinguishable from "no sessions exist".
    expect(codexSessionDirs().length).toBeGreaterThan(0);
  });
});
