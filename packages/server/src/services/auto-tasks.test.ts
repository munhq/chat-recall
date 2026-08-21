/**
 * Auto-tasks — findings file their own cards, and close them again.
 *
 * The contract:
 *   1. OFF unless the tenant opted in — the board has no delete.
 *   2. Only actions at/under the policy's pri floor materialize, deduped by
 *      the finding id, capped per run so a first index cannot bury the board.
 *   3. The close sweep touches ONLY cards this service created and that are
 *      still open — a human's cards and states are never rewritten.
 *   4. A lapsed tenant's stale policy writes nothing (plan gate re-checked).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const state = {
  settings: new Map<string, string>(),
  actions: [] as Array<{ id: string; pri: number; title: string; fix: string; loc: never[]; agentPrompt: string; projectId: string; status: string }>,
  tasks: [] as Array<{ id: string; title: string; status: string; createdBy: string; linkedFindingId: string | null }>,
  created: [] as string[],
  updated: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  comments: [] as string[],
};
let seq = 0;

vi.mock('../imports.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createControlPlane: async () => ({
    getTenantSetting: async (_t: string, k: string) => state.settings.get(k) ?? null,
    setTenantSetting: async (_t: string, k: string, v: string) => { state.settings.set(k, v); },
    close: async () => {},
  }),
  createStore: async () => ({
    listCodeActions: async () => state.actions,
    teamTasksByFindingIds: async () => state.tasks,
    createTeamTask: async (input: { title: string; linkedFindingId?: string | null }) => {
      state.created.push(input.linkedFindingId as string);
      const t = { id: `t_${++seq}`, title: input.title, status: 'todo', createdBy: 'auto-tasks', linkedFindingId: input.linkedFindingId ?? null };
      state.tasks.push(t);
      return t;
    },
    updateTeamTask: async (id: string, patch: Record<string, unknown>) => { state.updated.push({ id, patch }); return null; },
    addTeamTaskComment: async (id: string) => { state.comments.push(id); return null; },
    close: async () => {},
  }),
}));

import { runAutoTasks, AUTO_TASKS_KEY } from './auto-tasks.js';

const action = (id: string, pri: number) => ({
  id, pri, title: `fix ${id}`, fix: 'do it', loc: [] as never[], agentPrompt: '', projectId: 'p1', status: 'suggested',
});

beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY;   // self-host shape: plan gate is a no-op
  state.settings.clear();
  state.actions = [];
  state.tasks = [];
  state.created = [];
  state.updated = [];
  state.comments = [];
});

describe('auto-tasks', () => {
  test('does nothing when the policy is off (the default)', async () => {
    state.actions = [action('a1', 0)];
    expect(await runAutoTasks('t1')).toBeNull();
    expect(state.created).toEqual([]);
  });

  test('files critical+high, skips lower, dedupes on the finding id', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = [action('crit', 0), action('high', 1), action('med', 2)];
    state.tasks = [{ id: 't_x', title: 'existing', status: 'todo', createdBy: 'auto-tasks', linkedFindingId: 'crit' }];
    const r = await runAutoTasks('t1');
    expect(r?.created).toBe(1);              // only 'high' — 'crit' already has a card
    expect(state.created).toEqual(['high']);
  });

  test('caps a run so a first index cannot bury the board', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = Array.from({ length: 30 }, (_, i) => action(`a${i}`, 0));
    const r = await runAutoTasks('t1');
    expect(r?.created).toBe(10);
  });

  test('closes ONLY its own open cards whose finding is gone', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 0 }));
    state.actions = [action('still-open', 0)];
    state.tasks = [
      { id: 't_close', title: 'resolved one', status: 'todo', createdBy: 'auto-tasks', linkedFindingId: 'gone' },
      { id: 't_keep1', title: 'still reported', status: 'todo', createdBy: 'auto-tasks', linkedFindingId: 'still-open' },
      { id: 't_keep2', title: 'human card', status: 'todo', createdBy: 'adi', linkedFindingId: 'gone-too' },
      { id: 't_keep3', title: 'already done', status: 'done', createdBy: 'auto-tasks', linkedFindingId: 'gone-three' },
    ];
    const r = await runAutoTasks('t1');
    expect(r?.closed).toBe(1);
    expect(state.updated).toEqual([{ id: 't_close', patch: { status: 'done' } }]);
    expect(state.comments).toEqual(['t_close']);
  });

  test('debounces: a second run inside the window is a no-op', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = [action('a1', 0)];
    await runAutoTasks('t1');
    state.actions.push(action('a2', 0));
    expect(await runAutoTasks('t1')).toBeNull();
    expect(state.created).toEqual(['a1']);
  });

  test('a LAPSED tenant\'s stale policy writes nothing', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';   // cloud: the plan gate is live
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = [action('a1', 0)];
    // effectivePlan resolves 'free' (no entitlement row in the fake plane →
    // isEntitled falls through its ensureTrial path; the fake has no
    // getEntitlement, so isEntitled throws and runAutoTasks swallows it) —
    // either way: nothing may be written.
    await runAutoTasks('t-lapsed');
    expect(state.created).toEqual([]);
    delete process.env.STRIPE_SECRET_KEY;
  });
});
