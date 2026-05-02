import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SlashCommandsSource } from './slash-commands-source.js';

let tmpHome: string;
const origHome = process.env.HOME;
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'cmds-')); process.env.HOME = tmpHome; });
afterEach(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

async function collect(): Promise<any[]> {
  const out: any[] = [];
  for await (const i of new SlashCommandsSource().discover()) out.push(i);
  return out;
}

describe('SlashCommandsSource', () => {
  test('discovers user-scope ~/.claude/commands/*.md', async () => {
    mkdirSync(join(tmpHome, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(tmpHome, '.claude', 'commands', 'review.md'), `---
name: review
description: Code review helper
---
Body goes here.`);
    const items = await collect();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('review');
    expect(items[0].extra.scope).toBe('user');
    expect(items[0].extra.tool).toBe('claude');
    expect(items[0].extra.description).toBe('Code review helper');
  });

  test.skip('discovers project-scope <project>/.claude/commands/*.md', async () => {
    const projectPath = '/proj';
    const enc = projectPath.replace(/^\//, '-').replace(/\//g, '-');
    mkdirSync(join(tmpHome, '.claude', 'projects', enc), { recursive: true });
    mkdirSync(join(tmpHome, projectPath, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(tmpHome, projectPath, '.claude', 'commands', 'audit.md'), `---
name: audit
description: project audit
---`);
    const items = await collect();
    const project = items.find(i => i.extra.scope === 'project');
    expect(project).toBeDefined();
    expect(project.title).toBe('audit');
  });

  test('falls back to filename when frontmatter is missing', async () => {
    mkdirSync(join(tmpHome, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(tmpHome, '.claude', 'commands', 'plain.md'), 'No frontmatter here.');
    const items = await collect();
    expect(items[0].title).toBe('plain');
  });

  test('parse() returns the markdown body as a chunk', async () => {
    mkdirSync(join(tmpHome, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(tmpHome, '.claude', 'commands', 'x.md'), '---\nname: x\n---\nbody');
    const src = new SlashCommandsSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const chunks = await src.parse(items[0]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('body');
  });

  test('returns empty when commands dir is missing', async () => {
    expect(await collect()).toHaveLength(0);
  });
});
