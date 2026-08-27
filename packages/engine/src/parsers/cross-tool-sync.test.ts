/**
 * End-to-end: read an artifact from one tool, translate it through the codec,
 * write it where another tool expects it, and confirm the parser re-discovers
 * it as that tool's artifact. This is exactly the pipeline the server's
 * /api/toolkit promote + sync-all routes run.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { SlashCommandsSource } from './slash-commands-source.js';
import { SubagentsSource } from './subagents-source.js';
import { SkillsSource } from './skills-source.js';
import { readCommand, readAgent, emit } from '../core/artifact-codec.js';
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '../test-support/home-env.js';

let tmp: string;
const origHome = homeEnvSnapshot();
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'xsync-')); useHomeDir(tmp); });
afterEach(() => { restoreHomeEnv(origHome); rmSync(tmp, { recursive: true, force: true }); });

async function collect(src: any): Promise<any[]> {
  const out: any[] = [];
  for await (const i of src.discover()) out.push(i);
  return out;
}

function writeFile(p: string, c: string) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }

describe('command sync claude → gemini', () => {
  test('a Claude markdown command becomes a Gemini TOML command', async () => {
    writeFile(join(tmp, '.claude', 'commands', 'review.md'),
      '---\nname: review\ndescription: Review the diff\n---\nFind bugs in the staged changes.');

    // 1. discover source
    const src = (await collect(new SlashCommandsSource())).find(i => i.extra.tool === 'claude');
    expect(src).toBeDefined();

    // 2. translate + 3. emit (what promote does)
    const art = readCommand(src.filePath, src.extra.format);
    const out = emit('command', art, 'gemini');
    expect(existsSync(out.path)).toBe(false);
    writeFile(out.path, out.content);

    // 4. re-discover — now both tools have `review`
    const after = await collect(new SlashCommandsSource());
    const gem = after.find(i => i.extra.tool === 'gemini' && i.title === 'review');
    expect(gem).toBeDefined();
    expect(gem.extra.format).toBe('toml');
    expect(gem.extra.description).toBe('Review the diff');
  });
});

describe('agent sync claude → codex', () => {
  test('a Claude markdown agent becomes a Codex TOML agent', async () => {
    writeFile(join(tmp, '.claude', 'agents', 'auditor.md'),
      '---\nname: auditor\ndescription: audits security\n---\nYou hunt for vulns.');

    const src = (await collect(new SubagentsSource())).find(i => i.extra.tool === 'claude');
    const art = readAgent(src.filePath, src.extra.format);
    const out = emit('agent', art, 'codex');
    writeFile(out.path, out.content);

    const after = await collect(new SubagentsSource());
    const cdx = after.find(i => i.extra.tool === 'codex' && i.title === 'auditor');
    expect(cdx).toBeDefined();
    expect(cdx.extra.format).toBe('toml');
    expect(cdx.contentPreview).toContain('audits security');
  });
});

describe('skill discovery flags', () => {
  test('shared ~/.agents skills tagged shared; codex .system tagged readonly', async () => {
    writeFile(join(tmp, '.agents', 'skills', 'shared-one', 'SKILL.md'),
      '---\nname: shared-one\ndescription: x\n---\nbody');
    writeFile(join(tmp, '.claude', 'skills', 'mine', 'SKILL.md'),
      '---\nname: mine\ndescription: y\n---\nbody');
    writeFile(join(tmp, '.codex', 'skills', '.system', 'imagegen', 'SKILL.md'),
      '---\nname: imagegen\ndescription: z\n---\nbody');
    writeFile(join(tmp, '.codex', 'skills', 'user-skill', 'SKILL.md'),
      '---\nname: user-skill\ndescription: w\n---\nbody');

    const items = await collect(new SkillsSource());
    const shared = items.find(i => i.extra.skillName === 'shared-one');
    const claude = items.find(i => i.extra.skillName === 'mine');
    const sys = items.find(i => i.extra.skillName === 'imagegen');
    const userCodex = items.find(i => i.extra.skillName === 'user-skill');

    expect(shared?.extra.tool).toBe('shared');
    expect(shared?.extra.shared).toBe(true);
    expect(claude?.extra.tool).toBe('claude');
    expect(sys?.extra.readonly).toBe(true);          // .system is read-only
    expect(userCodex?.extra.tool).toBe('codex');
    expect(userCodex?.extra.readonly).toBeUndefined(); // user skill is syncable
  });
});
