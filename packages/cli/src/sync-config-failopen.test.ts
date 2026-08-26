/**
 * The server-side sync rules must never be treated as "empty" because a request
 * failed.
 *
 * `fetchTenantSyncConfig` returned an empty rule set on ANY non-2xx or network
 * error, and the sync then proceeded with local rules only. A five-second blip
 * therefore uploaded the projects a dashboard exclusion exists to hold back, and
 * nothing said so — the rules were still sitting in the dashboard looking
 * applied. This pins the three outcomes that replaced it:
 *
 *   404          → empty, because that IS the answer from a server without the
 *                  endpoint. Older self-hosted servers must keep syncing.
 *   5xx/network, with a remembered set   → reuse it, and say so.
 *   5xx/network, with nothing remembered → refuse the sync.
 *
 * The refusal is the load-bearing case. It is recoverable (re-run) whereas an
 * upload is not, and it is the only behaviour that cannot silently ship data the
 * user excluded.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir = '';
let prevDataDir: string | undefined;

/** A stand-in for the endpoint, so no server is needed. */
function stubFetch(handler: (url: string) => { status: number; body?: unknown } | 'throw') {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    const r = handler(url);
    if (r === 'throw') throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

beforeEach(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-failopen-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const RULES = {
  excludeTools: ['gemini'],
  excludeProjects: ['/work/client'],
  excludeSources: [],
  approveSources: [],
};

/** The in-memory cache is module state, and the point of several of these cases
 *  is what happens with NOTHING in it — so each one starts by clearing it. The
 *  module exports the reset for exactly this reason; reloading the module would
 *  work too and is slower. */
async function loadClient() {
  const mod = await import('./sync-client.js');
  mod._resetTenantSyncConfigCache();
  return mod;
}

describe('server-side sync rules under failure', () => {
  test('a 404 yields empty rules — an older server keeps syncing', async () => {
    const restore = stubFetch(() => ({ status: 404 }));
    try {
      const { _fetchTenantSyncConfigForTests } = await loadClient();
      const cfg = await _fetchTenantSyncConfigForTests({ serverUrl: 'http://s1', token: 't' });
      expect(cfg.excludeProjects).toEqual([]);
      expect(cfg.excludeTools).toEqual([]);
    } finally { restore(); }
  });

  test('a success is remembered ON DISK, so the next PROCESS can fall back to it', async () => {
    const restore = stubFetch((url) => (url.includes('/api/sync-config/sources')
      ? { status: 200 }
      : { status: 200, body: RULES }));
    try {
      const { _fetchTenantSyncConfigForTests } = await loadClient();
      const cfg = await _fetchTenantSyncConfigForTests({ serverUrl: 'http://s2', token: 't' });
      expect(cfg.excludeProjects).toEqual(['/work/client']);

      const cachePath = join(dataDir, 'sync-config-cache.json');
      expect(existsSync(cachePath)).toBe(true);
      const persisted = JSON.parse(readFileSync(cachePath, 'utf-8'));
      expect(persisted['http://s2'].config.excludeProjects).toEqual(['/work/client']);
    } finally { restore(); }
  });

  test('a 500 after a success REUSES the remembered rules instead of emptying them', async () => {
    const ok = stubFetch((url) => (url.includes('/sources') ? { status: 200 } : { status: 200, body: RULES }));
    const { _fetchTenantSyncConfigForTests } = await loadClient();
    await _fetchTenantSyncConfigForTests({ serverUrl: 'http://s3', token: 't' });
    ok();

    // Memory cleared: only the file on disk can answer now, which is the state a
    // fresh `chat-recall sync` process starts in.
    const restore = stubFetch(() => ({ status: 500 }));
    try {
      const fresh = await loadClient();
      const cfg = await fresh._fetchTenantSyncConfigForTests({ serverUrl: 'http://s3', token: 't' });
      expect(cfg.excludeProjects).toEqual(['/work/client']);
      expect(cfg.excludeTools).toEqual(['gemini']);
    } finally { restore(); }
  });

  test('a network error with NOTHING remembered REFUSES rather than uploading blind', async () => {
    const restore = stubFetch(() => 'throw');
    try {
      const { _fetchTenantSyncConfigForTests } = await loadClient();
      await expect(_fetchTenantSyncConfigForTests({ serverUrl: 'http://s4', token: 't' }))
        .rejects.toThrow(/Refusing to sync/);
    } finally { restore(); }
  });

  test('a 500 with nothing remembered refuses too — not just a dropped socket', async () => {
    const restore = stubFetch(() => ({ status: 503 }));
    try {
      const { _fetchTenantSyncConfigForTests } = await loadClient();
      await expect(_fetchTenantSyncConfigForTests({ serverUrl: 'http://s5', token: 't' }))
        .rejects.toThrow(/Refusing to sync/);
    } finally { restore(); }
  });
});
