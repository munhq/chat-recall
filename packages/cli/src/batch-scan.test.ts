/**
 * batchScanExternal keeps pre-redaction text on disk BOUNDED.
 *
 * The external detectors need their input as files, and that input is raw
 * session text — real credentials in cleartext. The previous implementation
 * wrote every session into one dir and relied on a `finally` to clean up; a
 * SIGKILL/OOM mid-scan skips that, and one such dir was found holding 3.4GB
 * across 309k files in /tmp. So the contract under test is:
 *
 *   - at no moment does the batch dir hold more than maxBytes
 *   - every session still gets scanned (slicing must not drop work)
 *   - findings map back to the right session
 *   - the dir is gone afterwards, including when the scan throws
 */
import { describe, test, expect } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchScanExternal } from './sync-client.js';

/** Bytes currently materialized in a batch dir. */
function dirBytes(dir: string): number {
  return readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
}

function items(n: number, bytesEach: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `sess-${i}`,
    text: () => 'x'.repeat(bytesEach),
  }));
}

/** Names of batch dirs currently in the OS temp dir (leak detector). */
function batchDirs(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith('cr-batchscan-'));
}

describe('batchScanExternal — bounded materialization', () => {
  test('never exceeds maxBytes on disk, and scans every session', () => {
    const seen: number[] = [];
    const dirsSeen: string[] = [];
    const res = batchScanExternal(items(10, 1000), {
      maxBytes: 2500, // ⇒ flushes after every 3rd file (3000 ≥ 2500)
      scan: (dir) => {
        seen.push(dirBytes(dir));
        dirsSeen.push(dir);
        return [];
      },
    });

    // Every observed slice respected the cap. The cap is checked AFTER a write,
    // so a slice may reach cap + one file — that overshoot is bounded by one
    // session, which is the point (a single oversized session still gets
    // scanned rather than being silently skipped).
    expect(Math.max(...seen)).toBeLessThanOrEqual(2500 + 1000);
    expect(res.slices).toBe(4);            // 3+3+3+1
    expect(res.scanned).toBe(10);          // nothing dropped
    // Each slice used a FRESH dir, and none of them survive.
    expect(new Set(dirsSeen).size).toBe(4);
    for (const d of dirsSeen) expect(existsSync(d)).toBe(false);
  });

  test('one session larger than the cap is still scanned, alone', () => {
    const sizes: number[] = [];
    const res = batchScanExternal(
      [{ id: 'huge', text: () => 'y'.repeat(5000) }, { id: 'small', text: () => 'z'.repeat(10) }],
      { maxBytes: 1000, scan: (dir) => { sizes.push(dirBytes(dir)); return []; } },
    );
    expect(sizes).toEqual([5000, 10]);     // huge flushed on its own, then small
    expect(res.scanned).toBe(2);
  });

  test('findings map back to the session they came from', () => {
    const res = batchScanExternal(items(4, 10), {
      maxBytes: 25, // 10-byte files ⇒ flush at the 3rd (30 ≥ 25): slices of 3 + 1
      scan: (dir) => readdirSync(dir).map((f) => ({
        detector: 'gitleaks', rule: 'aws-access-token', line: 7,
        preview: '****MPLE', file: join(dir, f),
      })),
    });
    expect([...res.findings.keys()].sort()).toEqual(['sess-0', 'sess-1', 'sess-2', 'sess-3']);
    expect(res.findings.get('sess-2')).toEqual([
      { detector: 'gitleaks', rule: 'aws-access-token', line: 7, preview: '****MPLE', verified: undefined },
    ]);
  });

  test('unexportable sessions (text() === null) are skipped, not fatal', () => {
    const res = batchScanExternal(
      [
        { id: 'ok-1', text: () => 'data' },
        { id: 'gone', text: () => null },
        { id: 'throws', text: () => { throw new Error('unreadable transcript'); } },
        { id: 'ok-2', text: () => 'data' },
      ],
      { maxBytes: 1 << 20, scan: (dir) => readdirSync(dir).map((f) => ({
        detector: 'trufflehog', rule: 'AWS', line: 1, preview: '****key0', file: f,
      })) },
    );
    expect([...res.findings.keys()].sort()).toEqual(['ok-1', 'ok-2']);
    expect(res.scanned).toBe(2);
  });

  test('a throwing detector leaves no batch dir behind', () => {
    const before = batchDirs();
    expect(() => batchScanExternal(items(2, 10), {
      maxBytes: 1 << 20,
      scan: () => { throw new Error('detector exploded'); },
    })).toThrow('detector exploded');
    // No new cr-batchscan-* dir survived the throw.
    expect(batchDirs().filter((d) => !before.includes(d))).toEqual([]);
  });

  test('empty input does nothing at all', () => {
    const before = batchDirs();
    const res = batchScanExternal([], { scan: () => { throw new Error('must not scan'); } });
    expect(res).toMatchObject({ scanned: 0, slices: 0 });
    expect(res.findings.size).toBe(0);
    expect(batchDirs().filter((d) => !before.includes(d))).toEqual([]);
  });
});
