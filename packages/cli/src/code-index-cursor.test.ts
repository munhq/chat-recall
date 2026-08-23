/**
 * A sweep that keeps getting interrupted must still eventually cover everything.
 *
 * `discoverWorkspaces()` sorts by most-recently-used, which is right for a first
 * run and wrong for every run after it: the busiest repo is always first, so it
 * is always the one that gets done. During the OOM crash-loop the daemon's median
 * uptime was ~105 seconds and a large repo takes tens of seconds, so the same one
 * or two were re-indexed on every restart and the tail was never reached at all —
 * 8,919 `indexing` lines against 382 completions.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prev: string | undefined;
let mod: typeof import('./code-index-cursor.js');

beforeEach(async () => {
  prev = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-cursor-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  mod = await import('./code-index-cursor.js');
});

afterEach(() => {
  if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('ordering', () => {
  test('never-indexed workspaces come first', () => {
    mod.noteIndexed('/repo/done', 1000);
    expect(mod.orderByStaleness(['/repo/done', '/repo/fresh'])).toEqual(['/repo/fresh', '/repo/done']);
  });

  test('least-recently-indexed first among indexed ones', () => {
    mod.noteIndexed('/a', 3000);
    mod.noteIndexed('/b', 1000);
    mod.noteIndexed('/c', 2000);
    expect(mod.orderByStaleness(['/a', '/b', '/c'])).toEqual(['/b', '/c', '/a']);
  });

  // A first run must behave exactly as it did before the cursor existed.
  test('with nothing indexed, the caller order (recency) is preserved', () => {
    const input = ['/most-recent', '/middle', '/oldest'];
    expect(mod.orderByStaleness(input)).toEqual(input);
  });

  // THE REGRESSION. Interrupt after each single completion and the sweep must
  // still reach every workspace, rather than redoing the head of the list.
  test('a sweep interrupted after every single index still covers everything', () => {
    const all = ['/w1', '/w2', '/w3', '/w4'];
    const done: string[] = [];
    for (let restart = 0; restart < all.length; restart++) {
      const first = mod.orderByStaleness(all)[0];   // one workspace, then "crash"
      mod.noteIndexed(first, 1000 + restart);
      done.push(first);
    }
    expect(new Set(done).size).toBe(all.length);
    expect(done.sort()).toEqual([...all].sort());
  });
});

describe('durability', () => {
  test('the cursor survives a fresh read (it is on disk, not in memory)', () => {
    mod.noteIndexed('/repo/x', 4242);
    expect(mod.readCursor()['/repo/x']).toBe(4242);
  });

  test('a corrupt cursor reads as empty rather than throwing', () => {
    writeFileSync(join(dataDir, 'code-index-cursor.json'), '{ not json');
    expect(mod.readCursor()).toEqual({});
  });

  test('non-numeric entries are discarded, not trusted', () => {
    writeFileSync(join(dataDir, 'code-index-cursor.json'), JSON.stringify({ '/ok': 5, '/bad': 'soon' }));
    expect(mod.readCursor()).toEqual({ '/ok': 5 });
  });

  test('an absent cursor is empty, not an error', () => {
    expect(existsSync(join(dataDir, 'code-index-cursor.json'))).toBe(false);
    expect(mod.readCursor()).toEqual({});
  });
});

describe('pruning', () => {
  test('paths that are no longer candidates are forgotten', () => {
    mod.noteIndexed('/keep', 1);
    mod.noteIndexed('/gone', 2);
    mod.pruneCursor(['/keep']);
    expect(mod.readCursor()).toEqual({ '/keep': 1 });
  });

  test('pruning to the same set rewrites nothing and loses nothing', () => {
    mod.noteIndexed('/a', 1);
    mod.noteIndexed('/b', 2);
    mod.pruneCursor(['/a', '/b']);
    expect(mod.readCursor()).toEqual({ '/a': 1, '/b': 2 });
  });
});
