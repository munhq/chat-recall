/**
 * /api/tasks PATCH — the linkedSessionId path.
 *
 * The board's differentiator is that a card carries linkedSessionId and can
 * show whether the linked AI session actually shipped. Creation could always
 * link; these tests pin the PATCH path that lets an agent attach the session
 * that did the work to a card that existed BEFORE the work started:
 *
 *   1. a string links, and reaches the store as-is
 *   2. null detaches (and a non-string is coerced to null, same as POST)
 *   3. an absent field never touches the column
 *   4. the foreign-assignee gate is unchanged — a linkedSessionId ride-along
 *      must not smuggle an assignment past the 402
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const state: {
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  features: string[];
} = { patches: [], features: [] };

vi.mock('../imports.js', () => ({
  createStore: async () => ({
    updateTeamTask: async (id: string, patch: Record<string, unknown>) => {
      state.patches.push({ id, patch });
      return { id, title: 't', status: 'todo', ...patch };
    },
    close: async () => {},
  }),
}));

vi.mock('../util/billing.js', () => ({
  tenantFeatures: async () => state.features,
}));

vi.mock('../util/entitlements.js', () => ({
  featureRequired: (feature: string) => ({ error: `${feature} plan required`, feature }),
}));

async function app(): Promise<Express> {
  const { default: router } = await import('./tasks.js');
  const a = express();
  a.use(express.json());
  // The real mount sits behind tenantAuth; supply what the route reads.
  a.use((req, _res, next) => { (req as any).tenant = 't1'; (req as any).authorSub = 'me'; next(); });
  a.use('/api/tasks', router);
  return a;
}

beforeEach(() => { state.patches = []; state.features = []; });

describe('PATCH /api/tasks/:id — linkedSessionId', () => {
  test('a string links the session, and reaches the store unchanged', async () => {
    const res = await request(await app())
      .patch('/api/tasks/t_1').send({ status: 'in_progress', linkedSessionId: 'sess-abc' });
    expect(res.status).toBe(200);
    expect(state.patches).toHaveLength(1);
    expect(state.patches[0].id).toBe('t_1');
    expect(state.patches[0].patch.linkedSessionId).toBe('sess-abc');
    expect(state.patches[0].patch.status).toBe('in_progress');
  });

  test('null detaches — the store receives an explicit null, not undefined', async () => {
    const res = await request(await app())
      .patch('/api/tasks/t_1').send({ linkedSessionId: null });
    expect(res.status).toBe(200);
    expect(state.patches[0].patch).toHaveProperty('linkedSessionId', null);
  });

  test('a non-string is coerced to null — same validation as the POST path', async () => {
    const res = await request(await app())
      .patch('/api/tasks/t_1').send({ linkedSessionId: 42 });
    expect(res.status).toBe(200);
    expect(state.patches[0].patch).toHaveProperty('linkedSessionId', null);
  });

  test('an absent field never touches the column', async () => {
    const res = await request(await app())
      .patch('/api/tasks/t_1').send({ title: 'renamed' });
    expect(res.status).toBe(200);
    expect('linkedSessionId' in state.patches[0].patch).toBe(false);
  });

  test('the foreign-assignee gate still 402s, and the store is never called', async () => {
    // linkedSessionId riding along must not smuggle the assignment through.
    const res = await request(await app())
      .patch('/api/tasks/t_1').send({ assigneeSub: 'someone-else', linkedSessionId: 'sess-abc' });
    expect(res.status).toBe(402);
    expect(state.patches).toHaveLength(0);
  });

  test('with the team feature, assignee + linkedSessionId land together', async () => {
    state.features = ['team'];
    const res = await request(await app())
      .patch('/api/tasks/t_1').send({ assigneeSub: 'someone-else', linkedSessionId: 'sess-abc' });
    expect(res.status).toBe(200);
    expect(state.patches[0].patch.assigneeSub).toBe('someone-else');
    expect(state.patches[0].patch.linkedSessionId).toBe('sess-abc');
  });
});
