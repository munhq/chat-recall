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
});
