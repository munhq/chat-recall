/**
 * The ledger check against the server (issue #21). The ledger said 4,000
 * sessions were synced while the server held 479, for four days.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import {
  planReconcile, reconcileLedger, reconcileLedgerIfDue, reconcileMode, fetchServerSessions,
  RECONCILE_MAX_PER_RUN, RECONCILE_INTERVAL_MS, RECONCILE_BACKLOG_RETRY_MS, _resetReconcileClockForTests,
  type ServerSessionList,
} from './ledger-reconcile.js';

const rows = (entries: Array<[string, number]>): Map<string, { m: number }> =>
  new Map(entries.map(([id, m]) => [id, { m }]));
const list = (ids: string[], deleted: string[] = []): ServerSessionList => ({ ids: new Set(ids), deleted: new Set(deleted) });

beforeEach(() => _resetReconcileClockForTests());

describe('fetchServerSessions', () => {
  const okBody = { sessions: [{ id: 'a' }, { id: 'b' }], deleted: ['c'] };
  const ok = () => new Response(JSON.stringify(okBody), { status: 200 });

  test('sends the request again when the connection fails', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; if (calls < 3) throw new TypeError('fetch failed'); return ok(); };
    const got = await fetchServerSessions('http://server.example', 'tok', fetcher as never);
    expect(calls).toBe(3);
    expect([...got.ids]).toEqual(['a', 'b']);
    expect([...got.deleted]).toEqual(['c']);
  });

  test('gives the error after three failed attempts', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; throw new TypeError('fetch failed'); };
    await expect(fetchServerSessions('http://server.example', 'tok', fetcher as never)).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });

  test('does not send again an answer of the server', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return new Response('no', { status: 500 }); };
    await expect(fetchServerSessions('http://server.example', 'tok', fetcher as never)).rejects.toThrow('HTTP 500');
    expect(calls).toBe(1);
  });
});

describe('planReconcile', () => {
  test('a session whose build gave nothing to ship is not owed to the server', () => {
    const ledger = new Map<string, { m: number; E?: 1 }>([['stub', { m: 500, E: 1 }], ['real', { m: 100 }]]);
    const plan = planReconcile({ ledger, serverIds: new Set() });
    expect(plan.missing).toEqual(['real']);
    expect(plan.queued).toEqual(['real']);
  });

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

  test('a run that leaves sessions in the backlog is due again in half an hour', async () => {
    const calls = { n: 0 };
    const many = rows(Array.from({ length: RECONCILE_MAX_PER_RUN + 5 }, (_, i) => [`s-${i}`, i] as [string, number]));
    const backlog = { log: () => {}, listServer: async () => { calls.n++; return list([]); }, ledgerRows: () => many, forget: () => {} };
    await reconcileLedgerIfDue('https://backlog.test', 't', 1_000, backlog);
    await reconcileLedgerIfDue('https://backlog.test', 't', 1_000 + RECONCILE_BACKLOG_RETRY_MS - 1, backlog);
    expect(calls.n).toBe(1);
    await reconcileLedgerIfDue('https://backlog.test', 't', 1_000 + RECONCILE_BACKLOG_RETRY_MS, backlog);
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

  test('a session stored without a conversation is not in the ids, so it counts as missing', async () => {
    const got = await fetchServerSessions('https://example.test', 't', json({
      sessions: [{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }, { id: 'c', mtime: 3 }], deleted: [], empty: ['b'],
    }));
    expect([...got.ids].sort()).toEqual(['a', 'c']);
    const plan = planReconcile({ ledger: rows([['a', 1], ['b', 2], ['c', 3]]), serverIds: got.ids });
    expect(plan.queued).toEqual(['b']);
  });

  test('an error status throws, so a failed call is not an empty server', async () => {
    await expect(fetchServerSessions('https://example.test', 't', json({ error: 'x' }, 502))).rejects.toThrow('HTTP 502');
  });

  test('an answer that is not a session list throws', async () => {
    await expect(fetchServerSessions('https://example.test', 't', json({ ok: true }))).rejects.toThrow('session list');
  });
});
