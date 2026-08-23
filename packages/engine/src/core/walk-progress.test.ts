/**
 * Progress reporting exists because "is it broken or just slow?" had no answer.
 *
 * A first sync on a large corpus runs for a long time, and the only evidence it
 * was working was one log line per 250 sessions written to a file nobody tails.
 * These tests pin the three properties that make the report trustworthy: it
 * merges rather than clobbers, it stops talking once the walk is done, and the
 * first and last reports always land.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prev: string | undefined;
let mod: typeof import('./collector-health.js');

beforeEach(async () => {
  prev = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-progress-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  // Import AFTER the env override so paths resolve into the temp dir, and reset
  // the module registry first so the write throttle (module state) does not leak
  // between tests.
  vi.resetModules();
  mod = await import('./collector-health.js');
});

afterEach(() => {
  if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('progressLine', () => {
  test('a walk in flight reads as a percentage a human can act on', () => {
    const line = mod.progressLine({
      v: 1, updatedAt: 1, startedAt: 1, restartsLastHour: 0, targets: {},
      progress: { done: 8400, total: 15724, startedAt: 1, complete: false },
    });
    expect(line).toContain('8,400');
    expect(line).toContain('15,724');
    expect(line).toContain('53%');
  });

  // Silence on a finished walk is the point: a progress line on every command
  // would be noise, and noise is how the staleness WARNING gets ignored.
  test('a finished walk says nothing', () => {
    expect(mod.progressLine({
      v: 1, updatedAt: 1, startedAt: 1, restartsLastHour: 0, targets: {},
      progress: { done: 15724, total: 15724, startedAt: 1, complete: true },
    })).toBeNull();
  });

  test('no report and an empty walk both say nothing', () => {
    expect(mod.progressLine(null)).toBeNull();
    expect(mod.progressLine({ v: 1, updatedAt: 1, startedAt: 1, restartsLastHour: 0, targets: {} })).toBeNull();
    expect(mod.progressLine({
      v: 1, updatedAt: 1, startedAt: 1, restartsLastHour: 0, targets: {},
      progress: { done: 0, total: 0, startedAt: 1, complete: false },
    })).toBeNull();
  });

  // Never claim 100% while still walking — a reader seeing 100% assumes it can
  // stop waiting.
  test('an in-flight walk never reads as 100%', () => {
    const line = mod.progressLine({
      v: 1, updatedAt: 1, startedAt: 1, restartsLastHour: 0, targets: {},
      progress: { done: 15723, total: 15724, startedAt: 1, complete: false },
    });
    expect(line).toContain('99%');
  });
});

describe('the two writers share one file', () => {
  // THE REGRESSION THIS PREVENTS: the daemon's heartbeat rewrote this file every
  // 60 seconds. A plain write erases whatever the sync walk had put in
  // `progress`, so the UI and doctor would blink between showing progress and
  // showing nothing.
  test('a heartbeat update preserves walk progress', () => {
    mod.reportWalkProgress({ done: 100, total: 1000, startedAt: 5, complete: false });
    mod.updateCollectorHealth({ targets: { 'https://x.test': { lastOkAt: 42, failures: 0 } } });

    const h = mod.readCollectorHealth();
    expect(h?.progress?.done).toBe(100);
    expect(h?.targets['https://x.test'].lastOkAt).toBe(42);
  });

  test('a progress update preserves target health', () => {
    mod.updateCollectorHealth({ targets: { 'https://y.test': { lastOkAt: 7, failures: 3, lastError: 'boom' } } });
    mod.reportWalkProgress({ done: 0, total: 500, startedAt: 9, complete: false });

    const h = mod.readCollectorHealth();
    expect(h?.targets['https://y.test'].failures).toBe(3);
    expect(h?.progress?.total).toBe(500);
  });

  // The throttle must never swallow the boundaries — "it started" and "it
  // finished" are the two reports a reader actually needs.
  test('the first and last reports always land, however fast they follow', () => {
    mod.reportWalkProgress({ done: 0, total: 900, startedAt: 1, complete: false });
    expect(mod.readCollectorHealth()?.progress?.done).toBe(0);

    // Throttled away — too soon after the first, and not a boundary.
    mod.reportWalkProgress({ done: 250, total: 900, startedAt: 1, complete: false });
    expect(mod.readCollectorHealth()?.progress?.done).toBe(0);

    // Completion is a boundary, so it lands regardless of the throttle.
    mod.reportWalkProgress({ done: 900, total: 900, startedAt: 1, complete: true });
    const h = mod.readCollectorHealth();
    expect(h?.progress?.complete).toBe(true);
    expect(h?.progress?.done).toBe(900);
  });
});
