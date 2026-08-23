/**
 * The shadow archive had no retention policy: 1.3 GB across 15,720 files on the
 * maintainer's machine, growing with every session forever, on the USER'S disk.
 *
 * The one rule that makes pruning safe: a shadow exists so a resume that
 * truncates the live file cannot destroy records that were never shipped. Until
 * every configured target has acked the session, it may be the last copy in
 * existence. So the central test here is not "does it free space" — it is
 * "does it refuse to touch an unacked shadow", at any age and any size.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prev: string | undefined;
let mod: typeof import('./shadow-prune.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  prev = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-shadow-prune-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  mod = await import('./shadow-prune.js');
});

afterEach(() => {
  if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

/** Write a shadow of `bytes`, aged `ageDays` days. */
function shadow(tool: string, id: string, bytes: number, ageDays: number): string {
  const dir = join(dataDir, 'shadow', tool);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.gz`);
  writeFileSync(path, Buffer.alloc(bytes, 1));
  const when = new Date(NOW - ageDays * DAY);
  utimesSync(path, when, when);
  return path;
}

const ALL_ACKED = () => true;
const NONE_ACKED = () => false;

describe('nothing unacked is ever deleted', () => {
  // THE SAFETY PROPERTY. An unacked shadow may be the only copy of records the
  // server has never seen.
  test('an ancient, enormous, UNACKED shadow survives untouched', () => {
    const p = shadow('claude', 'unacked', 4 * 1024 * 1024, 9999);
    const r = mod.pruneShadow({
      isFullyAcked: NONE_ACKED, now: NOW,
      maxAgeMs: DAY, maxTotalBytes: 1,
    });
    expect(existsSync(p)).toBe(true);
    expect(r.deleted).toBe(0);
    expect(r.keptUnacked).toBe(1);
  });

  test('a predicate that THROWS means keep, never delete', () => {
    const p = shadow('claude', 'boom', 1024, 9999);
    const r = mod.pruneShadow({
      isFullyAcked: () => { throw new Error('ledger unreadable'); },
      now: NOW, maxAgeMs: DAY, maxTotalBytes: 1,
    });
    expect(existsSync(p)).toBe(true);
    expect(r.deleted).toBe(0);
  });

  test('acked and unacked side by side: only the acked one goes', () => {
    const keep = shadow('claude', 'keep-me', 1024, 200);
    const drop = shadow('claude', 'drop-me', 1024, 200);
    mod.pruneShadow({
      isFullyAcked: (_t, id) => id === 'drop-me',
      now: NOW, maxAgeMs: 90 * DAY,
    });
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(drop)).toBe(false);
  });
});

describe('age limit', () => {
  test('older than the limit goes, younger stays', () => {
    const old = shadow('claude', 'old', 1024, 120);
    const fresh = shadow('claude', 'fresh', 1024, 10);
    const r = mod.pruneShadow({ isFullyAcked: ALL_ACKED, now: NOW, maxAgeMs: 90 * DAY });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(r.deleted).toBe(1);
    expect(r.freedBytes).toBe(1024);
  });

  test('the default is 90 days', () => {
    expect(mod.DEFAULT_MAX_AGE_MS).toBe(90 * DAY);
  });
});

describe('size ceiling', () => {
  test('trims oldest-first until under the ceiling, and no further', () => {
    shadow('claude', 'a-oldest', 1000, 30);
    shadow('claude', 'b-middle', 1000, 20);
    const newest = shadow('claude', 'c-newest', 1000, 10);
    // 3000 bytes present, ceiling 1500 → the two oldest must go, the newest stays.
    const r = mod.pruneShadow({
      isFullyAcked: ALL_ACKED, now: NOW,
      maxAgeMs: 90 * DAY, maxTotalBytes: 1500,
    });
    expect(r.deleted).toBe(2);
    expect(existsSync(newest)).toBe(true);
    expect(r.remainingBytes).toBeLessThanOrEqual(1500);
  });

  test('under the ceiling and young: nothing is touched', () => {
    shadow('claude', 'a', 100, 1);
    shadow('gemini', 'b', 100, 1);
    const r = mod.pruneShadow({
      isFullyAcked: ALL_ACKED, now: NOW,
      maxAgeMs: 90 * DAY, maxTotalBytes: 10_000,
    });
    expect(r.deleted).toBe(0);
    expect(r.scanned).toBe(2);
  });

  // The ceiling must not be satisfiable only by deleting unacked data.
  test('it stops at the ceiling rather than deleting unacked data to reach it', () => {
    shadow('claude', 'acked-old', 1000, 50);
    const unacked = shadow('claude', 'unacked-old', 5000, 60);
    const r = mod.pruneShadow({
      isFullyAcked: (_t, id) => id === 'acked-old',
      now: NOW, maxAgeMs: 90 * DAY, maxTotalBytes: 100,
    });
    expect(existsSync(unacked)).toBe(true);
    expect(r.deleted).toBe(1);
    expect(r.remainingBytes).toBeGreaterThan(100);   // cannot get under it, correctly
  });
});

describe('operational safety', () => {
  test('every tool directory is walked', () => {
    shadow('claude', 'x', 100, 999);
    shadow('gemini', 'y', 100, 999);
    shadow('opencode', 'z', 100, 999);
    const r = mod.pruneShadow({ isFullyAcked: ALL_ACKED, now: NOW, maxAgeMs: DAY });
    expect(r.scanned).toBe(3);
    expect(r.deleted).toBe(3);
  });

  test('dryRun reports the same decisions without deleting anything', () => {
    const p = shadow('claude', 'x', 1024, 999);
    const r = mod.pruneShadow({ isFullyAcked: ALL_ACKED, now: NOW, maxAgeMs: DAY, dryRun: true });
    expect(r.deleted).toBe(1);
    expect(r.freedBytes).toBe(1024);
    expect(existsSync(p)).toBe(true);
  });

  test('non-.gz files are ignored, not deleted', () => {
    const dir = join(dataDir, 'shadow', 'claude');
    mkdirSync(dir, { recursive: true });
    const readme = join(dir, 'README.txt');
    writeFileSync(readme, 'not a shadow');
    shadow('claude', 'real', 100, 999);
    const r = mod.pruneShadow({ isFullyAcked: ALL_ACKED, now: NOW, maxAgeMs: DAY });
    expect(r.scanned).toBe(1);
    expect(existsSync(readme)).toBe(true);
  });

  test('a missing shadow root is not an error', () => {
    rmSync(join(dataDir, 'shadow'), { recursive: true, force: true });
    const r = mod.pruneShadow({ isFullyAcked: ALL_ACKED, now: NOW });
    expect(r).toEqual({ scanned: 0, deleted: 0, freedBytes: 0, keptUnacked: 0, remainingBytes: 0 });
  });

  test('the tool directory itself survives a full prune', () => {
    shadow('claude', 'x', 100, 999);
    mod.pruneShadow({ isFullyAcked: ALL_ACKED, now: NOW, maxAgeMs: DAY });
    expect(readdirSync(join(dataDir, 'shadow', 'claude'))).toEqual([]);
  });
});
