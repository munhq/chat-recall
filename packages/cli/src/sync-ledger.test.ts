/**
 * sync-ledger JSON watermark — round-trip, per-server isolation, persistence.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
const origDataDir = process.env.CHAT_RECALL_DATA_DIR;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cr-ledger-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});
afterAll(() => {
  if (origDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = origDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('sync-ledger (JSON watermark)', () => {
  test('markSynced → getSyncedMtimes round-trips per server', async () => {
    const { markSynced, getSyncedMtimes } = await import('./sync-ledger.js');
    markSynced('https://a.example', [{ id: 's1', mtime: 1000.7 }, { id: 's2', mtime: 2000 }]);
    markSynced('https://b.example', [{ id: 's1', mtime: 9000 }]);

    const a = getSyncedMtimes('https://a.example');
    expect(a.get('s1')).toBe(1000); // floored
    expect(a.get('s2')).toBe(2000);
    // Per-server isolation: b's s1 is independent of a's s1.
    expect(getSyncedMtimes('https://b.example').get('s1')).toBe(9000);
    // Unknown server → empty.
    expect(getSyncedMtimes('https://c.example').size).toBe(0);
  });

  test('persists across a fresh file read (no in-memory cache)', async () => {
    const { markSynced, getSyncedMtimes, _resetLedgerCacheForTests } = await import('./sync-ledger.js');
    markSynced('https://a.example', [{ id: 's3', mtime: 3000 }]);
    _resetLedgerCacheForTests(); // force re-read from disk
    expect(getSyncedMtimes('https://a.example').get('s3')).toBe(3000);
  });

  test('empty rows is a no-op', async () => {
    const { markSynced } = await import('./sync-ledger.js');
    expect(() => markSynced('https://a.example', [])).not.toThrow();
  });

  test('field coverage: scan-once, no-retry-on-absent, version-bump re-scans', async () => {
    const { markFieldCoverage, fieldNeedsScan, getSyncedRows, _resetLedgerCacheForTests } = await import('./sync-ledger.js');
    const SRV = 'https://fld.example';
    const F = { name: 'tool_title', version: 1, mtimeSensitive: true };

    // Unknown session → needs scan.
    expect(fieldNeedsScan(getSyncedRows(SRV).get('x'), F, 1000)).toBe(true);

    // Present at v1, mtime 1000 → covered (no re-scan).
    markFieldCoverage(SRV, F, [{ id: 'x', present: true, mtime: 1000 }]);
    expect(fieldNeedsScan(getSyncedRows(SRV).get('x'), F, 1000)).toBe(false);

    // Absent at v1 → covered, NOT retried (the no-retry guarantee).
    markFieldCoverage(SRV, F, [{ id: 'y', present: false, mtime: 1000 }]);
    expect(fieldNeedsScan(getSyncedRows(SRV).get('y'), F, 1000)).toBe(false);
    // …unless forced.
    expect(fieldNeedsScan(getSyncedRows(SRV).get('y'), F, 1000, true)).toBe(true);

    // mtime moved past scan mtime → re-scan (mtime-sensitive field).
    expect(fieldNeedsScan(getSyncedRows(SRV).get('x'), F, 2000)).toBe(true);
    // Version bump → re-scan everything (conversations untouched).
    expect(fieldNeedsScan(getSyncedRows(SRV).get('x'), { ...F, version: 2 }, 1000)).toBe(true);

    // Field coverage must NOT disturb conversation {m,v}.
    const { markSynced } = await import('./sync-ledger.js');
    markSynced(SRV, [{ id: 'z', mtime: 5000 }]);
    markFieldCoverage(SRV, F, [{ id: 'z', present: true, mtime: 5000 }]);
    _resetLedgerCacheForTests();
    const z = getSyncedRows(SRV).get('z')!;
    expect(z.m).toBe(5000);
    expect(z.f?.tool_title?.p).toBe(1);
  });

  test('markSynced preserves field coverage (conversation re-sync must not wipe f)', async () => {
    const { markSynced, markFieldCoverage, fieldNeedsScan, getSyncedRows, _resetLedgerCacheForTests } = await import('./sync-ledger.js');
    const SRV = 'https://preserve.example';
    const F = { name: 'tool_title', version: 1, mtimeSensitive: true };
    markFieldCoverage(SRV, F, [{ id: 's1', present: true, mtime: 1000 }]);
    // A later conversation re-sync of the SAME session must keep its field coverage.
    markSynced(SRV, [{ id: 's1', mtime: 1000 }]);
    _resetLedgerCacheForTests();
    const row = getSyncedRows(SRV).get('s1')!;
    expect(row.v).toBeGreaterThan(0);              // conversation marked
    expect(row.f?.tool_title?.p).toBe(1);          // field coverage SURVIVED
    expect(fieldNeedsScan(row, F, 1000)).toBe(false); // → not re-scanned
  });

  test('full-pass gate: owed until done, re-owed on version bump or force', async () => {
    const { fieldNeedsFullPass, markFieldFullPassDone, forceFieldRescan } = await import('./sync-ledger.js');
    const SRV = 'https://full.example';
    const F = { name: 'tool_title', version: 1 };
    expect(fieldNeedsFullPass(SRV, F)).toBe(true);     // never reconciled
    markFieldFullPassDone(SRV, F);
    expect(fieldNeedsFullPass(SRV, F)).toBe(false);    // done at v1
    expect(fieldNeedsFullPass(SRV, { ...F, version: 2 })).toBe(true); // bumped
    forceFieldRescan('tool_title', SRV);
    expect(fieldNeedsFullPass(SRV, F)).toBe(true);     // forced
    markFieldFullPassDone(SRV, F);
    expect(fieldNeedsFullPass(SRV, F)).toBe(false);    // force cleared
  });

  test('syncMode: skip / append / full branches', async () => {
    const { syncMode, markSynced, getSyncedRows, _resetLedgerCacheForTests } = await import('./sync-ledger.js');
    const SRV = 'https://mode.example';
    // The version that APPLIES to these ids, not the base constant. markSynced
    // stamps extractorVersionForId(), so a per-tool bump (claude has one) makes
    // the base constant the wrong yardstick and every mode assertion below slides.
    const V = (await import('@chat-recall/engine/core/extractor-version.js')).extractorVersionForId('s1');
    const AO = true; // append-only backend
    // Append is ON by default now (the server enforces an offset-continuity
    // guard). CHAT_RECALL_TAIL_APPEND=0 is the emergency off-switch.
    delete process.env.CHAT_RECALL_TAIL_APPEND;

    // Never synced → full.
    expect(syncMode(undefined, 1000, 500, V, AO)).toBe('full');

    // FULL sync ships the whole file; mark with offset=size so the cursor covers.
    markSynced(SRV, [{ id: 's1', mtime: 1000, offset: 500, size: 500, acked: true }]);
    _resetLedgerCacheForTests();
    // Unchanged mtime + cursor covers size → skip.
    expect(syncMode(getSyncedRows(SRV).get('s1'), 1000, 500, V, AO)).toBe('skip');

    // File grew (500 → 800), version current, prior offset valid → append.
    expect(syncMode(getSyncedRows(SRV).get('s1'), 1000, 800, V, AO)).toBe('append');

    // Emergency off-switch: TAIL_APPEND=0 forces a grown file (mtime advanced)
    // to FULL instead of append. (mtime-unchanged-but-grew falls to skip and
    // resyncs on the next mtime tick.)
    process.env.CHAT_RECALL_TAIL_APPEND = '0';
    expect(syncMode(getSyncedRows(SRV).get('s1'), 1001, 800, V, AO)).toBe('full');
    delete process.env.CHAT_RECALL_TAIL_APPEND;

    // Version bump → full (overrides append-eligibility).
    expect(syncMode(getSyncedRows(SRV).get('s1'), 1000, 800, V + 1, AO)).toBe('full');

    // File shrank (rotation/truncation, size < offset) → full.
    markSynced(SRV, [{ id: 's2', mtime: 2000, offset: 1000, size: 1000, acked: true }]);
    _resetLedgerCacheForTests();
    expect(syncMode(getSyncedRows(SRV).get('s2'), 2000, 400, V, AO)).toBe('full');

    // Non-append-only backend (OpenCode SQLite): mtime advanced → full (never append).
    markSynced(SRV, [{ id: 's3', mtime: 3000 }]);
    _resetLedgerCacheForTests();
    expect(syncMode(getSyncedRows(SRV).get('s3'), 3000, 0, V, false)).toBe('skip');
    expect(syncMode(getSyncedRows(SRV).get('s3'), 4000, 0, V, false)).toBe('full');

    // First sync with no offset (o=0) → full even if append-only + file grew.
    markSynced(SRV, [{ id: 's4', mtime: 5000 }]); // no offset/size → o,s absent
    _resetLedgerCacheForTests();
    expect(syncMode(getSyncedRows(SRV).get('s4'), 5000, 100, V, AO)).toBe('skip');
    expect(syncMode(getSyncedRows(SRV).get('s4'), 6000, 200, V, AO)).toBe('full');
    delete process.env.CHAT_RECALL_TAIL_APPEND; // don't leak into other tests
  });

  test('markSynced persists offset/size and preserves f across re-sync', async () => {
    const { markSynced, markFieldCoverage, getSyncedRows, _resetLedgerCacheForTests } = await import('./sync-ledger.js');
    const SRV = 'https://os.example';
    const F = { name: 'tool_title', version: 1, mtimeSensitive: true };
    // Field coverage first, then a FULL conversation sync with offset.
    markFieldCoverage(SRV, F, [{ id: 's1', present: true, mtime: 1000 }]);
    markSynced(SRV, [{ id: 's1', mtime: 1000, offset: 500, size: 500, acked: true }]);
    _resetLedgerCacheForTests();
    const row = getSyncedRows(SRV).get('s1')!;
    expect(row.o).toBe(500);
    expect(row.s).toBe(500);
    expect(row.f?.tool_title?.p).toBe(1); // f survived
    // A later APPEND ack advances o/s without touching f.
    markSynced(SRV, [{ id: 's1', mtime: 1000, offset: 800, size: 800, acked: true }]);
    _resetLedgerCacheForTests();
    const row2 = getSyncedRows(SRV).get('s1')!;
    expect(row2.o).toBe(800);
    expect(row2.s).toBe(800);
    expect(row2.f?.tool_title?.p).toBe(1); // f still survives
  });

  test('markFullResync wipes the row so the next tick is FULL', async () => {
    const { markSynced, markFullResync, getSyncedRows, syncMode, _resetLedgerCacheForTests } = await import('./sync-ledger.js');
    const { EXTRACTOR_VERSION } = await import('@chat-recall/engine/core/extractor-version.js');
    const SRV = 'https://resync.example';
    // A fully-synced session with an offset cursor.
    markSynced(SRV, [{ id: 's1', mtime: 1000, offset: 500, size: 500, acked: true }]);
    _resetLedgerCacheForTests();
    expect(getSyncedRows(SRV).get('s1')).toBeDefined();
    // Server says full_resync_needed → wipe the row.
    markFullResync(SRV, 's1');
    _resetLedgerCacheForTests();
    expect(getSyncedRows(SRV).get('s1')).toBeUndefined(); // gone
    // Next tick: never-synced → FULL (not append, not skip).
    expect(syncMode(undefined, 1000, 500, EXTRACTOR_VERSION, true)).toBe('full');
    // Wiping a non-existent row / unknown server is a no-op (no throw).
    expect(() => markFullResync(SRV, 'nope')).not.toThrow();
    expect(() => markFullResync('https://unknown.example', 's1')).not.toThrow();
  });
});
