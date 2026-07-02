/**
 * Unit tests for the synthetic-tenant retention sweep.
 *
 * The invariants that matter:
 *  1. Stale sessions of an allowlisted synthetic tenant are purged.
 *  2. Fresh sessions of the same tenant survive (the probe keeps working).
 *  3. The sweep NEVER touches tenants outside the allowlist — real paying
 *     tenants must be structurally unreachable from this code path.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpDir: string;
const orig = {
  dataDir: process.env.CHAT_RECALL_DATA_DIR,
  storage: process.env.CHAT_RECALL_STORAGE,
  tenants: process.env.SYNTHETIC_TENANTS,
  days: process.env.SYNTHETIC_RETENTION_DAYS,
};

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'retention-'));
  process.env.CHAT_RECALL_DATA_DIR = tmpDir;
  process.env.CHAT_RECALL_STORAGE = 'sqlite';
  process.env.SYNTHETIC_TENANTS = 'synccheck';
  process.env.SYNTHETIC_RETENTION_DAYS = '7';
});

afterAll(() => {
  for (const [k, v] of [
    ['CHAT_RECALL_DATA_DIR', orig.dataDir],
    ['CHAT_RECALL_STORAGE', orig.storage],
    ['SYNTHETIC_TENANTS', orig.tenants],
    ['SYNTHETIC_RETENTION_DAYS', orig.days],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seedSession(id: string, mtime: number): Promise<void> {
  const { createStore } = await import('@chat-recall/engine');
  const store = await createStore();
  try {
    await store.setItem({
      id,
      sourceType: 'session',
      title: `probe ${id}`,
      projectPath: '/tmp/probe',
      filePath: '',
      mtime,
      contentPreview: 'synthetic probe session',
    });
  } finally {
    await store.close();
  }
}

async function sessionExists(id: string): Promise<boolean> {
  const { createStore } = await import('@chat-recall/engine');
  const store = await createStore();
  try {
    return (await store.getItem(id, 'session')) != null;
  } finally {
    await store.close();
  }
}

describe('sweepSyntheticRetention', () => {
  test('purges stale probe sessions, keeps fresh ones', async () => {
    const { sweepSyntheticRetention } = await import('./retention.js');
    const now = Date.now();
    const staleMtime = now - 30 * 24 * 60 * 60 * 1000; // 30d old
    await seedSession('probe-stale-1', staleMtime);
    await seedSession('probe-stale-2', staleMtime);
    await seedSession('probe-fresh-1', now);

    const results = await sweepSyntheticRetention();
    const synccheck = results.find(r => r.tenant === 'synccheck');
    expect(synccheck?.purged).toBe(2);

    expect(await sessionExists('probe-stale-1')).toBe(false);
    expect(await sessionExists('probe-stale-2')).toBe(false);
    expect(await sessionExists('probe-fresh-1')).toBe(true);
  });

  test('batch cap bounds work per tick and the next tick continues', async () => {
    const { sweepSyntheticRetention } = await import('./retention.js');
    const staleMtime = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) await seedSession(`probe-batch-${i}`, staleMtime);

    const first = await sweepSyntheticRetention({ batchPerTenant: 3 });
    expect(first.find(r => r.tenant === 'synccheck')?.purged).toBe(3);
    const second = await sweepSyntheticRetention({ batchPerTenant: 3 });
    expect(second.find(r => r.tenant === 'synccheck')?.purged).toBe(2);
  });

  test('tenant allowlist is explicit — no synthetic tenants configured, nothing purged', async () => {
    process.env.SYNTHETIC_TENANTS = '';
    try {
      const { sweepSyntheticRetention } = await import('./retention.js');
      const staleMtime = Date.now() - 30 * 24 * 60 * 60 * 1000;
      await seedSession('probe-protected', staleMtime);
      const results = await sweepSyntheticRetention();
      expect(results).toEqual([]);
      expect(await sessionExists('probe-protected')).toBe(true);
    } finally {
      process.env.SYNTHETIC_TENANTS = 'synccheck';
    }
  });
});
