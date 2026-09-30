/**
 * The collector must say when it cannot ship.
 *
 * It crash-looped for eight days — 4,851 heap aborts, roughly one every 105
 * seconds — and told nobody: systemd restarted it silently, the aborts went to
 * a log nobody tails, and every health check the product had was green. These
 * tests pin the three conditions worth interrupting a user for, and — just as
 * important — that a healthy collector stays silent. A warning that cries wolf
 * gets ignored, and then the real outage is invisible again.
 */
import { describe, test, expect } from 'vitest';
import { judgeHealth, STALE_AFTER_MS, CRASHLOOP_RESTARTS, updateCollectorHealth, readCollectorHealth, crashesAtBoot, recentCrashes, progressLine, firstSyncInProgress, type CollectorHealth } from './collector-health.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = 1_700_000_000_000;
const mins = (n: number) => n * 60_000;

const healthy = (over: Partial<CollectorHealth> = {}): CollectorHealth => ({
  v: 1,
  updatedAt: NOW - mins(1),
  startedAt: NOW - mins(120),
  restartsLastHour: 1,
  targets: { 'https://chatrecall.dev': { lastOkAt: NOW - mins(2), failures: 0 } },
  ...over,
});

describe('judging collector health', () => {
  test('a working collector says nothing at all', () => {
    const v = judgeHealth(healthy(), NOW);
    expect(v.ok).toBe(true);
    expect(v.summary).toBeNull();
  });

  test('no report is not a failure — it may simply never have run', () => {
    // Treating "absent" as "broken" would put a warning on every fresh install
    // and on every CLI-only user who never starts the daemon.
    expect(judgeHealth(null, NOW).ok).toBe(true);
  });

  test('a daemon that stopped reporting is called out', () => {
    const v = judgeHealth(healthy({ updatedAt: NOW - STALE_AFTER_MS - mins(5) }), NOW);
    expect(v.ok).toBe(false);
    expect(v.summary).toContain('not reported');
  });

  test('a crash loop is called out even while a sync still succeeds', () => {
    // This is exactly what happened: the daemon kept restarting, and each fresh
    // process still managed some work, so every point-in-time check looked fine.
    const v = judgeHealth(healthy({ restartsLastHour: CRASHLOOP_RESTARTS }), NOW);
    expect(v.ok).toBe(false);
    expect(v.summary).toContain('crashed');
  });

  test('nothing reaching any server is called out, with the reason', () => {
    const v = judgeHealth(healthy({
      targets: {
        'https://chatrecall.dev': { lastOkAt: NOW - mins(90), failures: 4, lastError: 'fetch failed' },
        'http://192.168.1.10:8085': { lastOkAt: null, failures: 9 },
      },
    }), NOW);
    expect(v.ok).toBe(false);
    expect(v.summary).toContain('nothing has synced');
    expect(v.summary).toContain('fetch failed');
  });

  test('one healthy target is enough — a dead LAN box is not an outage', () => {
    // A laptop that syncs to the cloud and to a home server should not warn
    // every time it leaves the house.
    const v = judgeHealth(healthy({
      targets: {
        'https://chatrecall.dev': { lastOkAt: NOW - mins(2), failures: 0 },
        'http://192.168.1.10:8085': { lastOkAt: null, failures: 40 },
      },
    }), NOW);
    expect(v.ok).toBe(true);
  });

  test('a tenant with no targets configured is not an outage', () => {
    expect(judgeHealth(healthy({ targets: {} }), NOW).ok).toBe(true);
  });

  test('every reason is reported at once, not just the first', () => {
    const v = judgeHealth({
      v: 1,
      updatedAt: NOW - STALE_AFTER_MS - mins(1),
      startedAt: NOW - mins(3),
      restartsLastHour: 12,
      targets: { 'https://chatrecall.dev': { lastOkAt: null, failures: 30 } },
    }, NOW);
    expect(v.reasons).toHaveLength(3);
    expect(v.summary).toContain('not reported');
    expect(v.summary).toContain('crashed 12 times');
    expect(v.summary).toContain('never');
  });
});

/**
 * Only a crash counts toward the crash loop.
 *
 * Every start used to count, so a boot, an upgrade and the self-restart onto
 * the new bundle — three starts in a few minutes of ordinary use — printed
 * "not syncing: it restarted 3 times" over a sync that was current.
 */
