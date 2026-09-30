/**
 * An update must never restart the service from inside a daemon that is
 * stopping.
 *
 * On 2026-09-30 another process installed 0.7.10 and restarted the watch
 * service. The daemon's in-flight sync then finished and started its own
 * update, which ran a blocking `systemctl --user restart` against the unit
 * that was stopping it. The wait blocked the event loop, the 500 ms exit timer
 * never fired, systemd killed the daemon at TimeoutStopSec (90 s), and the next
 * start counted a crash.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

const bytes = Buffer.from('tarball');
const realFetch = globalThis.fetch;

function serverOffers(version: string): void {
  globalThis.fetch = (async () => ({
    ok: true, status: 200,
    json: async () => ({ edition: 'cloud', cli: { version, sha256: createHash('sha256').update(bytes).digest('hex') } }),
  })) as unknown as typeof fetch;
}

function recorder(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const deps = {
    download: async () => { calls.push('download'); return bytes; },
    install: () => { calls.push('install'); },
    restart: () => { calls.push('restart'); },
    verify: () => '99.0.0',
    onDisk: () => '0.7.9',
    acquireLock: () => ({ release: () => { calls.push('release'); } }),
    ...overrides,
  };
  return { calls, deps };
}

afterEach(() => { globalThis.fetch = realFetch; vi.resetModules(); });

describe('runAutoUpdate and shutdown', () => {
  test('THE FAILURE: nothing is installed or restarted once shutdown began', async () => {
    const { runAutoUpdate, STOPPING_REASON } = await import('./auto-update.js');
    serverOffers('99.0.0');
    const { calls, deps } = recorder({ stopping: () => true });
    const r = await runAutoUpdate('https://recall.example.com', {}, '0.7.9', deps);
    expect(r).toEqual({ updated: false, reason: STOPPING_REASON });
    expect(calls).toEqual([]);
  });

  test('shutdown during the download installs nothing and releases the lock', async () => {
    const { runAutoUpdate, STOPPING_REASON } = await import('./auto-update.js');
    serverOffers('99.0.0');
    let stop = false;
    const { calls, deps } = recorder({
      stopping: () => stop,
      download: async () => { calls.push('download'); stop = true; return bytes; },
    });
    const r = await runAutoUpdate('https://recall.example.com', {}, '0.7.9', deps);
    expect(r.reason).toBe(STOPPING_REASON);
    expect(calls).toEqual(['download', 'release']);
  });

  test('stopAutoUpdates stops the default path', async () => {
    const { runAutoUpdate, stopAutoUpdates, STOPPING_REASON } = await import('./auto-update.js');
    serverOffers('99.0.0');
    stopAutoUpdates();
    const { calls, deps } = recorder();
    const r = await runAutoUpdate('https://recall.example.com', {}, '0.7.9', deps);
    expect(r.reason).toBe(STOPPING_REASON);
    expect(calls).toEqual([]);
  });
});

describe('runAutoUpdate across processes', () => {
  test('a second process does not install while another holds the lock', async () => {
    const { runAutoUpdate, LOCKED_REASON } = await import('./auto-update.js');
    serverOffers('99.0.0');
    const { calls, deps } = recorder({ acquireLock: () => null });
    const r = await runAutoUpdate('https://recall.example.com', {}, '0.7.9', deps);
    expect(r.reason).toBe(LOCKED_REASON);
    expect(calls).toEqual([]);
  });

  test('a release another process installed while this one waited is not installed again', async () => {
    const { runAutoUpdate } = await import('./auto-update.js');
    serverOffers('99.0.0');
    // Once the lock is held, the disk already has the release.
    const { calls, deps } = recorder({ onDisk: () => '99.0.0' });
    const r = await runAutoUpdate('https://recall.example.com', {}, '0.7.9', deps);
    expect(r.updated).toBe(false);
    expect(r.reason).toMatch(/already current: 99\.0\.0 is on disk/);
    expect(calls).toEqual(['release']);
  });

  test('a normal update installs, restarts and releases the lock', async () => {
    const { runAutoUpdate } = await import('./auto-update.js');
    serverOffers('99.0.0');
    const { calls, deps } = recorder();
    const r = await runAutoUpdate('https://recall.example.com', {}, '0.7.9', deps);
    expect(r.updated).toBe(true);
    expect(calls).toEqual(['download', 'install', 'restart', 'release']);
  });
});

describe('restartCommand', () => {
  test('Linux queues the restart and returns at once', async () => {
    const { restartCommand } = await import('./auto-update.js');
    expect(restartCommand('linux')?.cmd).toBe('systemctl --user --no-block restart chat-recall-watch.service');
    expect(restartCommand('aix')).toBeNull();
  });
});
