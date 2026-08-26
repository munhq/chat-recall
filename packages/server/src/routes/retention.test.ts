/**
 * The user's own retention window, over /api/data/retention.
 *
 * This is the one setting that starts deleting a customer's data on a timer, so
 * what is pinned here is the shape of the guard rails, not the happy path:
 * 0 means keep everything (and is the default, so shipping the feature deletes
 * nothing), a window below the floor is refused rather than clamped, and the
 * value is per tenant.
 *
 * Clamping was the tempting alternative and it is wrong: a user who types 1
 * meaning "one day" and silently gets 7 has been told nothing, and a user who
 * typed it meaning "one year" has lost a year. A refusal with the bounds in the
 * message is the only answer that cannot quietly do the wrong thing.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRetentionDays, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS } from '../services/retention.js';

let dataDir: string;
let prevDataDir: string | undefined;

beforeAll(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-retention-test-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function makeApp(tenant?: string) {
  const router = (await import('./data-controls.js')).default;
  const app = express();
  if (tenant) app.use((req, _res, next) => { (req as express.Request & { tenant?: string }).tenant = tenant; next(); });
  app.use('/api/data', router);
  return app;
}

describe('parseRetentionDays', () => {
  test('0 clears the window', () => {
    expect(parseRetentionDays(0)).toBe(0);
    expect(parseRetentionDays('0')).toBe(0);
    expect(parseRetentionDays(null)).toBe(0);
  });

  test('a value inside the bounds is taken as given', () => {
    expect(parseRetentionDays(30)).toBe(30);
    expect(parseRetentionDays(MIN_RETENTION_DAYS)).toBe(MIN_RETENTION_DAYS);
    expect(parseRetentionDays(MAX_RETENTION_DAYS)).toBe(MAX_RETENTION_DAYS);
  });

  test('below the floor or above the ceiling is REFUSED, not clamped', () => {
    expect(parseRetentionDays(1)).toBeNull();
    expect(parseRetentionDays(MIN_RETENTION_DAYS - 1)).toBeNull();
    expect(parseRetentionDays(MAX_RETENTION_DAYS + 1)).toBeNull();
  });

  test('nonsense is refused rather than coerced to a window', () => {
    expect(parseRetentionDays('soon')).toBeNull();
    expect(parseRetentionDays(7.5)).toBeNull();
    expect(parseRetentionDays(-30)).toBeNull();
    expect(parseRetentionDays(undefined)).toBeNull();
    expect(parseRetentionDays({})).toBeNull();
  });
});

describe('/api/data/retention', () => {
  test('defaults to 0 — a fresh workspace keeps everything', async () => {
    const app = await makeApp('t-default');
    const res = await request(app).get('/api/data/retention');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(0);
    expect(res.body.min).toBe(MIN_RETENTION_DAYS);
    expect(res.body.max).toBe(MAX_RETENTION_DAYS);
  });

  test('set → read back', async () => {
    const app = await makeApp('t-set');
    expect((await request(app).post('/api/data/retention').send({ days: 90 })).status).toBe(200);
    expect((await request(app).get('/api/data/retention')).body.days).toBe(90);
  });

  test('0 clears a window that was set', async () => {
    const app = await makeApp('t-clear');
    await request(app).post('/api/data/retention').send({ days: 30 });
    expect((await request(app).post('/api/data/retention').send({ days: 0 })).status).toBe(200);
    expect((await request(app).get('/api/data/retention')).body.days).toBe(0);
  });

  test('an out-of-range window is a 400 and changes nothing', async () => {
    const app = await makeApp('t-bad');
    await request(app).post('/api/data/retention').send({ days: 90 });
    const bad = await request(app).post('/api/data/retention').send({ days: 2 });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain(String(MIN_RETENTION_DAYS));
    expect((await request(app).get('/api/data/retention')).body.days).toBe(90);
  });

  test('one tenant\'s window is invisible to another', async () => {
    await request(await makeApp('t-a')).post('/api/data/retention').send({ days: 14 });
    expect((await request(await makeApp('t-b')).get('/api/data/retention')).body.days).toBe(0);
    expect((await request(await makeApp('t-a')).get('/api/data/retention')).body.days).toBe(14);
  });

  test('the response carries the warning, and it names the conditional recovery', async () => {
    const app = await makeApp('t-warn');
    const res = await request(app).get('/api/data/retention');
    expect(res.body.warning).toContain('permanently');
    // The half that is easy to leave out, and the reason this test exists: the
    // recovery story is conditional on the transcript still being somewhere.
    expect(res.body.warning).toMatch(/machine you have/i);
    expect(res.body.warning).toMatch(/only copy/i);
  });

  test('a window that would delete nothing needs no acknowledgement', async () => {
    // An empty store has nothing older than 30 days, so this is the harmless
    // case — and demanding a ceremony here would train people to click through
    // the one that matters.
    const app = await makeApp('t-harmless');
    const res = await request(app).post('/api/data/retention').send({ days: 30 });
    expect(res.status).toBe(200);
    expect(res.body.wouldDelete).toBe(0);
  });

  test('?days= prices a CANDIDATE window without arming it', async () => {
    const app = await makeApp('t-preview');
    const res = await request(app).get('/api/data/retention?days=14');
    expect(res.status).toBe(200);
    expect(res.body.previewDays).toBe(14);
    expect(typeof res.body.wouldDelete).toBe('number');
    // Reading a preview must not change anything.
    expect((await request(app).get('/api/data/retention')).body.days).toBe(0);
  });

  test('clearing the window is never destructive, so it never asks', async () => {
    const app = await makeApp('t-clear2');
    await request(app).post('/api/data/retention').send({ days: 30 });
    const res = await request(app).post('/api/data/retention').send({ days: 0 });
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(0);
  });

  test('no tenant resolved → 401, never a silent global write', async () => {
    const app = await makeApp();
    expect((await request(app).get('/api/data/retention')).status).toBe(401);
    expect((await request(app).post('/api/data/retention').send({ days: 30 })).status).toBe(401);
  });
});
