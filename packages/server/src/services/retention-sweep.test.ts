/**
 * The retention window against REAL rows: the count, the acknowledgement gate,
 * and the sweep that does the deleting.
 *
 * retention.test.ts pins the route's guard rails, but every case there runs on an
 * empty store — so nothing is ever destructive there, and the one branch that
 * matters (a change that WOULD delete something must be acknowledged) is never
 * reached. That branch is the whole safety design, so it is exercised here with
 * sessions actually stored, at ages chosen either side of the window.
 */
import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithTenant } from '@chat-recall/engine/core/store/tenant-context.js';
import { countOlderThan, sweepUserRetention, setRetentionDays, RETENTION_WARNING } from './retention.js';

let dataDir = '';
let prevDataDir: string | undefined;
const DAY = 24 * 60 * 60 * 1000;

/* A FRESH store per test. The sqlite driver these tests run on is the unit-test
 * backend and does not enforce tenant isolation — that is Postgres RLS in
 * production — so seeds from one case would otherwise be counted by the next,
 * and every count assertion here would be reading other tests' rows. */
beforeEach(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-retention-sweep-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

/** Store one session for `tenant`, aged `ageDays` days. */
async function seed(tenant: string, id: string, ageDays: number): Promise<void> {
  const { createStore } = await import('../imports.js');
  await runWithTenant(tenant, async () => {
    const store = await createStore();
    try {
      await store.setItem({
        id,
        sourceType: 'session',
        title: `session ${id}`,
        projectPath: '/work/app',
        filePath: '',
        mtime: Date.now() - ageDays * DAY,
        contentPreview: 'hello',
      });
    } finally {
      await store.close();
    }
  });
}

async function countSessions(tenant: string): Promise<number> {
  const { createStore } = await import('../imports.js');
  return runWithTenant(tenant, async () => {
    const store = await createStore();
    try {
      let n = 0;
      for (let offset = 0; ; offset += 200) {
        const page = await store.listItems('session', 200, offset);
        n += page.length;
        if (page.length < 200) break;
      }
      return n;
    } finally {
      await store.close();
    }
  });
}

async function makeApp(tenant: string) {
  const router = (await import('../routes/data-controls.js')).default;
  const app = express();
  app.use((req, _res, next) => { (req as express.Request & { tenant?: string }).tenant = tenant; next(); });
  app.use('/api/data', router);
  return app;
}

describe('countOlderThan', () => {
  beforeEach(async () => {
    await seed('rt-count', 'old-1', 100);
    await seed('rt-count', 'old-2', 60);
    await seed('rt-count', 'fresh-1', 2);
  });

  test('counts only what falls outside the window', async () => {
    expect(await countOlderThan('rt-count', 30)).toBe(2);
    expect(await countOlderThan('rt-count', 90)).toBe(1);
    expect(await countOlderThan('rt-count', 365)).toBe(0);
  });

  test('a window of 0 counts nothing — "keep everything" is not "delete everything"', async () => {
    // The inverse would be catastrophic: 0 is the DEFAULT for every workspace.
    expect(await countOlderThan('rt-count', 0)).toBe(0);
  });
});

describe('the acknowledgement gate, on a store that actually holds sessions', () => {
  test('a destructive window is REFUSED with 409, the count, and the warning', async () => {
    await seed('rt-ack', 'ancient', 400);
    const app = await makeApp('rt-ack');

    const res = await request(app).post('/api/data/retention').send({ days: 30 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('acknowledgement required');
    expect(res.body.wouldDelete).toBe(1);
    expect(res.body.warning).toBe(RETENTION_WARNING);

    // And it changed NOTHING — a refused request must not half-apply.
    expect((await request(app).get('/api/data/retention')).body.days).toBe(0);
  });

  test('the same request with acknowledge:true is accepted', async () => {
    await seed('rt-ack2', 'ancient', 400);
    const app = await makeApp('rt-ack2');

    const res = await request(app).post('/api/data/retention').send({ days: 30, acknowledge: true });
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    expect(res.body.wouldDelete).toBe(1);
    expect((await request(app).get('/api/data/retention')).body.days).toBe(30);
  });

  test('acknowledge is not a magic word for an invalid window', async () => {
    await seed('rt-ack3', 'ancient', 400);
    const app = await makeApp('rt-ack3');
    const res = await request(app).post('/api/data/retention').send({ days: 1, acknowledge: true });
    expect(res.status).toBe(400);
  });
});

describe('sweepUserRetention', () => {
  test('deletes what is outside the window and leaves the rest', async () => {
    await seed('rt-sweep', 'old-a', 200);
    await seed('rt-sweep', 'old-b', 120);
    await seed('rt-sweep', 'recent', 3);
    await setRetentionDays('rt-sweep', 30);

    const results = await sweepUserRetention({ tenants: ['rt-sweep'] });
    const mine = results.find((r) => r.tenant === 'rt-sweep');
    expect(mine?.purged).toBe(2);
    expect(await countSessions('rt-sweep')).toBe(1);
  });

  test('a tenant with no window set is untouched — the default deletes nothing', async () => {
    await seed('rt-nowindow', 'ancient', 900);
    await sweepUserRetention({ tenants: ['rt-nowindow'] });
    expect(await countSessions('rt-nowindow')).toBe(1);
  });

  test('the sweep is idempotent — a second pass finds nothing left to do', async () => {
    await seed('rt-idem', 'old', 200);
    await setRetentionDays('rt-idem', 30);
    await sweepUserRetention({ tenants: ['rt-idem'] });
    const second = await sweepUserRetention({ tenants: ['rt-idem'] });
    expect(second.find((r) => r.tenant === 'rt-idem')?.purged).toBe(0);
  });

  test('NO TOMBSTONE is written, so widening the window can re-admit a re-synced session', async () => {
    // The difference from a manual delete, asserted rather than assumed: a
    // tombstone here would make a retention window permanent for every session
    // it ever touched, and re-syncing after widening it would silently do
    // nothing. Re-seeding stands in for that re-sync.
    await seed('rt-notomb', 'old', 200);
    await setRetentionDays('rt-notomb', 30);
    await sweepUserRetention({ tenants: ['rt-notomb'] });
    expect(await countSessions('rt-notomb')).toBe(0);

    await setRetentionDays('rt-notomb', 0);
    await seed('rt-notomb', 'old', 200);
    expect(await countSessions('rt-notomb')).toBe(1);
  });
});
