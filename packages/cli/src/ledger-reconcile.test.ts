/**
 * The ledger check against the server (issue #21). The ledger said 4,000
 * sessions were synced while the server held 479, for four days.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import {
  planReconcile, reconcileLedger, reconcileLedgerIfDue, reconcileMode, fetchServerSessions,
  RECONCILE_MAX_PER_RUN, RECONCILE_INTERVAL_MS, _resetReconcileClockForTests,
  type ServerSessionList,
} from './ledger-reconcile.js';

const rows = (entries: Array<[string, number]>): Map<string, { m: number }> =>
  new Map(entries.map(([id, m]) => [id, { m }]));
const list = (ids: string[], deleted: string[] = []): ServerSessionList => ({ ids: new Set(ids), deleted: new Set(deleted) });

beforeEach(() => _resetReconcileClockForTests());

describe('planReconcile', () => {
  test('a session in the ledger and not on the server is queued, newest first', () => {
    const plan = planReconcile({
      ledger: rows([['old', 100], ['new', 300], ['mid', 200], ['held', 400]]),
      serverIds: new Set(['held']),
    });
    expect(plan.queued).toEqual(['new', 'mid', 'old']);
  });

  test('one run queues at most 2,000 sessions and keeps the newest', () => {
    const entries: Array<[string, number]> = Array.from({ length: 2500 }, (_, i) => [`s-${i}`, i]);
    const plan = planReconcile({ ledger: rows(entries), serverIds: new Set() });
    expect(plan.missing).toHaveLength(2500);
    expect(plan.queued).toHaveLength(RECONCILE_MAX_PER_RUN);
    expect(plan.queued[0]).toBe('s-2499');
    expect(plan.queued.at(-1)).toBe('s-500');
  });

  test('a session with a tombstone on the server is not queued', () => {
    const plan = planReconcile({
      ledger: rows([['gone', 1], ['lost', 2]]),
      serverIds: new Set(),
      deletedIds: new Set(['gone']),
    });
    expect(plan.queued).toEqual(['lost']);
  });

  test('a ledger that the server fully holds queues nothing', () => {
    const plan = planReconcile({ ledger: rows([['a', 1], ['b', 2]]), serverIds: new Set(['a', 'b']) });
    expect(plan).toEqual({ missing: [], queued: [] });
  });
});

describe('reconcileLedger', () => {
  const quiet = { log: () => {} };

  test('report mode changes nothing and names the first five ids', async () => {
    const forgotten: string[][] = [];
    const lines: string[] = [];
    const result = await reconcileLedger('https://example.test', 't', 'report', {
      listServer: async () => list([]),
      ledgerRows: () => rows(Array.from({ length: 8 }, (_, i) => [`s-${i}`, i] as [string, number])),
      forget: (_s, ids) => { forgotten.push(ids); },
      log: (l) => lines.push(l),
    });
    expect(forgotten).toEqual([]);
    expect(result).toMatchObject({ mode: 'report', missing: 8, cleared: 0 });
    expect(lines[0]).toContain('8 session(s)');
    expect(lines[0]).toContain('s-7, s-6, s-5, s-4, s-3');
  });

  test('act mode clears the queued rows', async () => {
    const forgotten: string[][] = [];
    const result = await reconcileLedger('https://example.test', 't', 'act', {
      ...quiet,
      listServer: async () => list(['a']),
      ledgerRows: () => rows([['a', 1], ['b', 2], ['c', 3]]),
      forget: (_s, ids) => { forgotten.push(ids); },
    });
    expect(forgotten).toEqual([['c', 'b']]);
    expect(result.cleared).toBe(2);
  });

  test('off mode does not ask the server', async () => {
    let asked = false;
    await reconcileLedger('https://example.test', 't', 'off', {
      ...quiet,
      listServer: async () => { asked = true; return list([]); },
    });
    expect(asked).toBe(false);
  });
});

describe('reconcileLedgerIfDue', () => {
  const deps = (calls: { n: number }) => ({
    log: () => {},
    listServer: async () => { calls.n++; return list([]); },
    ledgerRows: () => rows([]),
    forget: () => {},
  });

  test('the first call runs and a second call within a day does not', async () => {
    const calls = { n: 0 };
    await reconcileLedgerIfDue('https://one.test', 't', 1_000, deps(calls));
    await reconcileLedgerIfDue('https://one.test', 't', 1_000 + RECONCILE_INTERVAL_MS - 1, deps(calls));
    expect(calls.n).toBe(1);
  });

  test('a call after a day runs again', async () => {
    const calls = { n: 0 };
    await reconcileLedgerIfDue('https://two.test', 't', 1_000, deps(calls));
    await reconcileLedgerIfDue('https://two.test', 't', 1_000 + RECONCILE_INTERVAL_MS, deps(calls));
    expect(calls.n).toBe(2);
  });

  test('each server has its own clock', async () => {
    const calls = { n: 0 };
    await reconcileLedgerIfDue('https://a.test', 't', 1_000, deps(calls));
    await reconcileLedgerIfDue('https://b.test', 't', 1_000, deps(calls));
    expect(calls.n).toBe(2);
  });

  test('a failed request is logged, leaves the ledger alone and is tried again on the next call', async () => {
    const lines: string[] = [];
    let attempts = 0;
    const failing = {
      log: (l: string) => lines.push(l),
      listServer: async (): Promise<ServerSessionList> => { attempts++; throw new Error('HTTP 502'); },
      ledgerRows: () => rows([['a', 1]]),
      forget: () => { throw new Error('must not clear'); },
    };
    expect(await reconcileLedgerIfDue('https://fail.test', 't', 1_000, failing)).toBeNull();
    expect(await reconcileLedgerIfDue('https://fail.test', 't', 2_000, failing)).toBeNull();
    expect(attempts).toBe(2);
    expect(lines[0]).toContain('HTTP 502');
  });
});

describe('reconcileMode', () => {
  test('the default acts', () => { expect(reconcileMode({})).toBe('act'); });
  test('report and off are honoured', () => {
    expect(reconcileMode({ CHAT_RECALL_LEDGER_RECONCILE: 'REPORT' })).toBe('report');
    expect(reconcileMode({ CHAT_RECALL_LEDGER_RECONCILE: 'off' })).toBe('off');
  });
  test('a value that does not parse keeps act', () => {
    expect(reconcileMode({ CHAT_RECALL_LEDGER_RECONCILE: 'maybe' })).toBe('act');
  });
});

describe('fetchServerSessions', () => {
  const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

  test('reads the ids and the tombstones', async () => {
    const got = await fetchServerSessions('https://example.test', 't', json({ sessions: [{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }], deleted: ['c'] }));
    expect([...got.ids]).toEqual(['a', 'b']);
    expect([...got.deleted]).toEqual(['c']);
  });

  test('an error status throws, so a failed call is not an empty server', async () => {
    await expect(fetchServerSessions('https://example.test', 't', json({ error: 'x' }, 502))).rejects.toThrow('HTTP 502');
  });

  test('an answer that is not a session list throws', async () => {
    await expect(fetchServerSessions('https://example.test', 't', json({ ok: true }))).rejects.toThrow('session list');
  });
});
