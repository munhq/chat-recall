/**
 * Bulk delete is the one operation in the CLI with no undo, so the things
 * tested here are the ones whose failure is silent: a selector that quietly
 * matches nothing, a partial delete reported as a whole one, and a second
 * server whose failure is hidden by the first server's success.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { selectSessions, bulkDelete, listTombstones, restoreSessions, BATCH } from './bulk-delete.js';

vi.mock('./sync-ledger.js', () => ({
  getLedgerData: vi.fn(() => ({})),
  persistLedgerData: vi.fn(),
}));

const TARGET = { serverUrl: 'https://example.test/', token: 't0k' };

/** A fake `/api/conversations/recent` over a fixed row set. */
function listing(rows: Array<{ sessionId: string; firstPrompt?: string; projectId?: string }>) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset'));
    const project = u.searchParams.get('project');
    const scoped = project ? rows.filter((r) => r.projectId === project) : rows;
    return {
      ok: true,
      json: async () => ({ sessions: scoped.slice(offset, offset + limit) }),
    } as unknown as Response;
  });
}

describe('selectSessions', () => {
  beforeEach(() => vi.clearAllMocks());

  test('walks every page instead of trusting the first one', async () => {
    // Rows come back newest-first, so a filter matching only OLD sessions finds
    // nothing on page 0. Stopping there is how a delete reports "0 matched" on a
    // project that has hundreds — the exact bug /api/data/delete had to fix.
    const rows = Array.from({ length: 450 }, (_, i) => ({
      sessionId: `s${i}`, projectId: 'git:x/y', firstPrompt: i >= 400 ? 'models' : 'real work',
    }));
    const got = await selectSessions(TARGET, { project: 'git:x/y', match: 'models' }, listing(rows));
    expect(got).toHaveLength(50);
    expect(got.every((r) => r.firstPrompt === 'models')).toBe(true);
  });

  test('--match is exact, not a substring', async () => {
    const rows = [
      { sessionId: 'a', projectId: 'p', firstPrompt: 'models' },
      { sessionId: 'b', projectId: 'p', firstPrompt: 'models are great' },
      { sessionId: 'c', projectId: 'p', firstPrompt: 'what models exist' },
      { sessionId: 'd', projectId: 'p', firstPrompt: '  models  ' }, // trimmed
    ];
    const got = await selectSessions(TARGET, { project: 'p', match: 'models' }, listing(rows));
    expect(got.map((r) => r.sessionId)).toEqual(['a', 'd']);
  });

  test('no match selects nothing rather than everything', async () => {
    // A selector that silently degrades to "all rows" would delete a project.
    const rows = [{ sessionId: 'a', projectId: 'p', firstPrompt: 'real work' }];
    expect(await selectSessions(TARGET, { project: 'p', match: 'models' }, listing(rows))).toEqual([]);
  });

  test('a failed listing throws instead of returning an empty selection', async () => {
    const boom = vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response);
    await expect(selectSessions(TARGET, { project: 'p' }, boom)).rejects.toThrow(/503/);
  });
});

