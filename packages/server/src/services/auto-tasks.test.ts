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

/** The ambient author sub, read through the real ALS the service uses. */
let currentAuthorSub: () => string | null = () => null;

vi.mock('../imports.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createControlPlane: async () => ({
    getTenantSetting: async (_t: string, k: string) => state.settings.get(k) ?? null,
    setTenantSetting: async (_t: string, k: string, v: string) => { state.settings.set(k, v); },
    close: async () => {},
  }),
  createStore: async () => ({
    // Behaves like RLS author_visibility: a viewer that owns nothing sees
    // nothing. currentAuthor().sub is 'auto-tasks' inside runWithAuthor and null
    // under runUnrestricted, which is exactly the distinction that broke prod.
    listCodeActions: async () => (currentAuthorSub() ? [] : state.actions),
    teamTasksByFindingIds: async () => (currentAuthorSub() ? [] : state.tasks),
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

import { runAutoTasks, autoTasksStatus, AUTO_TASKS_KEY } from './auto-tasks.js';
import { currentAuthor } from '@chat-recall/engine/core/store/tenant-context.js';
currentAuthorSub = () => currentAuthor().sub;

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
      { id: 't_keep2', title: 'human card', status: 'todo', createdBy: 'someone', linkedFindingId: 'gone-too' },
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

  test('force bypasses the debounce — the "Run now" button', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = [action('a1', 0)];
    await runAutoTasks('t1');
    state.actions.push(action('a2', 0));
    const r = await runAutoTasks('t1', { force: true });
    expect(r?.created).toBe(1);
    expect(state.created).toEqual(['a1', 'a2']);
  });

  test('records the last run even when it files nothing', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 0 }));
    state.actions = [];                      // nothing qualifies
    const r = await runAutoTasks('t1');
    expect(r).toEqual({ created: 0, closed: 0 });
    // "ran and found nothing" must be distinguishable from "never ran", or the
    // UI cannot answer "is anything happening?".
    const st = await autoTasksStatus('t1');
    expect(st.lastRun?.created).toBe(0);
    expect(st.lastRun?.at).toBeGreaterThan(0);
  });

  test('a MEDIUM floor files the pri-2 findings a high floor left behind', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 2 }));
    state.actions = [action('c', 0), action('h', 1), action('m', 2), action('l', 3)];
    const r = await runAutoTasks('t1');
    expect(r?.created).toBe(3);                       // critical + high + medium
    expect(state.created).toEqual(['c', 'h', 'm']);
  });

  test('a CRITICAL floor on a repo with no criticals files nothing', async () => {
    // Exactly the shape of the real tenant: pri 1 and 2 only, no pri 0 anywhere.
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 0 }));
    state.actions = [action('h', 1), action('m', 2)];
    const r = await runAutoTasks('t1');
    expect(r?.created).toBe(0);
  });

  test('an out-of-range floor is clamped, not obeyed', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 99 }));
    state.actions = [action('l', 3)];
    expect((await runAutoTasks('t1'))?.created).toBe(1);   // clamped to 3 = low
  });

  test('the card title carries the canonical severity name', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 3 }));
    state.actions = [action('m', 2)];
    await runAutoTasks('t1');
    expect(state.tasks.find((t) => t.linkedFindingId === 'm')?.title).toMatch(/^\[medium\]/);
  });

  test('status counts eligible/filed and breaks findings down per project', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 0 }));
    state.actions = [
      { ...action('c1', 0), projectId: 'chat-recall' },
      { ...action('c2', 0), projectId: 'chat-recall' },
      { ...action('h1', 1), projectId: 'chat-recall' },
      { ...action('c3', 0), projectId: 'munbot' },
      { ...action('low', 3), projectId: 'munbot' },     // counted, but below the floor
    ];
    state.tasks = [{ id: 't_a', title: 'has a card', status: 'todo', createdBy: 'auto-tasks', linkedFindingId: 'c1' }];
    const st = await autoTasksStatus('t1');
    expect(st.filed).toBe(1);
    // maxPri 0 → only criticals are eligible; c1 already has a card.
    expect(st.eligible).toBe(2);
    expect(st.byProject).toEqual([
      { projectId: 'chat-recall', counts: { critical: 2, high: 1 }, eligible: 1 },
      { projectId: 'munbot', counts: { critical: 1, low: 1 }, eligible: 1 },
    ]);
  });

  test('status reports no last run before anything has run', async () => {
    const st = await autoTasksStatus('t-fresh');
    expect(st.lastRun).toBeNull();
    expect(st.policy.enabled).toBe(false);
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

/**
 * The reads must not run as the 'auto-tasks' author.
 *
 * Passing that string as the author makes it the RLS viewer, and a viewer that
 * owns no rows sees only NULL-author ones. On the hosted service that meant the
 * service read ZERO findings and filed nothing, ever, while self-host looked
 * fine because every row there is NULL-author. The fake store above models that
 * rule, so this test fails if the reads move back inside runWithAuthor.
 */
describe('reads are unrestricted, writes are authored', () => {
  test('files cards even though the auto-tasks author owns nothing', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = [action('c1', 0), action('h1', 1)];
    const r = await runAutoTasks('t1');
    expect(r).toEqual({ created: 2, closed: 0 });
    expect(state.created).toEqual(['c1', 'h1']);
  });

  test('the close sweep also sees the tenant, not just its own rows', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 0 }));
    state.actions = [];                    // the finding is gone
    state.tasks = [{ id: 't_x', title: 'stale', status: 'todo', createdBy: 'auto-tasks', linkedFindingId: 'gone' }];
    const r = await runAutoTasks('t1');
    expect(r?.closed).toBe(1);
  });
});
