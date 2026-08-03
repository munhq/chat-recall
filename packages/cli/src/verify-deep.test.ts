/**
 * `verify --deep` exists because every silent-loss incident here was found by a
 * human asking about one session. So the thing that must be right is the
 * CLASSIFICATION: a tool that cries wolf gets ignored, and a tool that reports
 * "clean" while records are missing is worse than nothing.
 *
 * Two specific traps, both hit for real during the investigation:
 *   - comparing mtimes instead of content flagged 9,975 of 10,032 sessions when
 *     the true count was 13 (the server stores the client-sent mtime, which
 *     drifts sub-second for nearly every session)
 *   - "the server has less" is only actionable when the ledger ALSO claims the
 *     session is complete; otherwise it is just a sync in flight
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRV = 'https://example.test';
let dataDir: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-verify-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

/** local container size / disk size / server size, per session. */
function makeDeps(rows: Array<{ id: string; local: number; disk: number; server?: number }>) {
  return {
    listSessions: () => rows.map((r) => ({
      rawId: r.id, prefixedId: r.id, projectPath: '/p/' + r.id, mtime: 1000,
    })),
    localContainerSize: (id: string) => rows.find((r) => r.id === id)?.local ?? null,
    fileSize: (id: string) => rows.find((r) => r.id === id)?.disk ?? 0,
    serverSizes: async () => new Map(
      rows.filter((r) => r.server !== undefined).map((r) => [r.id, r.server!]),
    ),
  };
}

async function run(deps: ReturnType<typeof makeDeps>, now = 10_000_000) {
  const { verifyAgainstServer } = await import('./verify-deep.js');
  return verifyAgainstServer(SRV, 'tok', 0, deps, now);
}

/** Seed ledger cursors. Takes every id at once — resetting the cache per call
 *  (an earlier version of this helper) silently dropped all but the last seed
 *  and made a multi-session assertion pass for the wrong reason. */
async function seedLedger(entries: Array<{ id: string; cursor: number; mtime?: number }>) {
  const m = await import('./sync-ledger.js');
  m._resetLedgerCacheForTests();
  m.markSynced(SRV, entries.map((e) => ({
    id: e.id, mtime: e.mtime ?? 1000, offset: e.cursor, size: e.cursor, acked: true,
  })));
}

