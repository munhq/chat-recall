/**
 * The ledger file is shared by every chat-recall process on the machine: the
 * watch daemon, each MCP daemon, a manual sync, `verify --repair`.
 *
 * THE FAILURE these tests exist for: each process loaded the file once and
 * later wrote its whole copy back. `verify --repair` cleared the cursor of 23
 * stranded sessions, and the watch daemon's next write restored all 23, so the
 * repair did nothing and the sessions stayed short on the server.
 *
 * "Another process" here is a direct write to the file, which is all another
 * process does.
 */
import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRV = 'https://server.example';
let dataDir = '';
const origDataDir = process.env.CHAT_RECALL_DATA_DIR;

beforeEach(async () => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = mkdtempSync(join(tmpdir(), 'cr-ledger-shared-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  const { _resetLedgerCacheForTests } = await import('./sync-ledger.js');
  _resetLedgerCacheForTests();
});
afterAll(() => {
  if (origDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = origDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

/** Another process edits the file. The mtime moves forward so the change is seen. */
function otherProcess(edit: (rows: Record<string, Record<string, unknown>>) => void): void {
  const path = join(dataDir, 'sync-ledger.json');
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  edit(data);
  writeFileSync(path, JSON.stringify(data));
  const later = new Date(Date.now() + 5000);
  utimesSync(path, later, later);
}

describe('several processes share the ledger', () => {
  test('THE FAILURE: a cursor another process cleared stays cleared', async () => {
    const { markSynced, flushLedger, getSyncedRows } = await import('./sync-ledger.js');
    markSynced(SRV, [
      { id: 'stranded', mtime: 1000, offset: 500, size: 500, acked: true },
      { id: 'busy', mtime: 1000, offset: 10, size: 10, acked: true },
    ]);
    flushLedger();

    // verify --repair in another process clears the stranded cursor.
    otherProcess((d) => {
      const row = d[SRV].stranded as Record<string, unknown>;
      delete row.o; delete row.s; delete row.m;
    });

    // This process (the daemon) acks a different session and writes.
    markSynced(SRV, [{ id: 'busy', mtime: 2000, offset: 20, size: 20, acked: true }]);
    flushLedger();

    const onDisk = JSON.parse(readFileSync(join(dataDir, 'sync-ledger.json'), 'utf-8'));
    expect(onDisk[SRV].stranded.o).toBeUndefined();
    expect(onDisk[SRV].busy.o).toBe(20);
    // And the daemon itself sees the cleared cursor, so it ships the session.
    expect(getSyncedRows(SRV).get('stranded')?.o).toBeUndefined();
  });

  test('a row another process added survives this process writing', async () => {
    const { markSynced, flushLedger } = await import('./sync-ledger.js');
    markSynced(SRV, [{ id: 'a', mtime: 1 }]);
    flushLedger();
    otherProcess((d) => { d[SRV].fromOther = { m: 7, v: 1 }; });
    markSynced(SRV, [{ id: 'b', mtime: 2 }]);
    flushLedger();
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'sync-ledger.json'), 'utf-8'));
    expect(Object.keys(onDisk[SRV]).sort()).toEqual(['a', 'b', 'fromOther']);
  });

  test('a row another process deleted stays deleted, one this process deleted is deleted', async () => {
    const { markSynced, markFullResync, flushLedger, getSyncedRows } = await import('./sync-ledger.js');
    markSynced(SRV, [{ id: 'x', mtime: 1 }, { id: 'y', mtime: 1 }, { id: 'z', mtime: 1 }]);
    flushLedger();
    otherProcess((d) => { delete d[SRV].x; });
    markFullResync(SRV, 'y');
    flushLedger();
    expect([...getSyncedRows(SRV).keys()]).toEqual(['z']);
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'sync-ledger.json'), 'utf-8'));
    expect(Object.keys(onDisk[SRV])).toEqual(['z']);
  });

  test('when both change one row, this process’s write wins', async () => {
    const { markSynced, flushLedger, getSyncedRows } = await import('./sync-ledger.js');
    markSynced(SRV, [{ id: 'r', mtime: 1 }]);
    flushLedger();
    markSynced(SRV, [{ id: 'r', mtime: 3 }]);
    otherProcess((d) => { d[SRV].r = { m: 2, v: 1 }; });
    flushLedger();
    expect(getSyncedRows(SRV).get('r')?.m).toBe(3);
  });

  test('an object a caller got from getLedgerData sees the other process’s rows', async () => {
    const { markSynced, flushLedger, getLedgerData, persistLedgerData } = await import('./sync-ledger.js');
    markSynced(SRV, [{ id: 'keep', mtime: 1 }]);
    flushLedger();
    const rows = getLedgerData(SRV);
    otherProcess((d) => { d[SRV].late = { m: 5, v: 1 }; });
    // A read in between, as a sync walk does, merges the file into the same object.
    expect(getLedgerData(SRV)).toBe(rows);
    expect(rows.late).toEqual({ m: 5, v: 1 });
    delete rows.keep;
    persistLedgerData(SRV, rows);
    flushLedger();
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'sync-ledger.json'), 'utf-8'));
    expect(onDisk[SRV]).toEqual({ late: { m: 5, v: 1 } });
  });
});
