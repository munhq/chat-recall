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
import { judgeHealth, STALE_AFTER_MS, CRASHLOOP_RESTARTS, type CollectorHealth } from './collector-health.js';

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
    expect(v.summary).toContain('restarted');
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
    expect(v.summary).toContain('restarted 12 times');
    expect(v.summary).toContain('never');
  });
});
