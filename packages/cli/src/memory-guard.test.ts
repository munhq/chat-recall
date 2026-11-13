import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RSS_MAX_MB, cgroupCurrentMb, cgroupDir, isOverMemoryLimit, memoryLimitMb, memoryStatMb, reclaimCgroup, releaseMemory, usedMb } from './memory-guard.js';

/**
 * The bound (issue #16).
 *
 * The daemon reached a 1.5 GiB cgroup peak on a corpus of 12,219 sessions and
 * the code-intelligence pass was the largest single source of it: the pass
 * added a workspace on top of a heap that was already full. These tests hold
 * the two guarantees the fix gives:
 *   - a pass never STARTS a workspace at or above the bound;
 *   - the collector returns the pages after a unit of work.
 */

/** The loop of `codeIndexTick`, with the resident size as an input. */
function runPass(workspaces: number, startRss: number, perWorkspace: number, limitMb: number) {
  let rss = startRss;
  let done = 0;
  for (let i = 0; i < workspaces; i++) {
    if (isOverMemoryLimit(rss, limitMb)) break;
    rss += perWorkspace;
    done++;
  }
  return { done, rss };
}

describe('memoryLimitMb', () => {
  it('uses the default when the variable is absent', () => {
    expect(memoryLimitMb({})).toBe(DEFAULT_RSS_MAX_MB);
  });

  it('reads the variable', () => {
    expect(memoryLimitMb({ CHAT_RECALL_WATCH_RSS_MAX_MB: '384' })).toBe(384);
  });

  it('ignores a value that is not a positive number', () => {
    for (const bad of ['', 'abc', '0', '-64', 'NaN']) {
      expect(memoryLimitMb({ CHAT_RECALL_WATCH_RSS_MAX_MB: bad })).toBe(DEFAULT_RSS_MAX_MB);
    }
  });
});

describe('isOverMemoryLimit', () => {
  it('is false below the bound and true at or above it', () => {
    expect(isOverMemoryLimit(511, 512)).toBe(false);
    expect(isOverMemoryLimit(512, 512)).toBe(true);
    expect(isOverMemoryLimit(513, 512)).toBe(true);
  });
});

describe('a pass stops at the bound', () => {
  it('does not start a workspace at or above the bound', () => {
    const { done, rss } = runPass(50, 300, 40, 512);
    expect(done).toBe(6);
    // The loop stopped because the next workspace would start over the bound,
    // so the resident size never exceeded the bound plus one workspace.
    expect(isOverMemoryLimit(rss, 512)).toBe(true);
    expect(rss - 40).toBeLessThan(512);
    expect(done).toBeLessThan(50);
  });

  it('stays under the bound plus one workspace on a large session set', () => {
    // 12,219 sessions, 50 workspaces, the numbers of the 2026-11-13 measurement:
    // 512 MiB bound, a 750 MiB resident size at the end of the old pass.
    const workspaces = 50;
    const perWorkspace = 40;
    const limit = 512;
    const { done, rss } = runPass(workspaces, 700, perWorkspace, limit);
    // Already over the bound at entry: the pass does no work at all.
    expect(done).toBe(0);
    expect(rss).toBe(700);
    expect(rss).toBeLessThan(750);
  });

  it('runs the whole list when the list is small', () => {
    const { done, rss } = runPass(3, 120, 40, 512);
    expect(done).toBe(3);
    expect(rss).toBe(240);
  });
  it('returns the pages when it pauses at the bound', () => {
    // The tick calls releaseMemory() before it breaks, so the daemon does not sit
    // at the bound for the rest of the run with committed pages it cannot use.
    let rss = 300;
    let released = 0;
    let done = 0;
    for (let i = 0; i < 50; i++) {
      if (isOverMemoryLimit(rss, 512)) { released++; break; }
      rss += 40;
      done++;
    }
    expect(done).toBe(6);
    expect(released).toBe(1);
  });
});

describe('releaseMemory', () => {
  it('calls the collector of the garbage when it exists', () => {
    let calls = 0;
    expect(releaseMemory(() => { calls++; })).toBe(true);
    expect(calls).toBe(1);
  });

  it('does nothing when the daemon has no --expose-gc', () => {
    expect(releaseMemory(undefined)).toBe(false);
  });
});

describe('usedMb', () => {
  it('takes the cgroup when the cgroup holds more than the daemon', () => {
    expect(usedMb(300, 1405)).toBe(1405);
  });

  it('takes the daemon when the daemon holds more', () => {
    expect(usedMb(600, 200)).toBe(600);
  });

  it('takes the daemon when there is no cgroup', () => {
    expect(usedMb(300, null)).toBe(300);
  });

  it('reads memory.current of the cgroup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-current-'));
    writeFileSync(join(dir, 'memory.current'), '1473245184\n');
    try {
      expect(cgroupCurrentMb(dir)).toBe(1405);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(cgroupCurrentMb(null)).toBe(null);
  });
});

describe('reclaimCgroup', () => {
  /** A cgroup directory with a memory.stat and a memory.reclaim file. */
  function fakeCgroup(fileBytes: number) {
    const dir = mkdtempSync(join(tmpdir(), 'cr-cgroup-'));
    writeFileSync(join(dir, 'memory.stat'), `anon ${100 * 1048576}\nfile ${fileBytes}\nkernel 20971520\n`);
    writeFileSync(join(dir, 'memory.reclaim'), '');
    return dir;
  }

  it('takes back the page cache above the floor', () => {
    const dir = fakeCgroup(775104192);
    try {
      expect(memoryStatMb(dir, 'file')).toBe(739);
      expect(reclaimCgroup(64, dir)).toBe(true);
      expect(readFileSync(join(dir, 'memory.reclaim'), 'utf8')).toBe('675M');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does nothing when the page cache is under the floor', () => {
    const dir = fakeCgroup(40 * 1048576);
    try {
      expect(reclaimCgroup(64, dir)).toBe(false);
      expect(readFileSync(join(dir, 'memory.reclaim'), 'utf8')).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does nothing when the process has no cgroup', () => {
    expect(reclaimCgroup(64, null)).toBe(false);
  });

  it('reads the unified cgroup path from the cgroup file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-cgfile-'));
    const file = join(dir, 'cgroup');
    writeFileSync(file, '0::/user.slice/user-1000.slice/app.slice/x.service\n');
    try {
      expect(cgroupDir(file)).toBe('/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/x.service');
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(cgroupDir(join(dir, 'absent'))).toBe(null);
  });
});
