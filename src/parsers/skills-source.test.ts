import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillsSource } from './skills-source.js';

let tmpHome: string;
const origHome = process.env.HOME;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'skills-'));
  process.env.HOME = tmpHome;
});
afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeSkill(root: string, skill: string, body: string) {
  const dir = join(tmpHome, ...root.split('/'), skill);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
}

async function collect(): Promise<any[]> {
  const src = new SkillsSource();
  const out: any[] = [];
  for await (const i of src.discover()) out.push(i);
  return out;
}

describe('SkillsSource', () => {
  test('discovers a Claude skill with frontmatter', async () => {
    writeSkill('.claude/skills', 'agent-onboarding', `---
name: agent-onboarding
description: Onboard yourself
---
Body here.`);
    const items = await collect();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('agent-onboarding');
    expect(items[0].extra.tool).toBe('claude');
    expect(items[0].extra.description).toBe('Onboard yourself');
  });

  test('discovers OpenCode skills (~/.config/opencode/skill/)', async () => {
    writeSkill('.config/opencode/skill', 'auditor', `---
name: auditor
description: Audit code
---`);
    const items = await collect();
    expect(items.find(i => i.extra.tool === 'opencode')).toBeDefined();
  });

  test('discovers Codex .system skills', async () => {
    writeSkill('.codex/skills/.system', 'plugin-creator', `---
name: plugin-creator
description: Create plugins
---`);
    const items = await collect();
    expect(items.find(i => i.extra.tool === 'codex')).toBeDefined();
  });

  test('discovers Codex plugin-bundled skills', async () => {
    writeSkill('.codex/.tmp/plugins/myplugin/skills', 'react-helper', `---
name: react-helper
description: React tips
---`);
    const items = await collect();
    // Plugin-bundled skills come through tagged with extra.plugin (the
    // identifying field is the plugin name, not a separate scope chip).
    const bundled = items.find(i => i.extra.tool === 'codex' && i.extra.plugin === 'myplugin');
    expect(bundled).toBeDefined();
    expect(bundled!.title).toBe('react-helper');
  });

  test('falls back to dirname when frontmatter is missing', async () => {
    writeSkill('.claude/skills', 'no-fm-skill', 'Just body, no frontmatter.');
    const items = await collect();
    expect(items[0].title).toBe('no-fm-skill');
    expect(items[0].extra.description).toBe('');
  });

  test('ignores entries without SKILL.md', async () => {
    mkdirSync(join(tmpHome, '.claude/skills/empty'), { recursive: true });
    const items = await collect();
    expect(items).toHaveLength(0);
  });

  test('inventories aux subdirs (scripts, references)', async () => {
    writeSkill('.claude/skills', 'rich-skill', `---
name: rich-skill
description: x
---`);
    mkdirSync(join(tmpHome, '.claude/skills/rich-skill/scripts'), { recursive: true });
    mkdirSync(join(tmpHome, '.claude/skills/rich-skill/references'), { recursive: true });
    writeFileSync(join(tmpHome, '.claude/skills/rich-skill/scripts/a.sh'), 'echo');
    const items = await collect();
    const subdirs = items[0].extra.subdirs as Record<string, number>;
    expect(subdirs.scripts).toBe(1);
    expect(subdirs.references).toBe(0);
  });

  test('parse() returns a chunk with full SKILL.md content', async () => {
    writeSkill('.claude/skills', 'parsed', `---
name: parsed
description: parsed
---
Content for chunk parsing.`);
    const src = new SkillsSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const chunks = await src.parse(items[0]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('Content for chunk parsing.');
  });
});
