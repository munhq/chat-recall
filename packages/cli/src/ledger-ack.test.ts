/**
 * The byte cursor is a DELIVERY RECEIPT, not a measurement.
 *
 * `syncMode` decides SKIP/APPEND from `o`/`s`. A cursor written without a server
 * acknowledgement therefore makes a session unreachable: skipped on every pass,
 * never re-exported, and silent — `15604 skipped` looks the same either way.
 *
 * This is not hypothetical. A call site stamped the cursor at the local
 * `fileSize()` after a tail came back empty, to stop the gate retrying. Once
 * `fileSize()` began summing copies across profile homes, the cursor jumped to
 * the union size while the server held one home's half — session 7adc748c ended
 * with `s: 7195821` in the ledger and 2004 of 2698 records on the server, with
 * no path back.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prev: string | undefined;

async function ledger() {
  const m = await import('./sync-ledger.js');
  m._resetLedgerCacheForTests();
  m._resetUnackedCursorCount();
  return m;
}

beforeEach(() => {
  prev = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-ledger-ack-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

const SRV = 'https://example.test';
const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('the cursor only advances on an acknowledged write', () => {
  test('an UNACKED row does not set the cursor at all', async () => {
    const { markSynced, getSyncedRows, unackedCursorAttemptCount } = await ledger();
    markSynced(SRV, [{ id: ID, mtime: 1000, offset: 5000, size: 5000 }]);   // no acked

    const row = getSyncedRows(SRV).get(ID)!;
    expect(row.m).toBe(1000);          // mtime is still recorded (anti-thrash)
    expect(row.o ?? 0).toBe(0);        // but the cursor is NOT
    expect(row.s ?? 0).toBe(0);
    expect(unackedCursorAttemptCount()).toBe(1);   // and it is counted, not silent
  });

  test('an ACKED row does set the cursor', async () => {
    const { markSynced, getSyncedRows } = await ledger();
    markSynced(SRV, [{ id: ID, mtime: 1000, offset: 5000, size: 5000, acked: true }]);
    const row = getSyncedRows(SRV).get(ID)!;
    expect(row.o).toBe(5000);
    expect(row.s).toBe(5000);
  });

  test('an unacked row cannot ROLL BACK a cursor the server confirmed', async () => {
    const { markSynced, getSyncedRows } = await ledger();
    markSynced(SRV, [{ id: ID, mtime: 1000, offset: 5000, size: 5000, acked: true }]);
    markSynced(SRV, [{ id: ID, mtime: 2000, offset: 10, size: 10 }]);       // unacked
    const row = getSyncedRows(SRV).get(ID)!;
    expect(row.o).toBe(5000);
    expect(row.s).toBe(5000);
    expect(row.m).toBe(2000);          // mtime still moves
  });

  test('the exact 7adc748c regression: empty tail must not seal the session', async () => {
    const { markSynced, getSyncedRows, syncMode } = await ledger();
    // Server confirmed 2004 records' worth of bytes.
    markSynced(SRV, [{ id: ID, mtime: 1000, offset: 5_000_000, size: 5_000_000, acked: true }]);

    // A tail comes back empty; the old code stamped the union fileSize here.
    markSynced(SRV, [{ id: ID, mtime: 1500 }]);

    // The file is bigger than the confirmed cursor, so the next pass must still
    // want to APPEND. Under the old behaviour this returned 'skip' forever.
    const row = getSyncedRows(SRV).get(ID)!;
    expect(syncMode(row, 2000, 7_195_821, row.v, true)).toBe('append');
  });

  test('an unchanged-content ack at the SAME cursor is allowed', async () => {
    const { markSynced, getSyncedRows } = await ledger();
    markSynced(SRV, [{ id: ID, mtime: 1000, offset: 5000, size: 5000, acked: true }]);
    // Byte-identical content re-verified: same cursor, plus a hash. Legitimate.
    markSynced(SRV, [{ id: ID, mtime: 2000, offset: 5000, size: 5000, hash: 'abc', acked: true }]);
    const row = getSyncedRows(SRV).get(ID)!;
    expect(row.s).toBe(5000);
    expect(row.h).toBe('abc');
  });

  test('per-field coverage survives an unacked stamp', async () => {
    const { markSynced, markFieldCoverage, getSyncedRows } = await ledger();
    markSynced(SRV, [{ id: ID, mtime: 1000, offset: 100, size: 100, acked: true }]);
    markFieldCoverage(SRV, { name: 'tool_title', version: 1 }, [{ id: ID, present: true, mtime: 1000 }]);
    markSynced(SRV, [{ id: ID, mtime: 2000 }]);
    expect(getSyncedRows(SRV).get(ID)!.f).toBeTruthy();
  });
});

describe('forceFullResync un-strands a session', () => {
  test('clears the cursor, hash and mtime so the next pass is a FULL', async () => {
    const { markSynced, getSyncedRows, syncMode, _resetLedgerCacheForTests } = await ledger();
    markSynced(SRV, [{ id: ID, mtime: 5000, offset: 9_000_000, size: 9_000_000, hash: 'h', acked: true }]);
    // Sealed: the ledger claims everything through 9MB is on the server.
    expect(syncMode(getSyncedRows(SRV).get(ID)!, 5000, 9_000_000, 1, true)).toBe('skip');

    const { forceFullResync } = await import('./verify-repair.js');
    expect(forceFullResync(SRV, [ID])).toBe(1);

    _resetLedgerCacheForTests();
    const row = getSyncedRows(SRV).get(ID);
    expect(row?.o ?? 0).toBe(0);
    expect(row?.s ?? 0).toBe(0);
    // With no cursor and no mtime, the session is re-shipped in full.
    expect(syncMode(row, 5000, 9_000_000, 1, true)).toBe('full');
  });

  test('leaves other sessions alone', async () => {
    const { markSynced, getSyncedRows, _resetLedgerCacheForTests } = await ledger();
    const OTHER = 'ffffffff-1111-2222-3333-444444444444';
    markSynced(SRV, [
      { id: ID, mtime: 1, offset: 10, size: 10, acked: true },
      { id: OTHER, mtime: 2, offset: 20, size: 20, acked: true },
    ]);
    const { forceFullResync } = await import('./verify-repair.js');
    forceFullResync(SRV, [ID]);
    _resetLedgerCacheForTests();
    expect(getSyncedRows(SRV).get(OTHER)!.s).toBe(20);
  });
});
