import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childContract, extraArgs, localAgents, spawnChild, PERMISSION_MODES } from './session-spawn.js';

const PARENT = '11111111-0000-4000-8000-000000000001';
const CHILD = '22222222-0000-4000-8000-000000000002';
const saved = { path: process.env.PATH, data: process.env.CHAT_RECALL_DATA_DIR, cfg: process.env.CLAUDE_CONFIG_DIR };
let root: string;

/**
 * A stand-in for the claude CLI. `--bg` records its arguments, folder and
 * chat-recall environment, and prints what the real one prints; `agents
 * --json` lists the session it started.
 */
function fakeClaude(): void {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'agents') {
  process.stdout.write(JSON.stringify([{ id: 'abc12345', sessionId: '${CHILD}', kind: 'background', status: 'busy', state: 'working' }]));
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(join(root, 'call.json'))}, JSON.stringify({
  args, cwd: process.cwd(),
  parent: process.env.CHAT_RECALL_PARENT_SESSION, name: process.env.CHAT_RECALL_SESSION_NAME,
  doing: process.env.CHAT_RECALL_SESSION_DOING, configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
}));
process.stdout.write('Started in the background.\\n  claude attach abc12345    open in this terminal\\n');
`);
  chmodSync(join(bin, 'claude'), 0o755);
  process.env.PATH = `${bin}:${saved.path}`;
}

const call = () => JSON.parse(readFileSync(join(root, 'call.json'), 'utf-8'));

function parentState(state: Record<string, unknown>): void {
  const dir = join(root, 'data', 'hook-state', 'messages');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${PARENT}.json`), JSON.stringify({ introduced: true, stopBlocked: false, ...state }));
}

beforeEach(() => {
  // The real path: on macOS the temp folder is a symlink, and a child's process.cwd() gives its target.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cr-spawn-')));
  process.env.CHAT_RECALL_DATA_DIR = join(root, 'data');
  fakeClaude();
});
afterEach(() => {
  process.env.PATH = saved.path;
  if (saved.data === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = saved.data;
  if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('spawnChild', () => {
  test('starts a background session linked to its parent, and reads its id', async () => {
    const work = join(root, 'work');
    mkdirSync(work);
    const r = await spawnChild({ parentId: PARENT, parentName: 'lead', prompt: 'Fix the login redirect.', name: 'worker-a', doing: 'login redirect', cwd: work });
    expect(r).toEqual({ attachId: 'abc12345', sessionId: CHILD, cwd: work });
    const c = call();
    expect(c.args[0]).toBe('--bg');
    expect(c.args.at(-1)).toBe('Fix the login redirect.');
    expect(c.args).toContain('--append-system-prompt');
    expect(c.cwd).toBe(work);
    expect(c).toMatchObject({ parent: PARENT, name: 'worker-a', doing: 'login redirect' });
  });

  test("starts in the parent's folder and profile, as its hook recorded them", async () => {
    const folder = join(root, 'parent-folder');
    mkdirSync(folder);
    parentState({ cwd: folder, configDir: '/home/user/.claude-work' });
    process.env.CLAUDE_CONFIG_DIR = '/home/user/.claude-other';
    await spawnChild({ parentId: PARENT, parentName: null, prompt: 'x' });
    expect(call()).toMatchObject({ cwd: folder, configDir: '/home/user/.claude-work' });
  });

  test('a parent in the default profile starts a child in the default profile', async () => {
    parentState({ cwd: root, configDir: '' });
    process.env.CLAUDE_CONFIG_DIR = '/home/user/.claude-other';
    await spawnChild({ parentId: PARENT, parentName: null, prompt: 'x' });
    expect(call().configDir).toBeNull();
  });

  test('passes the model, the permission mode and a resume', async () => {
    await spawnChild({ parentId: PARENT, parentName: null, prompt: 'Continue.', model: 'sonnet', permissionMode: 'acceptEdits', resume: CHILD, cwd: root });
    const a: string[] = call().args;
    expect(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 2)).toEqual(['--resume', CHILD]);
    expect(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2)).toEqual(['--model', 'sonnet']);
    expect(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'acceptEdits']);
  });

  test('passes the extra arguments from CHAT_RECALL_SPAWN_CLAUDE_ARGS', async () => {
    process.env.CHAT_RECALL_SPAWN_CLAUDE_ARGS = JSON.stringify(['--settings', '/home/user/s.json']);
    try {
      await spawnChild({ parentId: PARENT, parentName: null, prompt: 'x', cwd: root });
      expect(call().args.slice(0, 3)).toEqual(['--bg', '--settings', '/home/user/s.json']);
    } finally { delete process.env.CHAT_RECALL_SPAWN_CLAUDE_ARGS; }
  });

  test('lists the local sessions', async () => {
    expect((await localAgents())[0]).toMatchObject({ id: 'abc12345', sessionId: CHILD, kind: 'background' });
  });
});

describe('extraArgs', () => {
  test('accepts a JSON list of strings and refuses anything else', () => {
    expect(extraArgs(undefined)).toEqual([]);
    expect(extraArgs('["--add-dir","/tmp"]')).toEqual(['--add-dir', '/tmp']);
    expect(() => extraArgs('--add-dir /tmp')).toThrow(/JSON list/);
    expect(() => extraArgs('[1]')).toThrow(/JSON list/);
  });
});

describe('permission modes', () => {
  test('a parent cannot give a child bypassPermissions', () => {
    expect(PERMISSION_MODES as readonly string[]).not.toContain('bypassPermissions');
  });
});

describe('childContract', () => {
  test('names the parent, makes its messages instructions, and asks for a report with evidence', () => {
    const c = childContract(PARENT, 'lead', 'worker-a');
    expect(c).toContain(`"lead" (${PARENT})`);
    expect(c).toContain('named "worker-a"');
    expect(c).toContain('is an instruction from your user');
    expect(c).toContain(`to: "${PARENT}"`);
    expect(c).toContain('evidence');
  });
});
