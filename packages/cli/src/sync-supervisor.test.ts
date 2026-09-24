import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncSupervisor, type SyncScope } from './sync-supervisor.js';

const INTERVAL = 180_000;
const FIRST = 15_000;

function harness(initial: boolean) {
  let running = initial;
  const ticks: SyncScope[] = [];
  const logs: string[] = [];
  const onFirstTakeover = vi.fn();
  const sup = createSyncSupervisor({
    serviceRunning: () => running,
    tick: async (scope) => { ticks.push(scope); },
    intervalMs: INTERVAL,
    firstCheckMs: FIRST,
    onFirstTakeover,
    log: (m) => logs.push(m),
  });
  return {
    sup, ticks, logs, onFirstTakeover,
    setRunning: (v: boolean) => { running = v; },
  };
}

describe('background sync supervisor', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stands by while the watch service runs', async () => {
    const h = harness(true);
    await vi.advanceTimersByTimeAsync(FIRST + 5 * INTERVAL);
    expect(h.ticks).toEqual([]);
    expect(h.sup.owner()).toBe('service');
    expect(h.onFirstTakeover).not.toHaveBeenCalled();
    h.sup.stop();
  });

  it('takes over with a full walk when the service stops after startup', async () => {
    // The 2026-09-16 case: the service ran when the MCP daemon started, then stopped.
    const h = harness(true);
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(h.sup.owner()).toBe('service');

    h.setRunning(false);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(h.sup.owner()).toBe('mcp');
    expect(h.ticks).toEqual(['full']);
    expect(h.logs.at(-1)).toMatch(/no longer running.*takes over/);
    expect(h.onFirstTakeover).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    expect(h.ticks).toEqual(['full', 'changed', 'changed']);
    h.sup.stop();
  });

  it('stands by again when the service comes back', async () => {
    const h = harness(false);
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(h.ticks).toEqual(['full']);

    h.setRunning(true);
    await vi.advanceTimersByTimeAsync(3 * INTERVAL);
    expect(h.ticks).toEqual(['full']);
    expect(h.sup.owner()).toBe('service');
    expect(h.logs.at(-1)).toMatch(/running again/);

    // And back once more: a fresh full walk, and the one-time hook stays one-time.
    h.setRunning(false);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(h.ticks).toEqual(['full', 'full']);
    expect(h.onFirstTakeover).toHaveBeenCalledTimes(1);
    h.sup.stop();
  });

  it('syncs from the first check when no service is installed', async () => {
    const h = harness(false);
    await vi.advanceTimersByTimeAsync(FIRST - 1);
    expect(h.ticks).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.ticks).toEqual(['full']);
    h.sup.stop();
  });

  it('treats a service check that throws as "not running"', async () => {
    const ticks: SyncScope[] = [];
    const sup = createSyncSupervisor({
      serviceRunning: () => { throw new Error('systemctl missing'); },
      tick: async (s) => { ticks.push(s); },
      intervalMs: INTERVAL,
      firstCheckMs: FIRST,
    });
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(ticks).toEqual(['full']);
    sup.stop();
  });

  it('never starts a second pass while one is still running', async () => {
    let release!: () => void;
    let started = 0;
    const sup = createSyncSupervisor({
      serviceRunning: () => false,
      tick: () => { started += 1; return new Promise<void>((r) => { release = r; }); },
      intervalMs: INTERVAL,
      firstCheckMs: FIRST,
    });
    await vi.advanceTimersByTimeAsync(FIRST + 3 * INTERVAL);
    expect(started).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(started).toBe(2);
    sup.stop();
  });

  it('keeps supervising after a pass rejects', async () => {
    let n = 0;
    const sup = createSyncSupervisor({
      serviceRunning: () => false,
      tick: async () => { n += 1; throw new Error('server down'); },
      intervalMs: INTERVAL,
      firstCheckMs: FIRST,
    });
    await vi.advanceTimersByTimeAsync(FIRST + 2 * INTERVAL);
    expect(n).toBe(3);
    sup.stop();
  });
});
