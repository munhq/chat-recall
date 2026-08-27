/**
 * The security property of dashboard-configurable sources.
 *
 * The collector runs as the user with full read access. If the server could
 * name a path for it to sync, a compromised or cross-tenant-buggy server could
 * make every customer's machine read and upload anything. So the direction is
 * fixed: the CLIENT discovers and reports paths, and the server may only switch
 * a discovered source OFF, by id.
 *
 * These tests exist to make that property fail loudly if anyone ever "improves"
 * the config into an allow-list of paths.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useHomeDir } from '../test-support/home-env.js';

let home: string;
const saved: Record<string, string | undefined> = {};

function seed(claudeHome: string, project: string, ids: string[]) {
  const dir = join(home, claudeHome, 'projects', project);
  mkdirSync(dir, { recursive: true });
  for (const id of ids) writeFileSync(join(dir, `${id}.jsonl`), '{"uuid":"x"}\n');
}

async function mods() {
  return {
    ...(await import('./source-discovery.js')),
    ...(await import('./tool-paths.js')),
  };
}

beforeEach(async () => {
  for (const k of ['HOME', 'CHAT_RECALL_CLAUDE_HOME', 'CLAUDE_DIRS', 'CHAT_RECALL_DATA_DIR']) {
    saved[k] = process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), 'cr-sources-'));
  useHomeDir(home);
  delete process.env.CHAT_RECALL_CLAUDE_HOME;   // an override disables discovery
  delete process.env.CLAUDE_DIRS;
  process.env.CHAT_RECALL_DATA_DIR = join(home, '.chat-recall');
  const { _clearSourceExclusions } = await mods();
  _clearSourceExclusions();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const { _clearSourceExclusions } = await mods();
  _clearSourceExclusions();
  rmSync(home, { recursive: true, force: true });
});

describe('discovery', () => {
  test('finds every home and counts what is at stake', async () => {
    const { discoverSessionSources } = await mods();
    seed('.claude', '-proj-a', ['s1', 's2']);
    seed('.claude-work', '-proj-b', ['s3']);

    const found = discoverSessionSources();
    expect(found).toHaveLength(2);
    expect(found[0].isPrimary).toBe(true);
    expect(found[0].path).toContain('.claude/projects');
    expect(found[0].sessions).toBe(2);

    const work = found.find((s) => s.path.includes('.claude-work'))!;
    expect(work.sessions).toBe(1);
    expect(work.isPrimary).toBe(false);
    expect(work.newestMtime).toBeGreaterThan(0);
  });

  test('ids are stable and path-derived', async () => {
    const { discoverSessionSources, sourceId } = await mods();
    seed('.claude', '-proj-a', ['s1']);
    const [only] = discoverSessionSources();
    expect(only.id).toMatch(/^src_[0-9a-f]{12}$/);
    expect(only.id).toBe(sourceId(only.path));
    expect(discoverSessionSources()[0].id).toBe(only.id);
  });
});

describe('exclusions can only ever REMOVE a source', () => {
  test('an excluded source stops being scanned', async () => {
    const { discoverSessionSources, installSourceExclusions, claudeProjectDirs } = await mods();
    seed('.claude', '-proj-a', ['s1']);
    seed('.claude-work', '-proj-b', ['s2']);

    const work = discoverSessionSources().find((s) => s.path.includes('.claude-work'))!;
    expect(claudeProjectDirs()).toHaveLength(2);

    installSourceExclusions([work.id]);
    const scanned = claudeProjectDirs();
    expect(scanned).toHaveLength(1);
    expect(scanned[0]).not.toContain('.claude-work');
  });

  test('an excluded source is still DISCOVERABLE, so it can be switched back on', async () => {
    const { discoverSessionSources, installSourceExclusions } = await mods();
    seed('.claude', '-proj-a', ['s1']);
    seed('.claude-work', '-proj-b', ['s2']);
    const work = discoverSessionSources().find((s) => s.path.includes('.claude-work'))!;

    installSourceExclusions([work.id]);
    // The dashboard must be able to render a switched-off source.
    expect(discoverSessionSources().map((s) => s.id)).toContain(work.id);
  });

  test('a path from the server is IGNORED — this is the whole security model', async () => {
    const { installSourceExclusions, isSourceExcluded, claudeProjectDirs } = await mods();
    seed('.claude', '-proj-a', ['s1']);
    seed('.claude-work', '-proj-b', ['s2']);
    const before = claudeProjectDirs();

    // A hostile/buggy server sends paths and path-shaped strings instead of ids.
    const applied = installSourceExclusions([
      '/home/user/.ssh',
      '../../etc',
      'src_not-hex-here',
      'claude-work',
      '/home/user/.claude-work/projects',
    ] as string[]);

    expect(applied.excluded).toBe(0);
    expect(isSourceExcluded('/home/user/.ssh')).toBe(false);
    // And nothing about what we scan has changed.
    expect(claudeProjectDirs()).toEqual(before);
  });

  test('config can never widen the scan set — only ids that were discovered match', async () => {
    const { installSourceExclusions, claudeProjectDirs, sourceId } = await mods();
    seed('.claude', '-proj-a', ['s1']);
    const before = claudeProjectDirs();

    // A well-formed id for a path this machine does NOT have.
    installSourceExclusions([sourceId('/some/other/machine/.claude/projects')]);
    expect(claudeProjectDirs()).toEqual(before);
  });

  test('excluding everything leaves the primary rather than scanning nothing', async () => {
    const { discoverSessionSources, installSourceExclusions, claudeProjectDirs } = await mods();
    seed('.claude', '-proj-a', ['s1']);
    seed('.claude-work', '-proj-b', ['s2']);

    installSourceExclusions(discoverSessionSources().map((s) => s.id));
    // An empty scan set is indistinguishable from "this machine has no
    // sessions", which would read as data loss. Fail safe to the full set.
    expect(claudeProjectDirs().length).toBeGreaterThan(0);
  });

  test('clearing exclusions restores every source', async () => {
    const { discoverSessionSources, installSourceExclusions, _clearSourceExclusions, claudeProjectDirs } = await mods();
    seed('.claude', '-proj-a', ['s1']);
    seed('.claude-work', '-proj-b', ['s2']);
    const work = discoverSessionSources().find((s) => s.path.includes('.claude-work'))!;

    installSourceExclusions([work.id]);
    expect(claudeProjectDirs()).toHaveLength(1);
    _clearSourceExclusions();
    expect(claudeProjectDirs()).toHaveLength(2);
  });
});
