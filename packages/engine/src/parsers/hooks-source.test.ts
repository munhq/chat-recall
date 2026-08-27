import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HooksSource } from './hooks-source.js';
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '../test-support/home-env.js';

let tmpHome: string;
const origHome = homeEnvSnapshot();
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'hooks-')); useHomeDir(tmpHome); });
afterEach(() => { restoreHomeEnv(origHome); rmSync(tmpHome, { recursive: true, force: true }); });

function writeSettings(scope: 'user' | 'project', json: any, projectPath = '/tmp/proj') {
  if (scope === 'user') {
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    writeFileSync(join(tmpHome, '.claude', 'settings.json'), JSON.stringify(json));
  } else {
    // Project scope — needs a project dir under ~/.claude/projects mapping to a real path on disk.
    const enc = projectPath.replace(/^\//, '-').replace(/\//g, '-');
    mkdirSync(join(tmpHome, '.claude', 'projects', enc), { recursive: true });
    mkdirSync(join(tmpHome, projectPath, '.claude'), { recursive: true });
    writeFileSync(join(tmpHome, projectPath, '.claude', 'settings.json'), JSON.stringify(json));
  }
}

async function collect(): Promise<any[]> {
  const out: any[] = [];
  for await (const i of new HooksSource().discover()) out.push(i);
  return out;
}

describe('HooksSource', () => {
  test('yields one item per (event, command) tuple', async () => {
    writeSettings('user', {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: '/x/start.sh' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: '/x/end.sh' }] }],
        PostToolUse: [{ matcher: 'Bash|Edit', hooks: [{ type: 'command', command: '/x/post.sh' }] }],
      },
    });
    const items = await collect();
    expect(items).toHaveLength(3);
    const events = items.map(i => i.extra.event);
    expect(events).toEqual(expect.arrayContaining(['SessionStart', 'SessionEnd', 'PostToolUse']));
    const post = items.find(i => i.extra.event === 'PostToolUse')!;
    expect(post.extra.matcher).toBe('Bash|Edit');
    expect(post.title).toMatch(/PostToolUse \(Bash\|Edit\)/);
  });

  test('skips entries with empty command', async () => {
    writeSettings('user', { hooks: { Stop: [{ hooks: [{ type: 'command', command: '' }] }] } });
    expect(await collect()).toHaveLength(0);
  });

  test('every yielded item is tagged tool=claude', async () => {
    writeSettings('user', { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x.sh' }] }] } });
    const items = await collect();
    expect(items.every(i => i.extra.tool === 'claude')).toBe(true);
  });

  test('parse() returns a single chunk summarizing the hook', async () => {
    writeSettings('user', { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x.sh' }] }] } });
    const src = new HooksSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const chunks = await src.parse(items[0]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toMatch(/Hook: Stop/);
    expect(chunks[0].text).toMatch(/Command: \/x.sh/);
  });

  test('handles malformed settings.json without throwing', async () => {
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    writeFileSync(join(tmpHome, '.claude', 'settings.json'), '{ not json');
    expect(await collect()).toHaveLength(0);
  });
});