describe('bulkDelete', () => {
  beforeEach(() => vi.clearAllMocks());

  test('ships tombstones — not N deletes — and batches them', async () => {
    const seen: string[][] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://example.test/api/sync');
      const body = JSON.parse(String(init?.body)) as { tombstones: Array<{ session_id: string }> };
      seen.push(body.tombstones.map((t) => t.session_id));
      return { ok: true, json: async () => ({}) } as unknown as Response;
    });

    const ids = Array.from({ length: BATCH + 7 }, (_, i) => `s${i}`);
    const res = await bulkDelete(ids, { targets: [TARGET], fetchImpl: f });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toHaveLength(BATCH);
    expect(seen[1]).toHaveLength(7);
    expect(res.deleted).toBe(ids.length);
  });

  test('duplicate ids are collapsed', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    const res = await bulkDelete(['a', 'a', 'b', '', 'b'], { targets: [TARGET], fetchImpl: f });
    expect(res.requested).toBe(2);
    expect(res.deleted).toBe(2);
  });

  test('one server failing does not hide the other succeeding', async () => {
    const good = { serverUrl: 'https://good.test', token: 'g' };
    const bad = { serverUrl: 'https://bad.test', token: 'b' };
    const f = vi.fn(async (url: string | URL | Request) => (
      String(url).includes('bad.test')
        ? { ok: false, status: 500 } as unknown as Response
        : { ok: true, json: async () => ({}) } as unknown as Response
    ));

    const res = await bulkDelete(['s1', 's2'], { targets: [good, bad], fetchImpl: f });

    expect(res.perTarget['https://good.test'].deleted).toBe(2);
    expect(res.perTarget['https://bad.test'].error).toMatch(/500/);
    // Deleted somewhere is still deleted — the caller is told which copies stand.
    expect(res.deleted).toBe(2);
  });

  test('a mid-run failure reports what actually landed, not the whole request', async () => {
    let call = 0;
    const f = vi.fn(async () => (++call === 1
      ? { ok: true, json: async () => ({}) } as unknown as Response
      : { ok: false, status: 502 } as unknown as Response));

    const ids = Array.from({ length: BATCH + 5 }, (_, i) => `s${i}`);
    const res = await bulkDelete(ids, { targets: [TARGET], fetchImpl: f });

    expect(res.perTarget[TARGET.serverUrl].deleted).toBe(BATCH);
    expect(res.perTarget[TARGET.serverUrl].error).toMatch(/502/);
    expect(res.deleted).toBe(BATCH);      // NOT ids.length
  });

  test('an empty id list touches no server', async () => {
    const f = vi.fn();
    const res = await bulkDelete([], { targets: [TARGET], fetchImpl: f });
    expect(f).not.toHaveBeenCalled();
    expect(res.deleted).toBe(0);
  });
});

/**
 * Restore is what keeps bulk delete from being a trapdoor. The failure that
 * matters is a restore that REPORTS success without lifting anything — the
 * user then re-syncs, the server silently refuses, and the data stays gone
 * with no error anywhere.
 */
describe('restore', () => {
  beforeEach(() => vi.clearAllMocks());

  test('lists deletions newest first so ids are discoverable', async () => {
    const f = vi.fn(async () => ({
      ok: true,
      json: async () => ({ total: 2, tombstones: [
        { session_id: 'new', deleted_at: 2000 },
        { session_id: 'old', deleted_at: 1000 },
      ] }),
    }) as unknown as Response);
    const got = await listTombstones(TARGET, 50, f);
    expect(got.total).toBe(2);
    expect(got.tombstones[0].session_id).toBe('new');
  });

  test('lifts tombstones and counts only what was actually deleted here', async () => {
    const f = vi.fn(async (_u: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { session_ids: string[] };
      // 'ghost' was never deleted on this server.
      const real = body.session_ids.filter((i) => i !== 'ghost');
      return { ok: true, json: async () => ({ restored: real.length, notDeleted: ['ghost'] }) } as unknown as Response;
    });
    const res = await restoreSessions(['a', 'b', 'ghost'], { targets: [TARGET], fetchImpl: f });
    expect(res.restored).toBe(2);
    expect(res.perTarget[TARGET.serverUrl].notDeleted).toBe(1);
  });

  test('a server error is surfaced, not counted as a restore', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    const res = await restoreSessions(['a'], { targets: [TARGET], fetchImpl: f });
    expect(res.restored).toBe(0);
    expect(res.perTarget[TARGET.serverUrl].error).toMatch(/500/);
  });

  test('restoring ids that were never deleted reports zero, not success', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ restored: 0, notDeleted: ['x'] }) }) as unknown as Response);
    const res = await restoreSessions(['x'], { targets: [TARGET], fetchImpl: f });
    expect(res.restored).toBe(0);
  });

  test('delete then restore is a round trip through the same id set', async () => {
    const dead = new Set<string>();
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (String(url).endsWith('/api/sync')) {
        for (const t of body.tombstones) dead.add(t.session_id);
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      const hit = (body.session_ids as string[]).filter((i) => dead.has(i));
      for (const i of hit) dead.delete(i);
      return { ok: true, json: async () => ({ restored: hit.length, notDeleted: [] }) } as unknown as Response;
    });

    await bulkDelete(['s1', 's2'], { targets: [TARGET], fetchImpl: f });
    expect([...dead].sort()).toEqual(['s1', 's2']);
    const res = await restoreSessions(['s1', 's2'], { targets: [TARGET], fetchImpl: f });
    expect(res.restored).toBe(2);
    expect(dead.size).toBe(0);
  });
});
