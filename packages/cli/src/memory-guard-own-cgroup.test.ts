/**
 * A process counts the memory of its cgroup only when the cgroup is a unit with a limit of its own.
 * A `chat-recall sync` started from a terminal sits in the cgroup of the login session, which holds
 * every program of the user: it read 17,754 MB, passed the hard bound after one build, and shipped
 * one session of the two it was given.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cgroupHasLimit, ownCgroupDir, cgroupCurrentMb, usedMb } from './memory-guard.js';

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cr-cgroup-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function cgroup(path: string, files: Record<string, string>): string {
  const dir = join(root, path);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
const procFile = (path: string) => { const f = join(root, 'proc-cgroup'); writeFileSync(f, `0::${path}\n`); return f; };

describe('ownCgroupDir', () => {
  it('is the cgroup of a unit that sets MemoryMax and MemoryHigh', () => {
    const dir = cgroup('app.slice/chat-recall-watch.service', { 'memory.max': '2147483648\n', 'memory.high': '1073741824\n', 'memory.current': String(900 * 1048576) });
    expect(ownCgroupDir(procFile('/app.slice/chat-recall-watch.service'), root)).toBe(dir);
  });

  it('is null for the cgroup of a login session, which has no limit', () => {
    cgroup('user.slice/session-3.scope', { 'memory.max': 'max\n', 'memory.high': 'max\n', 'memory.current': String(17754 * 1048576) });
    expect(ownCgroupDir(procFile('/user.slice/session-3.scope'), root)).toBeNull();
  });

  it('is null when the cgroup files are absent', () => {
    expect(ownCgroupDir(procFile('/nowhere'), root)).toBeNull();
  });
});

describe('cgroupHasLimit', () => {
  it('reads a number in either file and ignores max', () => {
    expect(cgroupHasLimit(cgroup('a', { 'memory.max': 'max\n', 'memory.high': '1073741824\n' }))).toBe(true);
    expect(cgroupHasLimit(cgroup('b', { 'memory.max': '2147483648\n' }))).toBe(true);
    expect(cgroupHasLimit(cgroup('c', { 'memory.max': 'max\n', 'memory.high': 'max\n' }))).toBe(false);
  });
});

describe('what the walk reads', () => {
  it('the rss decides when the process has no cgroup of its own', () => {
    expect(cgroupCurrentMb(null)).toBeNull();
    expect(usedMb(450, cgroupCurrentMb(null))).toBe(450);
  });
});