describe('counting crashes at boot', () => {
  const prior = (over: Partial<CollectorHealth> = {}): CollectorHealth => healthy({ startedAt: NOW - mins(10), ...over });

  test('the first start on a machine is not a crash', () => {
    expect(crashesAtBoot(null, NOW)).toEqual([]);
  });

  test('a start after a clean exit is not a crash', () => {
    expect(crashesAtBoot(prior({ cleanExitAt: NOW - mins(1) }), NOW)).toEqual([]);
  });

  test('a start after a process that left no clean exit is a crash', () => {
    expect(crashesAtBoot(prior(), NOW)).toEqual([NOW]);
  });

  test('a clean exit from an EARLIER process does not cover a later one that crashed', () => {
    // The mark is older than the prior process's own start, so it belongs to
    // the process before that one.
    expect(crashesAtBoot(prior({ cleanExitAt: NOW - mins(20) }), NOW)).toEqual([NOW]);
  });

  test('the history carries over, and a clean start adds nothing to it', () => {
    const history = [NOW - mins(30), NOW - mins(20)];
    expect(crashesAtBoot(prior({ crashes: history, cleanExitAt: NOW - mins(1) }), NOW)).toEqual(history);
    expect(crashesAtBoot(prior({ crashes: history }), NOW)).toEqual([...history, NOW]);
  });

  test('three clean restarts in an hour stay silent; three crashes do not', () => {
    let h: CollectorHealth | null = null;
    for (let i = 0; i < 3; i++) {
      const start = NOW - mins(30 - i * 10);
      const crashes = recentCrashes(crashesAtBoot(h, start), start);
      h = healthy({ startedAt: start, crashes, restartsLastHour: crashes.length, cleanExitAt: start + mins(5) });
    }
    expect(judgeHealth(h, NOW).ok).toBe(true);

    let c: CollectorHealth | null = healthy({ startedAt: NOW - mins(40) });
    for (let i = 0; i < 3; i++) {
      const start = NOW - mins(30 - i * 10);
      const crashes = recentCrashes(crashesAtBoot(c, start), start);
      c = healthy({ startedAt: start, crashes, restartsLastHour: crashes.length });
    }
    expect(judgeHealth(c, NOW).summary).toContain('crashed 3 times');
  });

  test('crashes older than an hour fall out of the count', () => {
    expect(recentCrashes([NOW - mins(90), NOW - mins(5), NOW - mins(5)], NOW)).toEqual([NOW - mins(5)]);
  });
});

/**
 * A write must not erase what it does not mention.
 *
 * updateCollectorHealth re-listed the fields it meant to keep, and the two it
 * did not name were dropped on every write. telemetryEligible is the one that
 * matters: it is set from a sync response and is the only thing that makes
 * mayReport() true, so losing it makes flush() drop the queue. The daemon
 * writes this file every couple of seconds during a walk, so the flag survived
 * seconds and telemetry escaped only right after a sync.
 */
describe('updateCollectorHealth preserves fields it does not know about', () => {
  test('telemetryEligible and crashes survive an unrelated write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-health-'));
    const prevDir = process.env.CHAT_RECALL_DATA_DIR;
    process.env.CHAT_RECALL_DATA_DIR = dir;
    try {
      updateCollectorHealth({
        telemetryEligible: { 'https://example.invalid': { allowed: true, at: 1 } },
        crashes: [1, 2, 3],
      } as Partial<CollectorHealth>);
      // A progress tick, which is what the daemon writes constantly.
      updateCollectorHealth({ progress: { done: 1, total: 2 } } as Partial<CollectorHealth>);

      const after = readCollectorHealth();
      expect(after?.telemetryEligible?.['https://example.invalid']?.allowed).toBe(true);
      expect(after?.crashes).toEqual([1, 2, 3]);
      expect(after?.progress).toBeTruthy();
    } finally {
      if (prevDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
      else process.env.CHAT_RECALL_DATA_DIR = prevDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('progressLine and firstSyncInProgress', () => {
  const health = (progress: Record<string, unknown> | undefined) =>
    ({ v: 1, updatedAt: 0, startedAt: 0, restartsLastHour: 0, targets: {}, progress }) as never;

  test('THE FAILURE: an incremental walk is not called a first sync', () => {
    const h = health({ done: 3, total: 4, startedAt: 0, complete: false });
    expect(firstSyncInProgress(h)).toBe(false);
    expect(progressLine(h)).toBe('sync in progress — 3 of 4 sessions (75%)');
  });

  test('a first sync in flight is named and flagged', () => {
    const h = health({ done: 2667, total: 10657, startedAt: 0, complete: false, first: true });
    expect(firstSyncInProgress(h)).toBe(true);
    expect(progressLine(h)).toBe('first sync in progress — 2,667 of 10,657 sessions (25%)');
  });

  test('a finished or empty walk says nothing', () => {
    expect(firstSyncInProgress(health({ done: 4, total: 4, startedAt: 0, complete: true, first: true }))).toBe(false);
    expect(progressLine(health({ done: 0, total: 0, startedAt: 0, complete: false, first: true }))).toBeNull();
    expect(progressLine(health(undefined))).toBeNull();
  });
});
