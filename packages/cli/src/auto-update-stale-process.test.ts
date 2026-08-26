/**
 * A LONG-LIVED PROCESS MUST NOT REINSTALL THE SAME VERSION FOREVER.
 *
 * Observed in the field, on the maintainer's own machine, for hours: seven MCP
 * servers that had been running since before a release were reinstalling the CLI
 * and restarting the watch daemon every 2-3 seconds, indefinitely. systemd
 * recorded `restart/replace` jobs on a loop; the installed package.json mtime
 * moved every few seconds.
 *
 * The mechanism is small and entirely mechanical. Callers pass the version their
 * MODULE read at import time. A process alive since before an update therefore
 * reports the old number forever, while the package it was launched from has
 * already been replaced on disk. So it asks the server, is told a newer version
 * exists, installs a version that is already installed, restarts the daemon —
 * and nothing about the running process changes, so it does it all again on the
 * next tick.
 *
 * The fix is to re-read the manifest at decision time and let the DISK win. The
 * stale process keeps running old code until something restarts it, which is
 * correct and harmless. What must not happen is it thrashing the machine trying
 * to fix itself.
 */
import { describe, test, expect } from 'vitest';
import { planAutoUpdate, newerOf, compareVersions, type Caps } from './auto-update.js';

const caps = (version: string): Caps => ({ edition: 'cloud', cli: { version, sha256: 'a'.repeat(64) } });

describe('newerOf', () => {
  test('takes the higher version', () => {
    expect(newerOf('0.5.16', '0.5.18')).toBe('0.5.18');
    expect(newerOf('0.5.18', '0.5.16')).toBe('0.5.18');
    expect(newerOf('0.5.18', '0.5.18')).toBe('0.5.18');
  });

  test('falls back to the caller value when the disk cannot be read', () => {
    // installedVersion() returns null on an unreadable manifest. Inventing a
    // version there would either suppress a real update or force a false one.
    expect(newerOf('0.5.16', null)).toBe('0.5.16');
  });

  test('survives an unparseable version rather than throwing', () => {
    expect(newerOf('', '0.5.18')).toBe('0.5.18');
    expect(() => newerOf('not-a-version', '0.5.18')).not.toThrow();
  });
});

describe('the stale-process reinstall loop', () => {
  test('THE BUG: a stale in-memory version asks for a version already on disk', () => {
    // What every caller did before the fix — pass the number captured at import.
    const staleInMemory = '0.5.16';
    const plan = planAutoUpdate('https://example.com', caps('0.5.18'), staleInMemory, undefined);
    expect(plan.update).toBe(true);   // installs 0.5.18 …
    // … and because the running process still says 0.5.16, the next tick plans
    // exactly the same install. Forever.
    const again = planAutoUpdate('https://example.com', caps('0.5.18'), staleInMemory, undefined);
    expect(again.update).toBe(true);
  });

  test('THE FIX: the on-disk version ends the loop after one install', () => {
    const staleInMemory = '0.5.16';
    const onDisk = '0.5.18';           // what npm wrote during the first pass
    const effective = newerOf(staleInMemory, onDisk);
    const plan = planAutoUpdate('https://example.com', caps('0.5.18'), effective, undefined);
    expect(plan.update).toBe(false);
    expect(plan.reason).toMatch(/already current/);
  });

  test('a genuine update is still allowed through', () => {
    // The fix must not make the updater inert: when the disk really is behind,
    // the install proceeds. Otherwise every customer silently freezes on the
    // version they first installed.
    const effective = newerOf('0.5.18', '0.5.18');
    const plan = planAutoUpdate('https://example.com', caps('0.6.0'), effective, undefined);
    expect(plan.update).toBe(true);
    expect(plan.to).toBe('0.6.0');
  });

  test('a disk AHEAD of both the process and the server still declines', () => {
    // Someone installed a newer build by hand. Downgrading them on a tick would
    // be worse than doing nothing.
    const effective = newerOf('0.5.16', '0.6.1');
    expect(planAutoUpdate('https://example.com', caps('0.6.0'), effective, undefined).update).toBe(false);
  });

  test('compareVersions orders the numbers this hinges on', () => {
    // 0.5.5 vs 0.5.18 is the comparison a string sort gets wrong, and a wrong
    // answer here is what decides whether a machine reinstalls in a loop.
    expect(compareVersions('0.5.18', '0.5.5')).toBe(1);
    expect(compareVersions('0.5.5', '0.5.18')).toBe(-1);
    expect(compareVersions('0.5.18', '0.5.18')).toBe(0);
  });
});
