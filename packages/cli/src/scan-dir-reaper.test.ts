/**
 * Batch-scan temp dirs must not survive a killed process.
 *
 * The scan cleans up in a `finally`, which SIGKILL / the OOM killer skip — and
 * this is the loop that has OOM-killed the daemon before. One leaked dir was
 * found holding 3.4GB across 309k files; with other cruft it filled a 31GB
 * tmpfs and broke everything on the machine that needed /tmp.
 *
 * The reaper must be conservative in the other direction too: a dir that a
 * CONCURRENT scan is still writing to must never be deleted, which is why the
 * age cutoff exists.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapStaleScanDirs } from './sync-client.js';

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cr-reaper-test-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A scan dir whose mtime is `ageMs` in the past. */
function scanDir(name: string, ageMs: number): string {
  const p = join(root, name);
  mkdirSync(p);
  writeFileSync(join(p, 'session.txt'), 'x');
  const t = new Date(Date.now() - ageMs);
  utimesSync(p, t, t);
  return p;
}

describe('reapStaleScanDirs', () => {
  test('deletes a leaked scan dir left by a killed run', () => {
    const stale = scanDir('cr-batchscan-abc123', 24 * 3600_000);
    expect(reapStaleScanDirs(root)).toBe(1);
    expect(existsSync(stale)).toBe(false);
  });

  test('leaves a fresh dir alone — a concurrent scan may still be writing it', () => {
    const fresh = scanDir('cr-batchscan-inflight', 60_000);
    expect(reapStaleScanDirs(root)).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  test('never touches anything that is not ours', () => {
    const other = scanDir('someone-elses-tmpdir', 24 * 3600_000);
    const prefixish = scanDir('cr-scan-not-batch', 24 * 3600_000);
    expect(reapStaleScanDirs(root)).toBe(0);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(prefixish)).toBe(true);
  });

  test('reaps every stale dir, not just the first', () => {
    scanDir('cr-batchscan-1', 12 * 3600_000);
    scanDir('cr-batchscan-2', 12 * 3600_000);
    const fresh = scanDir('cr-batchscan-3', 1000);
    expect(reapStaleScanDirs(root)).toBe(2);
    expect(existsSync(fresh)).toBe(true);
  });

  test('an unreadable directory is a no-op, not a throw', () => {
    expect(reapStaleScanDirs(join(root, 'does-not-exist'))).toBe(0);
  });
});
