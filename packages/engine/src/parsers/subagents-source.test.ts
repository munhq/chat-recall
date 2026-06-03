import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SubagentsSource } from './subagents-source.js';

let tmpHome: string;
const origHome = process.env.HOME;
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'agents-')); process.env.HOME = tmpHome; });
afterEach(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

async function collect(): Promise<any[]> {
  const out: any[] = [];
  for await (const i of new SubagentsSource().discover()) out.push(i);
  return out;
}

describe('SubagentsSource', () => {
  test('discovers user-scope ~/.claude/agents/*.md', async () => {
    mkdirSync(join(tmpHome, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(tmpHome, '.claude', 'agents', 'code-reviewer.md'), `---
name: code-reviewer
description: Reviews PRs
tools: Read,Grep
---
You are a thorough code reviewer.`);
    const items = await collect();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('code-reviewer');
    expect(items[0].extra.tools).toBe('Read,Grep');
    expect(items[0].extra.tool).toBe('claude');
  });

  test('parse() emits a chunk with the agent prompt body', async () => {
    mkdirSync(join(tmpHome, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(tmpHome, '.claude', 'agents', 'x.md'), '---\nname: x\n---\nprompt body');
    const src = new SubagentsSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const chunks = await src.parse(items[0]);
    expect(chunks[0].text).toContain('prompt body');
  });

  test('returns empty when agents dir absent', async () => {
    expect(await collect()).toHaveLength(0);
  });
});
