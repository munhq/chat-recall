/**
 * A recheck whose every push failed must ack 'error'.
 *
 * repairSession returned 'repaired' after a failed push and recorded it as
 * before == after, and runIntent acks 'done' for anything but 'error'. On
 * 2026-09-11, 17 rechecks acked 'done' with every push at 0 → 0. The server
 * asks about each transcript version once, so that ack is the only record.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const SERVER = 'https://recall.example.com';
const SID = '11111111-2222-3333-4444-555555555555';

vi.mock('@chat-recall/engine/transcript/index.js', () => ({
  readShadowContainer: () => ({ files: [], mtime: 1_700_000_000_000 }),
  parseTranscriptFromContainer: () => ({ messages: new Array(5).fill({}) }),
  gunzipContainer: () => null,
  seedShadow: () => {},
}));
vi.mock('@chat-recall/engine/core/tool-backend.js', async (importOriginal) => {
  const backend = { id: 'claude', toRawId: (x: string) => x, findSession: () => null };
  return { ...(await importOriginal<object>()), getBackendForId: () => backend, getBackend: () => backend };
});
vi.mock('@chat-recall/engine/core/settings.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadSettings: () => ({ sync: { endpoint: SERVER, pathsCleartext: false } }),
}));
vi.mock('./sync-client.js', () => ({
  loadAllCredentials: () => [{ serverUrl: SERVER, token: 'tok' }],
  buildConversationSync: async () => ({ conv: { envelope: { messages: new Array(5).fill({}) } } }),
  syncIncremental: async () => {},
}));
vi.mock('./project-tasks.js', () => ({ pushProjectTaskStatuses: async () => {} }));

/** What POST /api/sync does in this test. */
let pushOutcome: 'ok' | 'http500' | 'throw';
const acks: Array<{ status: string; result: string }> = [];

vi.mock('./http.js', () => ({
  fetchWithTimeout: async (url: string, init: { method?: string; body?: string } = {}) => {
    if (url.endsWith('/api/sync')) {
      if (pushOutcome === 'throw') throw new Error('The operation was aborted due to timeout');
      return { ok: pushOutcome === 'ok', status: pushOutcome === 'ok' ? 200 : 500 };
    }
    if (url.endsWith('/api/sync-intents/pending')) {
      return {
        ok: true, status: 200,
        json: async () => ({ intents: [{ id: 'si_1', kind: 'recheck_session', name: SID, artifact_type: null, from_tool: null, to_tool: null }], cli: null }),
      };
    }
    if (url.includes('/api/sync-intents/si_1/ack')) {
      acks.push(JSON.parse(init.body ?? '{}'));
      return { ok: true, status: 200 };
    }
    throw new Error(`unexpected fetchWithTimeout ${url}`);
  },
}));

/** fetchJson in repair.ts uses the global fetch: the server holds 2 messages, no archive. */
let serverMessages = 2;
globalThis.fetch = (async (url: string) => {
  if (String(url).includes('/raw-archive')) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ messages: new Array(serverMessages).fill({}) }) };
}) as unknown as typeof fetch;

beforeEach(() => { acks.length = 0; serverMessages = 2; });

describe('repairSession reports a push that did not land', () => {
  test('every push HTTP 500 → status error, with the reason kept', async () => {
    pushOutcome = 'http500';
    const { repairSession } = await import('./repair.js');
    const r = await repairSession(SID, { server: SERVER });
    expect(r.status).toBe('error');
    expect(r.pushed).toEqual([{ server: SERVER, before: 2, after: 2, error: 'HTTP 500' }]);
    expect(r.note).toContain('HTTP 500');
  });

  test('a push that throws → status error', async () => {
    pushOutcome = 'throw';
    const { repairSession } = await import('./repair.js');
    const r = await repairSession(SID, { server: SERVER });
    expect(r.status).toBe('error');
    expect(r.pushed[0].error).toContain('timeout');
  });

  test('a push that lands → status repaired, no error on the entry', async () => {
    pushOutcome = 'ok';
    const { repairSession } = await import('./repair.js');
    const r = await repairSession(SID, { server: SERVER });
    expect(r.status).toBe('repaired');
    expect(r.pushed[0].error).toBeUndefined();
  });
});

describe('the recheck ack carries the repair outcome', () => {
  test('a recheck whose push failed acks error', async () => {
    pushOutcome = 'http500';
    const { drainSyncIntents } = await import('./intent-drain.js');
    const out = await drainSyncIntents();
    expect(out).toMatchObject({ processed: 1, done: 0, errored: 1 });
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('error');
    expect(JSON.parse(acks[0].result).pushed[0].error).toBe('HTTP 500');
  });

  test('a recheck whose push landed acks done', async () => {
    pushOutcome = 'ok';
    const { drainSyncIntents } = await import('./intent-drain.js');
    await drainSyncIntents();
    expect(acks.map((a) => a.status)).toEqual(['done']);
  });
});
