/**
 * A recommendation rule has to reach the file the reader's tool actually opens.
 *
 * It used to be written to CLAUDE.md in every case. A Codex or Cursor user
 * therefore got a new CLAUDE.md in their repo, their own AGENTS.md untouched,
 * and none of the guidance the rule existed to add — a silent no-op that looked
 * like a success in the UI.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyCodeRecommendation, runIntent, type PendingIntent } from './intent-drain.js';
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '@chat-recall/engine/test-support/home-env.js';

const RULE = 'Never commit a generated file without re-stamping its hash.';

function intent(rootPath: string): PendingIntent {
  return {
    id: 'i1',
    kind: 'code_apply',
    artifact_type: 'append_claude_md',
    name: JSON.stringify({ rootPath, payload: { text: RULE } }),
    from_tool: null,
    to_tool: null,
  };
}

describe('a recommendation rule reaches every instruction file the project has', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cr-instr-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('a project with only AGENTS.md gets the rule there, and no CLAUDE.md appears', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# example-app instructions\n');
    const out = applyCodeRecommendation(intent(root));
    expect(out.status).toBe('done');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain(RULE);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  });

  test('a project with three instruction files gets the rule in all three', () => {
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      writeFileSync(join(root, f), `# example-app instructions\n`);
    }
    const out = applyCodeRecommendation(intent(root));
    expect(out.status).toBe('done');
    expect(JSON.parse(out.result).appended).toHaveLength(3);
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      expect(readFileSync(join(root, f), 'utf8')).toContain(RULE);
    }
  });

  test('applying the same rule twice appends it once', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# example-app instructions\n');
    applyCodeRecommendation(intent(root));
    const second = applyCodeRecommendation(intent(root));
    expect(second.status).toBe('done');
    expect(JSON.parse(second.result).skipped).toHaveLength(1);
    const body = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(body.split(RULE)).toHaveLength(2);
  });

  test('a project with no instruction file at all still gets one', () => {
    const out = applyCodeRecommendation(intent(root));
    expect(out.status).toBe('done');
    const written = JSON.parse(out.result).appended as string[];
    expect(written.length).toBeGreaterThan(0);
    for (const f of written) expect(readFileSync(f, 'utf8')).toContain(RULE);
  });

  test('a rule with no project and no global flag is refused, not guessed at', () => {
    const bad: PendingIntent = { ...intent(root), name: JSON.stringify({ payload: { text: RULE } }) };
    expect(applyCodeRecommendation(bad).status).toBe('error');
  });
});

describe('a remove intent runs on the device that holds the artifact', () => {
  let home: string;
  const origHome = homeEnvSnapshot();
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cr-drain-home-')); useHomeDir(home); });
  afterEach(() => { restoreHomeEnv(origHome); rmSync(home, { recursive: true, force: true }); });

  const remove = (artifact_type: string | null, name: string | null): PendingIntent => ({
    id: 'r1', kind: 'remove', artifact_type, name, from_tool: null, to_tool: 'claude',
  });

  test('a command is removed and its file is kept in the trash', async () => {
    const file = join(home, '.claude', 'commands', 'review.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '---\nname: review\ndescription: r\n---\nFind bugs.');
    const out = await runIntent(remove('command', 'review'), { base: 'https://example.invalid' });
    expect(out.status).toBe('done');
    expect(existsSync(file)).toBe(false);
    expect(JSON.parse(out.result).backupPaths).toHaveLength(1);
  });

  test('an absent MCP server acks as done, because the requested state already holds', async () => {
    const out = await runIntent(remove('mcp', 'nope'), { base: 'https://example.invalid' });
    expect(out.status).toBe('done');
  });

  test('an instruction file is refused and nothing is deleted', async () => {
    const file = join(home, '.claude', 'CLAUDE.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# rules');
    const out = await runIntent(remove('instructions', 'CLAUDE.md'), { base: 'https://example.invalid' });
    expect(out.status).toBe('error');
    expect(existsSync(file)).toBe(true);
  });
});
