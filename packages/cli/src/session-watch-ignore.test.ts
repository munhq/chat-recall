/**
 * The sessions watcher holds one inotify watch for each folder it descends into.
 * A session is `<root>/<project>/<id>.jsonl`, so the folders below a project
 * folder carry no session and get no watch.
 */
import { describe, it, expect } from 'vitest';
import chokidar from 'chokidar';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { isBelowProjectFolder, sessionWatchIgnored } from './session-watch-ignore.js';

const ROOT = join(sep, 'home', 'user', '.claude', 'projects');
const OTHER = join(sep, 'home', 'user', '.claude-second', 'projects');

describe('isBelowProjectFolder', () => {
  it('a root and a project folder are not below a project folder', () => {
    expect(isBelowProjectFolder(ROOT, [ROOT])).toBe(false);
    expect(isBelowProjectFolder(join(ROOT, '-home-user-code-example'), [ROOT])).toBe(false);
  });

  it('the folders inside a project folder are below it', () => {
    const project = join(ROOT, '-home-user-code-example');
    expect(isBelowProjectFolder(join(project, 'memory'), [ROOT])).toBe(true);
    expect(isBelowProjectFolder(join(project, '0a1b2c3d', 'subagents', 'workflows'), [ROOT])).toBe(true);
  });

  it('each root of a second Claude home counts the same way', () => {
    expect(isBelowProjectFolder(join(OTHER, 'p'), [ROOT, OTHER])).toBe(false);
    expect(isBelowProjectFolder(join(OTHER, 'p', 'sub'), [ROOT, OTHER])).toBe(true);
  });

  it('a folder outside every root is not below a project folder', () => {
    expect(isBelowProjectFolder(join(sep, 'home', 'user', 'elsewhere', 'a', 'b'), [ROOT])).toBe(false);
  });

  it('a root whose name starts like another root does not match it', () => {
    expect(isBelowProjectFolder(`${ROOT}-copy${sep}p${sep}sub`, [ROOT])).toBe(false);
  });
});

describe('the sessions watcher on a real tree', () => {
  const DAY = 24 * 60 * 60 * 1000;

  function tree(): string {
    const root = mkdtempSync(join(tmpdir(), 'cr-session-watch-'));
    const project = join(root, 'project-a');
    mkdirSync(join(project, 'memory'), { recursive: true });
    mkdirSync(join(project, '0a1b2c3d', 'subagents', 'workflows', 'wf'), { recursive: true });
    mkdirSync(join(root, 'project-b'), { recursive: true });
    writeFileSync(join(project, 'recent.jsonl'), '{}\n');
    writeFileSync(join(project, 'memory', 'note.md'), 'note\n');
    writeFileSync(join(project, '0a1b2c3d', 'subagents', 'agent-1.jsonl'), '{}\n');
    writeFileSync(join(project, '0a1b2c3d', 'subagents', 'workflows', 'wf', 'journal.jsonl'), '{}\n');
    const old = join(root, 'project-b', 'old.jsonl');
    writeFileSync(old, '{}\n');
    const longAgo = new Date(Date.now() - 30 * DAY);
    utimesSync(old, longAgo, longAgo);
    return root;
  }

  async function open(root: string): Promise<chokidar.FSWatcher> {
    const watcher = chokidar.watch(`${root}/**/*.jsonl`, {
      persistent: true,
      ignoreInitial: true,
      ignored: sessionWatchIgnored([root], 14 * DAY),
    });
    await new Promise<void>((resolve) => watcher.on('ready', () => resolve()));
    return watcher;
  }

  it('watches the root, the project folders and the transcripts of the window, and nothing below them', async () => {
    const root = tree();
    const watcher = await open(root);
    try {
      // getWatched also lists the parents of the root and the glob itself.
      const dirs = Object.keys(watcher.getWatched())
        .filter((d) => (d === root || d.startsWith(root + sep)) && !d.includes('*'))
        .sort();
      expect(dirs).toEqual([root, join(root, 'project-a'), join(root, 'project-b')].sort());
      expect(watcher.getWatched()[join(root, 'project-a')]).toContain('recent.jsonl');
      expect(watcher.getWatched()[join(root, 'project-b')] ?? []).not.toContain('old.jsonl');
    } finally {
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a session that appears in a project folder', async () => {
    const root = tree();
    const watcher = await open(root);
    try {
      const added = new Promise<string>((resolve) => watcher.on('add', (p) => resolve(p)));
      writeFileSync(join(root, 'project-a', 'new-session.jsonl'), '{}\n');
      expect(await added).toBe(join(root, 'project-a', 'new-session.jsonl'));
    } finally {
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a session in a project folder that appears after the start', async () => {
    const root = tree();
    const watcher = await open(root);
    try {
      const added = new Promise<string>((resolve) => watcher.on('add', (p) => resolve(p)));
      mkdirSync(join(root, 'project-c'));
      writeFileSync(join(root, 'project-c', 'first.jsonl'), '{}\n');
      expect(await added).toBe(join(root, 'project-c', 'first.jsonl'));
    } finally {
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
