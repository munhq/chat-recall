/**
 * A session that took appends gets one full sync once it goes quiet.
 *
 * THE FAILURE: an append ships only the tail, with no raw archive and no
 * derived rows, and after the first append nothing ever sent the session in
 * full again. One session's archive held 64 messages while its conversation
 * held 387.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRV = 'https://server.example';
let n = 0;
/** A fresh id per test: the cache reset flushes the previous test's rows into the new folder. */
let ID = '';
const HOUR = 60 * 60 * 1000;
const T0 = 1_790_000_000_000;
let dataDir: string;
let prev: string | undefined;

async function ledger() {
  const m = await import('./sync-ledger.js');
  m._resetLedgerCacheForTests();
  return m;
}

beforeEach(() => {
  prev = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-ledger-settle-'));
  ID = `settle-session-${++n}`;
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('settle full sync', () => {
  test('THE FAILURE: an appended session that stays quiet for 2 h is sent in full once', async () => {
    const { markSynced, getSyncedRows, syncMode } = await ledger();
    markSynced(SRV, [{ id: ID, mtime: T0, offset: 1000, size: 1000, hash: 'h1', acked: true, full: true }]);
    markSynced(SRV, [{ id: ID, mtime: T0 + 10, offset: 1500, size: 1500, acked: true, chunkFinal: true }]);   // a live append
    const row = () => getSyncedRows(SRV).get(ID)!;
    const v = row().v;
    expect(row().F).toBe(1000);
    // Still being written to: no settle yet.
    expect(syncMode(row(), T0 + 10, 1500, v, true, T0 + 10 + HOUR)).toBe('skip');
    // Quiet for 2 h: settle.
    expect(syncMode(row(), T0 + 10, 1500, v, true, T0 + 10 + 2 * HOUR)).toBe('full');
    // The settle FULL is acked: covered, never again for these bytes.
    markSynced(SRV, [{ id: ID, mtime: T0 + 10, offset: 1500, size: 1500, hash: 'h2', acked: true, full: true }]);
    expect(row().F).toBe(1500);
    expect(syncMode(row(), T0 + 10, 1500, v, true, T0 + 10 + 30 * HOUR)).toBe('skip');
  });

  test('a file that grew appends first; the settle waits for quiet', async () => {
    const { markSynced, getSyncedRows, syncMode } = await ledger();
    markSynced(SRV, [{ id: ID, mtime: T0, offset: 1000, size: 1000, acked: true, full: true }]);
    markSynced(SRV, [{ id: ID, mtime: T0 + 10, offset: 1500, size: 1500, acked: true, chunkFinal: true }]);
    const row = getSyncedRows(SRV).get(ID)!;
    expect(syncMode(row, T0 + 20, 1800, row.v, true, T0 + 5 * HOUR)).toBe('append');
  });

  test('a chunked full sync completes at its final append, and does not settle again', async () => {
    const { markSynced, getSyncedRows, syncMode } = await ledger();
    markSynced(SRV, [{ id: ID, mtime: T0, offset: 8000, size: 8000, acked: true, chunkedHead: true }]);
    expect(getSyncedRows(SRV).get(ID)!.k).toBe(1);
    // A middle chunk does not complete it.
    markSynced(SRV, [{ id: ID, mtime: T0, offset: 16000, size: 16000, acked: true, chunkFinal: false }]);
    expect(getSyncedRows(SRV).get(ID)!.F).toBeUndefined();
    // While in progress, a quiet session does not start another full sync.
    const mid = getSyncedRows(SRV).get(ID)!;
    expect(syncMode(mid, T0, 16000, mid.v, true, T0 + 9 * HOUR)).toBe('skip');
    markSynced(SRV, [{ id: ID, mtime: T0, offset: 20000, size: 20000, acked: true, chunkFinal: true }]);
    const done = getSyncedRows(SRV).get(ID)!;
    expect(done.F).toBe(20000);
    expect(done.k).toBeUndefined();
    expect(syncMode(done, T0, 20000, done.v, true, T0 + 9 * HOUR)).toBe('skip');
  });

  test('an older row with a content hash counts as fully synced, so an upgrade settles nothing', async () => {
    const { syncMode } = await ledger();
    const legacy = { m: T0, v: 99, o: 5000, s: 5000, h: 'abc' };
    expect(syncMode(legacy, T0, 5000, 1, true, T0 + 48 * HOUR)).toBe('skip');
    // An older row whose last sync was an append has no hash: it settles.
    const appended = { m: T0, v: 99, o: 5000, s: 5000 };
    expect(syncMode(appended, T0, 5000, 1, true, T0 + 48 * HOUR)).toBe('full');
  });

  test('a backend that is not append-only never settles', async () => {
    const { syncMode } = await ledger();
    expect(syncMode({ m: T0, v: 99, o: 5000, s: 5000 }, T0, 5000, 1, false, T0 + 48 * HOUR)).toBe('skip');
  });
});
