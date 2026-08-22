/**
 * The ledger is one file for every sync target, so a write costs the whole
 * thing. On this developer's machine that is 11.2 MB and 88,765 rows, and it
 * used to be rewritten on EVERY ack — per 25-session batch, per append, per
 * empty tail, per unchanged skip, per null verdict, per 200-row field chunk. A
 * walk of 15,718 sessions wrote hundreds of megabytes and burned ~150 ms of
 * JSON.stringify per write; the daemon sustained 4–5 MB/s of physical writes,
 * roughly 400 GB a day, two thirds of it this file.
 *
 * Writes are coalesced now, with an explicit flush at the end of a walk and on
 * shutdown. These tests pin BOTH halves of that bargain, because each is
 * useless without the other: the batching must actually batch, and the flush
 * must actually make it durable.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let saved: string | undefined;

async function ledger() {
  const m = await import('./sync-ledger.js');
  m._resetLedgerCacheForTests();
  return m;
}

beforeEach(() => {
  saved = process.env.CHAT_RECALL_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'cr-ledger-batch-'));
  process.env.CHAT_RECALL_DATA_DIR = dir;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (saved === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const SERVER = 'https://example.test';

describe('ledger write batching', () => {
  test('200 acks do not produce 200 file writes', async () => {
    const { markSynced, flushLedger } = await ledger();
    const path = join(dir, 'sync-ledger.json');

    for (let i = 0; i < 200; i++) {
      markSynced(SERVER, [{ id: `s_${i}`, mtime: 1000 + i, acked: true }]);
    }
    // Asserted on the filesystem rather than with a spy: the module imports
    // writeFileSync directly, so the ESM namespace cannot be redefined — and
    // the absence of the file is the stronger claim anyway. Before batching,
    // this loop wrote the whole ledger 200 times.
    expect(existsSync(path)).toBe(false);

    flushLedger();
    expect(existsSync(path)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf-8'))[SERVER])).toHaveLength(200);
  });

  test('the flush is what makes it durable, and it writes every row', async () => {
    const { markSynced, flushLedger } = await ledger();
    for (let i = 0; i < 50; i++) markSynced(SERVER, [{ id: `s_${i}`, mtime: 7000 + i, acked: true }]);

    const path = join(dir, 'sync-ledger.json');
    expect(existsSync(path)).toBe(false);   // coalesced, not yet on disk

    flushLedger();
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    expect(Object.keys(onDisk[SERVER])).toHaveLength(50);
    expect(onDisk[SERVER]['s_49'].m).toBe(7049);
  });

  test('the timer flushes on its own, so a long-lived daemon is not left dirty', async () => {
    const { markSynced } = await ledger();
    markSynced(SERVER, [{ id: 's_1', mtime: 42, acked: true }]);
    const path = join(dir, 'sync-ledger.json');
    expect(existsSync(path)).toBe(false);

    await vi.advanceTimersByTimeAsync(2500);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf-8'))[SERVER]['s_1'].m).toBe(42);
  });

  test('flushing with nothing pending writes nothing', async () => {
    const { flushLedger } = await ledger();
    const path = join(dir, 'sync-ledger.json');
    flushLedger();
    flushLedger();
    expect(existsSync(path)).toBe(false);
  });
});

describe('pruning targets this machine no longer syncs to', () => {
  test('parks orphan rows in a sidecar instead of deleting them', async () => {
    const { markSynced, flushLedger, pruneLedgerTargets, getSyncedRows } = await ledger();
    markSynced('https://live.test', [{ id: 'a', mtime: 1, acked: true }]);
    markSynced('https://dead.test', [{ id: 'b', mtime: 2, acked: true }]);
    markSynced('http://localhost:8080', [{ id: 'c', mtime: 3, acked: true }]);
    flushLedger();

    const moved = pruneLedgerTargets(['https://live.test']);
    expect(moved).toBe(2);

    // Live rows survive; orphans are gone from the hot file...
    expect(getSyncedRows('https://live.test').has('a')).toBe(true);
    expect(getSyncedRows('https://dead.test').size).toBe(0);

    // ...but not destroyed. Re-adding the server must not re-ship a history.
    const side = JSON.parse(readFileSync(join(dir, 'sync-ledger.json.orphans.json'), 'utf-8'));
    expect(Object.keys(side).sort()).toEqual(['http://localhost:8080', 'https://dead.test']);
    expect(side['https://dead.test'].b.m).toBe(2);
  });

  test('a second prune does not lose what the first parked', async () => {
    const { markSynced, flushLedger, pruneLedgerTargets } = await ledger();
    markSynced('https://one.test', [{ id: 'a', mtime: 1, acked: true }]);
    markSynced('https://two.test', [{ id: 'b', mtime: 2, acked: true }]);
    markSynced('https://three.test', [{ id: 'c', mtime: 3, acked: true }]);
    flushLedger();

    pruneLedgerTargets(['https://two.test', 'https://three.test']);
    pruneLedgerTargets(['https://three.test']);

    const side = JSON.parse(readFileSync(join(dir, 'sync-ledger.json.orphans.json'), 'utf-8'));
    expect(Object.keys(side).sort()).toEqual(['https://one.test', 'https://two.test']);
  });

  test('nothing to prune is a no-op', async () => {
    const { markSynced, flushLedger, pruneLedgerTargets } = await ledger();
    markSynced('https://live.test', [{ id: 'a', mtime: 1, acked: true }]);
    flushLedger();
    expect(pruneLedgerTargets(['https://live.test'])).toBe(0);
    expect(existsSync(join(dir, 'sync-ledger.json.orphans.json'))).toBe(false);
  });
});
