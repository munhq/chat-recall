/**
 * The policy route — the knobs that decide what lands on the board.
 *
 * They arrived piecemeal: a UI-only severity select, then two constants nobody
 * could change, then a category filter and a never-file list. The route is where
 * they all have to agree, and it had no test at all — which is how `ceiling: 0`
 * reached a response body that a client would have written straight back.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const settings = new Map<string, string>();
let statusThrows = false;

vi.mock('../imports.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createControlPlane: async () => ({
    getTenantSetting: async (_t: string, k: string) => settings.get(k) ?? null,
    setTenantSetting: async (_t: string, k: string, v: string) => { settings.set(k, v); },
    close: async () => {},
  }),
  createStore: async () => {
    if (statusThrows) throw new Error('findings tables unreadable');
    return {
      listCodeActions: async () => [],
      teamTasksByFindingIds: async () => [],
      codeFindingsSummary: async () => ({ total: 0, bySeverity: {}, byCategory: {} }),
      close: async () => {},
    };
  },
}));

const { default: tasksRouter } = await import('./tasks.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as never as { tenant: string; userId: string }).tenant = 't1';
    (req as never as { userId: string }).userId = 'alice';
    next();
  });
  a.use('/api/tasks', tasksRouter);
  return a;
}

const put = (body: Record<string, unknown>) => request(app()).put('/api/tasks/policy').send(body);

beforeEach(() => { settings.clear(); statusThrows = false; });

describe('setting the policy', () => {
  test('every knob round-trips', async () => {
    const r = await put({
      enabled: true, maxPri: 2, ceiling: 120, maxPerRun: 25,
      categories: ['security', 'Clone'], excludedProjects: ['git:h/o/client'],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enabled: true, maxPri: 2, ceiling: 120, maxPerRun: 25,
      categories: ['security', 'clone'],            // normalised to lower case
      excludedProjects: ['git:h/o/client'],
    });
  });

  test('a partial write keeps the knobs it does not mention', async () => {
    await put({ enabled: true, maxPri: 1, ceiling: 200, excludedProjects: ['p_client'] });
    const r = await put({ enabled: true, maxPri: 3 });
    expect(r.body.ceiling).toBe(200);
    expect(r.body.excludedProjects).toEqual(['p_client']);
  });

  test('out-of-range numbers clamp rather than 400 — an old client should degrade', async () => {
    const hi = await put({ enabled: true, maxPri: 9, ceiling: 99999, maxPerRun: 0 });
    expect(hi.body.maxPri).toBe(3);
    expect(hi.body.ceiling).toBe(1000);
    expect(hi.body.maxPerRun).toBe(1);
  });

  test('an empty category list means ALL categories, not none', async () => {
    await put({ enabled: true, maxPri: 1, categories: ['security'] });
    const r = await put({ enabled: true, maxPri: 1, categories: [] });
    expect(r.body.categories).toBeNull();
  });

  test('duplicate exclusions collapse', async () => {
    const r = await put({ enabled: true, maxPri: 1, excludedProjects: ['p', 'p', ' p ', ''] });
    expect(r.body.excludedProjects).toEqual(['p']);
  });
});

describe('reading it', () => {
  test('returns the saved policy plus the counts', async () => {
    await put({ enabled: true, maxPri: 2, ceiling: 75, excludedProjects: ['p_client'] });
    const r = await request(app()).get('/api/tasks/policy');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, maxPri: 2, ceiling: 75, excludedProjects: ['p_client'] });
    expect(Array.isArray(r.body.availableCategories)).toBe(true);
  });

  test('THE REGRESSION: a degraded read reports the real policy, never ceiling 0', async () => {
    // It used to answer `ceiling: 0`. A client that reads, changes one field and
    // PUTs back would have written that zero — and the clamp turns 0 into 1, so
    // the board would quietly file one card at a time.
    await put({ enabled: true, maxPri: 2, ceiling: 75 });
    statusThrows = true;
    const r = await request(app()).get('/api/tasks/policy');
    expect(r.status).toBe(200);
    expect(r.body.ceiling).toBe(75);
    expect(r.body.degraded).toBe(true);

    statusThrows = false;
    const back = await put({ ...r.body, maxPri: 1 });
    expect(back.body.ceiling).toBe(75);
  });
});