describe('classification', () => {
  test('equal sizes are complete', async () => {
    const r = await run(makeDeps([{ id: 'a', local: 5000, disk: 5000, server: 5000 }]));
    expect(r.complete).toBe(1);
    expect(r.stranded).toHaveLength(0);
    expect(r.pending).toHaveLength(0);
  });

  test('sub-tolerance differences are NOT reported — encoding noise, not loss', async () => {
    // The container envelope can differ by a few bytes without a record moving.
    const r = await run(makeDeps([{ id: 'a', local: 5000 + 200, disk: 5000, server: 5000 }]));
    expect(r.complete).toBe(1);
    expect(r.stranded).toHaveLength(0);
  });

  test('server has less AND the ledger claims complete ⇒ STRANDED', async () => {
    await seedLedger([{ id: 'a', cursor: 9000 }]);                       // cursor at/past disk size
    const r = await run(makeDeps([{ id: 'a', local: 12_000, disk: 9000, server: 5000 }]));
    expect(r.stranded).toHaveLength(1);
    expect(r.stranded[0].deficit).toBe(7000);
    expect(r.pending).toHaveLength(0);
  });

  test('server has less but the ledger knows there is more ⇒ pending, not stranded', async () => {
    await seedLedger([{ id: 'a', cursor: 4000 }]);                       // cursor BEHIND disk size
    const r = await run(makeDeps([{ id: 'a', local: 12_000, disk: 9000, server: 5000 }]));
    expect(r.pending).toHaveLength(1);
    expect(r.stranded).toHaveLength(0);                // it will re-ship on its own
  });

  test('never synced (no ledger row) ⇒ pending, not stranded', async () => {
    const r = await run(makeDeps([{ id: 'a', local: 12_000, disk: 9000, server: 5000 }]));
    expect(r.pending).toHaveLength(1);
    expect(r.stranded).toHaveLength(0);
  });

  test('a session with no server archive is counted, not called stranded', async () => {
    const r = await run(makeDeps([{ id: 'a', local: 5000, disk: 5000 }]));  // server absent
    expect(r.missingArchive).toBe(1);
    expect(r.checked).toBe(0);
    expect(r.stranded).toHaveLength(0);
  });

  test('an unreadable local session is skipped rather than guessed at', async () => {
    const deps = makeDeps([{ id: 'a', local: 0, disk: 0, server: 5000 }]);
    deps.localContainerSize = () => null;
    const r = await run(deps);
    expect(r.checked).toBe(0);
    expect(r.stranded).toHaveLength(0);
  });

  test('a server HOLDING MORE than local is not a finding', async () => {
    // Normal after a resume-truncation: shrink protection + shadow kept more
    // than the disk now has. Reporting that would be crying wolf.
    const r = await run(makeDeps([{ id: 'a', local: 3000, disk: 3000, server: 9000 }]));
    expect(r.complete).toBe(1);
    expect(r.stranded).toHaveLength(0);
  });

  test('stranded findings are ordered worst-first', async () => {
    await seedLedger([{ id: 'small', cursor: 100 }, { id: 'big', cursor: 100 }]);
    const r = await run(makeDeps([
      { id: 'small', local: 3_000, disk: 100, server: 1_000 },   // 2k deficit, above tolerance
      { id: 'big', local: 90_000, disk: 100, server: 1_000 },
    ]));
    expect(r.stranded.map((f) => f.sessionId)).toEqual(['big', 'small']);
  });
});

describe('a session being written right now', () => {
  test('is pending, not stranded, even when the cursor says complete', async () => {
    // The first real run flagged the live session it was invoked from (short by
    // 902 B): bytes grow between the cursor read and the container build, so
    // `cursor >= fileSize` holds momentarily for a session that is simply
    // mid-flight. Reporting that on every run is how a checker gets ignored.
    await seedLedger([{ id: 'live', cursor: 9000, mtime: 9_999_000 }]);
    const deps = makeDeps([{ id: 'live', local: 12_000, disk: 9000, server: 5000 }]);
    deps.listSessions = () => [{ rawId: 'live', prefixedId: 'live', projectPath: '/p', mtime: 9_999_000 }];

    const r = await run(deps, 10_000_000);   // written 1 000 ms ago
    expect(r.stranded).toHaveLength(0);
    expect(r.pending).toHaveLength(1);
  });

  test('the same session IS stranded once it goes quiet', async () => {
    await seedLedger([{ id: 'quiet', cursor: 9000, mtime: 1_000_000 }]);
    const deps = makeDeps([{ id: 'quiet', local: 12_000, disk: 9000, server: 5000 }]);
    deps.listSessions = () => [{ rawId: 'quiet', prefixedId: 'quiet', projectPath: '/p', mtime: 1_000_000 }];

    const r = await run(deps, 10_000_000);   // written 2.5 h ago
    expect(r.stranded).toHaveLength(1);
  });
});

describe('the real 7adc748c shape', () => {
  test('is detected as stranded', async () => {
    // Ledger cursor at the union size (7195821) while the server held 2004 of
    // 2698 records — the exact state that read as complete forever.
    await seedLedger([{ id: '7adc748c', cursor: 7_195_821 }]);
    const r = await run(makeDeps([
      { id: '7adc748c', local: 7_940_877, disk: 7_195_821, server: 5_965_361 },
    ]));
    expect(r.stranded).toHaveLength(1);
    expect(r.stranded[0].sessionId).toBe('7adc748c');
    expect(r.stranded[0].deficit).toBe(7_940_877 - 5_965_361);
  });
});
