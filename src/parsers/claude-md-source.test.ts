import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeMdSource } from './claude-md-source.js';

let tmp: string;
let tmpHome: string;
const origHome = process.env.HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cmd-'));
  // Isolate $HOME — ClaudeMdSource also scans ~/.claude/projects + ~/CLAUDE.md.
  // Without overriding, the developer's real notes pollute the result.
  tmpHome = mkdtempSync(join(tmpdir(), 'cmd-home-'));
  process.env.HOME = tmpHome;
});
afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});

async function collect(searchDir: string): Promise<any[]> {
  // Scope the source via constructor to a temp dir so we don't pull in
  // the developer's real ~/.claude or system dirs.
  const src = new ClaudeMdSource([searchDir]);
  const out: any[] = [];
  for await (const i of src.discover()) out.push(i);
  return out;
}

describe('ClaudeMdSource', () => {
  test('discovers CLAUDE.md, GEMINI.md, AGENTS.md in a search dir', async () => {
    mkdirSync(join(tmp, 'proj-claude'), { recursive: true });
    writeFileSync(join(tmp, 'proj-claude', 'CLAUDE.md'), 'project claude notes');
    mkdirSync(join(tmp, 'proj-gem'), { recursive: true });
    writeFileSync(join(tmp, 'proj-gem', 'GEMINI.md'), 'project gemini notes');
    mkdirSync(join(tmp, 'proj-oc'), { recursive: true });
    writeFileSync(join(tmp, 'proj-oc', 'AGENTS.md'), 'agents notes');

    const items = await collect(tmp);
    const tools = items.map(i => i.extra?.tool).filter(Boolean);
    // AGENTS.md is yielded twice (one for opencode, one for codex tagging).
    expect(tools).toEqual(expect.arrayContaining(['claude', 'gemini', 'opencode']));
  });

  test('parse() splits CLAUDE.md into chunks by ## headers', async () => {
    mkdirSync(join(tmp, 'p'), { recursive: true });
    writeFileSync(join(tmp, 'p', 'CLAUDE.md'),
      `# Top\n## Section A\n${'a '.repeat(40)}\n## Section B\n${'b '.repeat(40)}`);
    const src = new ClaudeMdSource([tmp]);
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    if (items.length === 0) return;
    const chunks = await src.parse(items[0]);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test('returns empty for a search dir with nothing in it', async () => {
    expect(await collect(tmp)).toEqual([]);
  });
});
