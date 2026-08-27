/**
 * Free-tier search/list window — the routes clamp every search/list surface to
 * tenantLimits().searchWindowDays.
 *
 * The behaviour under protection:
 *   1. A free (lapsed) tenant sees only the last N days on /api/search,
 *      /api/memory/search, /api/memory/browse and /api/conversations/recent —
 *      and the response says so (`window_days`, plus `locked_older` where the
 *      count is cheap), because the locked history is the upgrade offer.
 *   2. An entitled tenant's responses are unchanged — no window keys, no
 *      missing rows. The paid path must stay byte-for-byte what it is today.
 *   3. A caller's own NARROWER time filter survives the clamp.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The routes resolve the window through tenantLimits(); the tests flip it here.
// Everything else in util/billing.js stays real.
const limitsState = vi.hoisted(() => ({ searchWindowDays: null as number | null }));
vi.mock('../util/billing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util/billing.js')>();
  return {
    ...actual,
    tenantLimits: async () => ({
      searchWindowDays: limitsState.searchWindowDays,
      syncBytesPerMonth: null,
      syncStorageBytes: null,
      summaries: true,
      embeddings: true,
      rateMultiplier: 1,
    }),
    // The routes moved to the shared searchWindow() helper; the real one calls
    // the real tenantLimits internally (module-internal reference, unmockable
    // from here), so it must be shimmed to read the same test state.
    searchWindow: async () => (typeof limitsState.searchWindowDays === 'number'
      ? { days: limitsState.searchWindowDays, floorMs: Date.now() - limitsState.searchWindowDays * 86_400_000 }
      : { days: null }),
  };
});

import searchRouter from './search.js';
import memoryRouter from './memory.js';
import conversationsRouter from './conversations.js';
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '@chat-recall/engine/test-support/home-env.js';

const DAY = 86_400_000;
const NOW = Date.now();
// A token no other seed uses, so FTS matches exactly these three sessions.
const KEYWORD = 'zorbofrangwindow';
const RECENT_ID = 'win-recent-1h';   // inside any window
const MID_ID = 'win-mid-3d';         // inside a 7-day window, outside 48h
const OLD_ID = 'win-old-30d';        // behind a 7-day window

let tmpHome: string;
const origHome = homeEnvSnapshot();
const origDataDir = process.env.CHAT_RECALL_DATA_DIR;
let app: Express;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'win-route-'));
  useHomeDir(tmpHome);
  // Pin the engine data dir so seeding via createStore and the routes'
  // per-request createStore() resolve the same sqlite file.
  process.env.CHAT_RECALL_DATA_DIR = join(tmpHome, '.chat-recall');
  app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);
  app.use('/api/memory', memoryRouter);
  app.use('/api/conversations', conversationsRouter);

  // Seed three sessions at three ages, each carrying the probe keyword.
  const { createStore } = await import('../imports.js');
  const store = await createStore();
  try {
    for (const [id, mtime] of [
      [RECENT_ID, NOW - 3_600_000],
      [MID_ID, NOW - 3 * DAY],
      [OLD_ID, NOW - 30 * DAY],
    ] as Array<[string, number]>) {
      await store.setItem({
        id,
        sourceType: 'session',
        title: `Window probe ${id}`,
        projectPath: '/home/u/code/winproj',
        projectId: 'git:github.com/u/winproj',
        filePath: '',
        mtime,
        contentPreview: `discussing ${KEYWORD}`,
      });
      await store.addChunksFTS([
        {
          chunkId: `${id}:user:0`, itemId: id, sourceType: 'session',
          title: `Window probe ${id}`, text: `we discussed the ${KEYWORD} rollout`,
          chunkType: 'user', projectPath: '/home/u/code/winproj', filePath: '', mtime,
        },
      ]);
    }
  } finally {
    await store.close();
  }
});

beforeEach(() => {
  limitsState.searchWindowDays = null;
});

afterAll(() => {
  restoreHomeEnv(origHome);
  if (origDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = origDataDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('POST /api/search — session search window', () => {
  test('entitled tenant: all matches, no window keys in the response', async () => {
    const res = await request(app).post('/api/search').send({ query: KEYWORD });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { sessionId: string }) => r.sessionId).sort())
      .toEqual([MID_ID, RECENT_ID, OLD_ID].sort());
    // Paid shape unchanged: the keys must be ABSENT, not null.
    expect(res.body).not.toHaveProperty('window_days');
    expect(res.body).not.toHaveProperty('locked_older');
  });

  test('free tenant: results clamped to the window, locked_older counts the rest', async () => {
    limitsState.searchWindowDays = 7;
    const res = await request(app).post('/api/search').send({ query: KEYWORD });
    expect(res.status).toBe(200);
    const ids = res.body.results.map((r: { sessionId: string }) => r.sessionId);
    expect(ids.sort()).toEqual([MID_ID, RECENT_ID].sort());
    expect(res.body.window_days).toBe(7);
    expect(res.body.locked_older).toBe(1);
  });
});

describe('POST /api/memory/search — unified search window', () => {
  test('entitled tenant: all matches, no window keys', async () => {
    const res = await request(app).post('/api/memory/search').send({ query: KEYWORD });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body).not.toHaveProperty('window_days');
    expect(res.body).not.toHaveProperty('locked_older');
  });

  test('free tenant: windowed, with window_days + locked_older', async () => {
    limitsState.searchWindowDays = 7;
    const res = await request(app).post('/api/memory/search').send({ query: KEYWORD });
    expect(res.status).toBe(200);
    const ids = res.body.results.map((r: { itemId: string }) => r.itemId);
    expect(ids.sort()).toEqual([MID_ID, RECENT_ID].sort());
    expect(res.body.window_days).toBe(7);
    expect(res.body.locked_older).toBe(1);
  });
});

describe('GET /api/memory/browse — list window', () => {
  test('entitled tenant: all items, no window key', async () => {
    const res = await request(app).get('/api/memory/browse/session');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body).not.toHaveProperty('window_days');
  });

  test('free tenant: only items inside the window, window_days present', async () => {
    limitsState.searchWindowDays = 7;
    const res = await request(app).get('/api/memory/browse/session');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids.sort()).toEqual([MID_ID, RECENT_ID].sort());
    expect(res.body.window_days).toBe(7);
  });
});

describe('GET /api/conversations/recent — feed window', () => {
  test('entitled tenant: full history, no window keys', async () => {
    const res = await request(app).get('/api/conversations/recent');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body).not.toHaveProperty('window_days');
    expect(res.body).not.toHaveProperty('locked_older');
  });

  test('free tenant: feed clamped, locked_older counts the sessions behind it', async () => {
    limitsState.searchWindowDays = 7;
    const res = await request(app).get('/api/conversations/recent');
    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: { sessionId: string }) => s.sessionId);
    expect(ids.sort()).toEqual([MID_ID, RECENT_ID].sort());
    expect(res.body.total).toBe(2);
    expect(res.body.window_days).toBe(7);
    expect(res.body.locked_older).toBe(1);
  });

  test('free tenant: a NARROWER caller since_hours survives the clamp', async () => {
    limitsState.searchWindowDays = 7;
    const res = await request(app).get('/api/conversations/recent?since_hours=48');
    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: { sessionId: string }) => s.sessionId);
    // 48h is narrower than 7d: only the 1h-old session qualifies, and the
    // window itself locked nothing the caller asked for.
    expect(ids).toEqual([RECENT_ID]);
    expect(res.body.window_days).toBe(7);
    expect(res.body.locked_older).toBe(0);
  });

  test('entitled tenant: caller since_hours still works untouched', async () => {
    const res = await request(app).get('/api/conversations/recent?since_hours=48');
    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: { sessionId: string }) => s.sessionId);
    expect(ids).toEqual([RECENT_ID]);
    expect(res.body).not.toHaveProperty('window_days');
  });
});
