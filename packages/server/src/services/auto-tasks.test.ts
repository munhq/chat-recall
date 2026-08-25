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
  // code_findings, the OTHER source. Kept separate because it is separate in the
  // database, and reading only one of the two is exactly what made 34 critical
  // findings unfileable.
  findings: [] as Array<{ id: string; severity: string; category: string; title: string; file: string; line: number | null; rule: string; why: string; agentPrompt: string; projectId: string; status: string }>,
  tasks: [] as Array<{ id: string; title: string; status: string; createdBy: string; linkedFindingId: string | null; linkedFindingIdentity: string | null; projectId: string }>,
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
    // Same author-visibility behaviour: this read must also happen unrestricted.
    // Honours `severity`, because the service now queries per severity rather
    // than pulling one capped page of everything.
    listCodeFindings: async (_p?: string, opts?: { severity?: string }) => {
      if (currentAuthorSub()) return [];
      return opts?.severity ? state.findings.filter((f) => f.severity === opts.severity) : state.findings;
    },
    // Exact-id lookup: the close sweep's source of truth about a card's finding.
    codeFindingsByIds: async (ids: string[]) => (currentAuthorSub() ? [] : state.findings.filter((f) => ids.includes(f.id))),
    teamTasksByFindingIds: async () => (currentAuthorSub() ? [] : state.tasks),
    createTeamTask: async (input: { title: string; linkedFindingId?: string | null; linkedFindingIdentity?: string | null; projectId?: string }) => {
      state.created.push(input.linkedFindingId as string);
      const t = { id: `t_${++seq}`, title: input.title, status: 'todo', createdBy: 'auto-tasks', linkedFindingId: input.linkedFindingId ?? null, linkedFindingIdentity: input.linkedFindingIdentity ?? null, projectId: input.projectId ?? 'p1' };
      state.tasks.push(t);
      return t;
    },
    updateTeamTask: async (id: string, patch: Record<string, unknown>) => {
      state.updated.push({ id, patch });
      const t = state.tasks.find((x) => x.id === id);
      if (t) Object.assign(t, patch);   // mirror the pg driver's RETURNING *
      return null;
    },
    addTeamTaskComment: async (id: string) => { state.comments.push(id); return null; },
    close: async () => {},
  }),
}));

import { runAutoTasks, autoTasksStatus, AUTO_TASKS_KEY } from './auto-tasks.js';
import { currentAuthor } from '@chat-recall/engine/core/store/tenant-context.js';
currentAuthorSub = () => currentAuthor().sub;

// `category` and a distinct `loc` are part of a real action, and both feed its
// identity. Without them two fixtures collide — a state the real collector cannot
// produce, because codeActionId hashes exactly these inputs, so two actions with
// one identity would share one id and dedupeById would merge them before insert.
const action = (id: string, pri: number) => ({
  id, pri, title: `fix ${id}`, fix: 'do it',
  loc: [{ file: `src/${id}.ts` }] as never[],
  category: 'duplication',
  agentPrompt: '', projectId: 'p1', status: 'suggested',
});

beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY;   // self-host shape: plan gate is a no-op
  state.settings.clear();
  state.actions = [];
  state.findings = [];
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
    // Assert the CLOSE, not the whole write log. t_keep1 matches a live action by
    // id and carries no identity, so it is also written — a backfill, which is
    // correct and is asserted below rather than mistaken for a second closure.
    expect(state.updated.filter((u) => u.patch.status !== undefined))
      .toEqual([{ id: 't_close', patch: { status: 'done' } }]);
    expect(state.comments).toEqual(['t_close']);
    expect(r?.backfilled).toBe(1);
    expect(state.updated.some((u) => u.id === 't_keep1' && u.patch.linkedFindingIdentity)).toBe(true);
    // The human's card and the already-done one are never written at all.
    expect(state.updated.some((u) => u.id === 't_keep2' || u.id === 't_keep3')).toBe(false);
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
    expect(r).toEqual({ created: 0, closed: 0, repointed: 0, backfilled: 0 });
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
    expect(r).toEqual({ created: 2, closed: 0, repointed: 0, backfilled: 0 });
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

/**
 * An id that moved is not a problem that was fixed.
 *
 * THE BUG THESE PIN. `code_actions.id` was hashed over data that moved — a title
 * carrying its own occurrence counts, a location key taking whichever copy the
 * analyzer happened to list first. A re-index over UNCHANGED code therefore
 * minted a new id for the same finding, and the close sweep, which only asked
 * "is this card's finding id in the open set", answered no and closed the card
 * as done. Then filed a duplicate under the new id.
 *
 * Measured on prod before the repair: 97 cards, 93 'done', every one with no
 * session attached, 93 distinct finding ids over 33 distinct titles — while all
 * 313 findings were still 'suggested'. Roughly ninety completed pieces of work
 * were asserted that never happened.
 *
 * Both halves are asserted, because fixing either alone still leaves the board
 * wrong: no false close, AND no duplicate card.
 */
describe('an id shift is not a fix', () => {
  const withLoc = (id: string, pri: number, title: string, file: string) => ({
    id, pri, title, fix: 'do it', loc: [{ file }] as never[],
    agentPrompt: '', projectId: 'p1', status: 'suggested', category: 'duplication',
  });

  test('THE REGRESSION: the card is re-pointed, not closed as done', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    // Round one files a card for the finding as it is currently identified.
    state.actions = [withLoc('ca_old', 1, 'inflate copy-pasted 2× (899 lines each)', 'src/a.js')];
    await runAutoTasks('t1');
    expect(state.created).toEqual(['ca_old']);
    const card = state.tasks[0];
    expect(card.linkedFindingIdentity).toBeTruthy();

    // Round two: same problem, same file, one more copy found — so the title's
    // counter moved and the collector emitted a different id. This is the exact
    // shape that produced 93 phantom closures.
    state.updated = [];
    state.comments = [];
    state.actions = [withLoc('ca_new', 1, 'inflate copy-pasted 3× (899 lines each)', 'src/a.js')];
    const r = await runAutoTasks('t1', { force: true });

    expect(r?.closed).toBe(0);                                  // NOT closed
    expect(r?.repointed).toBe(1);                               // relinked instead
    expect(state.comments).toEqual([]);                         // no "closed automatically"
    expect(state.updated.some((u) => u.patch.status === 'done')).toBe(false);
    expect(state.tasks.find((t) => t.id === card.id)?.linkedFindingId).toBe('ca_new');
  });

  test('and no duplicate card is filed for the renamed finding', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = [withLoc('ca_old', 1, 'inflate copy-pasted 2× (899 lines each)', 'src/a.js')];
    await runAutoTasks('t1');
    state.actions = [withLoc('ca_new', 1, 'inflate copy-pasted 9× (899 lines each)', 'src/a.js')];
    await runAutoTasks('t1', { force: true });

    // One card, not six. Six is what prod actually had for this exact title.
    expect(state.tasks).toHaveLength(1);
    expect(state.created).toEqual(['ca_old']);
  });

  test('a finding that really is gone still closes, and says which id vanished', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = [withLoc('ca_old', 1, 'inflate copy-pasted 2× (899 lines each)', 'src/a.js')];
    await runAutoTasks('t1');
    state.comments = [];
    state.actions = [];                        // genuinely fixed and re-indexed
    const r = await runAutoTasks('t1', { force: true });

    expect(r?.closed).toBe(1);
    expect(r?.repointed).toBe(0);
    expect(state.comments).toHaveLength(1);
  });

  test('a DIFFERENT finding in the same project is not mistaken for the same one', async () => {
    // Guards the first version of this fix, which keyed identity on project +
    // title alone. identityTitle collapses every digit, so "Circular dependency
    // (18 files)" and "Circular dependency (87 files)" collided — two real
    // findings became one card, and one was silently dropped. The location is
    // what separates them, exactly as it does in the id.
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = [
      withLoc('ca_a', 1, 'Circular dependency (18 files)', 'src/a.ts'),
      withLoc('ca_b', 1, 'Circular dependency (87 files)', 'src/b.ts'),
    ];
    await runAutoTasks('t1');
    expect(state.created).toEqual(['ca_a', 'ca_b']);
    expect(state.tasks).toHaveLength(2);
  });

  test('a REJECTED card is never re-pointed or reopened', async () => {
    // Rejection is the human's verdict and it outlives the finding's id.
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = [withLoc('ca_old', 1, 'inflate copy-pasted 2× (899 lines each)', 'src/a.js')];
    await runAutoTasks('t1');
    state.tasks[0].status = 'rejected';
    state.updated = [];
    state.actions = [withLoc('ca_new', 1, 'inflate copy-pasted 5× (899 lines each)', 'src/a.js')];
    const r = await runAutoTasks('t1', { force: true });

    expect(r?.closed).toBe(0);
    expect(state.updated.some((u) => u.patch.status !== undefined)).toBe(false);
  });
});

/**
 * A CRITICAL finding can reach the board.
 *
 * Until this, runAutoTasks read `code_actions` and nothing else. Findings live in
 * `code_findings` and carry a severity STRING where an action carries a numeric
 * `pri`, and the policy is written in pri — so a finding was not filtered out,
 * it was never looked at. Measured on one account: 34 critical findings
 * (unchecked `unwrap`, a manifest rule) permanently unable to become a task,
 * while a pri-2 "God module" action filed a card happily. The most serious
 * things the product knows about could not reach the surface built for acting on
 * them.
 */
describe('findings are fileable, not just actions', () => {
  const finding = (id: string, severity: string, o: Record<string, unknown> = {}) => ({
    id, severity, category: 'security', title: `${severity} thing ${id}`,
    file: `src/${id}.rs`, line: 12, rule: 'unwrap', why: 'a crash waiting to happen',
    agentPrompt: 'fix the unwrap', projectId: 'p1', status: 'open', ...o,
  });

  test('THE POINT: a critical finding files a card under a high floor', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.findings = [finding('f1', 'critical')];
    const r = await runAutoTasks('t1');
    expect(r?.created).toBe(1);
    expect(state.created).toEqual(['f1']);
  });

  test('severity maps onto the pri floor the policy already speaks', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.findings = [
      finding('f_crit', 'critical'),   // pri 0 — files
      finding('f_high', 'high'),       // pri 1 — files
      finding('f_med', 'medium'),      // pri 2 — below the floor
      finding('f_low', 'low'),         // pri 3 — below the floor
      finding('f_info', 'info'),       // pri 3 — below the floor
    ];
    await runAutoTasks('t1');
    expect(state.created).toEqual(['f_crit', 'f_high']);
  });

  test('actions and findings are filed from the same run and share the cap', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = [action('a1', 0)];
    state.findings = [finding('f1', 'critical')];
    const r = await runAutoTasks('t1');
    expect(r?.created).toBe(2);
    expect(state.created.sort()).toEqual(['a1', 'f1']);
  });

  test('a finding already dismissed or fixed is not filed', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.findings = [finding('f1', 'critical', { status: 'dismissed' })];
    await runAutoTasks('t1');
    expect(state.created).toEqual([]);
  });

  test('a finding-backed card closes when the finding stops being reported', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.findings = [finding('f1', 'critical')];
    await runAutoTasks('t1');
    state.comments = [];
    state.findings = [];                      // fixed and re-indexed
    const r = await runAutoTasks('t1', { force: true });
    expect(r?.closed).toBe(1);
  });

  test('a finding-backed card is NOT filed twice across runs', async () => {
    // A finding's id is already its identity — content plus an ordinal, no
    // volatile part — so a second run must recognise its own card.
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.findings = [finding('f1', 'critical')];
    await runAutoTasks('t1');
    await runAutoTasks('t1', { force: true });
    expect(state.tasks).toHaveLength(1);
    expect(state.created).toEqual(['f1']);
  });
});

/**
 * A card older than the identity column must acquire one.
 *
 * It matches by id, so the filing loop's `continue` skipped it forever and it
 * never gained an identity — meaning the first time its id shifted it would
 * close itself as fixed, which is precisely the bug the column exists to stop.
 * The cards left after the 0009 repair are exactly these, so without the
 * backfill they stay vulnerable indefinitely.
 */
describe('pre-identity cards are repaired in place', () => {
  test('THE GAP: a card matching by id but holding no identity gets one', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = [action('a1', 0)];
    // A card as migration 0009 leaves them: right id, no identity.
    state.tasks = [{
      id: 't_old', title: '[critical] fix a1', status: 'todo', createdBy: 'auto-tasks',
      linkedFindingId: 'a1', linkedFindingIdentity: null, projectId: 'p1',
    }];
    const r = await runAutoTasks('t1');
    expect(r?.backfilled).toBe(1);
    expect(r?.created).toBe(0);                       // no duplicate filed
    expect(state.tasks[0].linkedFindingIdentity).toBeTruthy();
  });

  test('and once it has one, a later run does not write again', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = [action('a1', 0)];
    state.tasks = [{
      id: 't_old', title: '[critical] fix a1', status: 'todo', createdBy: 'auto-tasks',
      linkedFindingId: 'a1', linkedFindingIdentity: null, projectId: 'p1',
    }];
    await runAutoTasks('t1');
    const second = await runAutoTasks('t1', { force: true });
    expect(second?.backfilled).toBe(0);
  });

  test('a backfilled card then survives an id shift instead of closing', async () => {
    // The whole point: repair, then prove the repair works.
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.actions = [action('a1', 0)];
    state.tasks = [{
      id: 't_old', title: '[critical] fix a1', status: 'todo', createdBy: 'auto-tasks',
      linkedFindingId: 'a1', linkedFindingIdentity: null, projectId: 'p1',
    }];
    await runAutoTasks('t1');                          // backfills identity
    // Same action, new id — what used to close the card as done.
    state.actions = [{ ...action('a1', 0), id: 'a1_rehashed' }];
    const r = await runAutoTasks('t1', { force: true });
    expect(r?.closed).toBe(0);
    expect(r?.repointed).toBe(1);
    expect(state.tasks[0].linkedFindingId).toBe('a1_rehashed');
  });
});

/**
 * A capped list cannot answer "is this still open".
 *
 * The findings read was listCodeFindings(limit: 500) across EVERY project, and
 * the close sweep treated that page as the complete set of open findings. With
 * 8,096 findings in one real database and 500 slots, everything past the cap
 * looks deleted — so a card pointing at it closes itself as fixed. That is the
 * bug this whole service was just repaired for, reintroduced by a LIMIT.
 *
 * It was harmless only by accident: the ordering is severity-first and just 31
 * findings were critical-or-high, so every fileable one fell inside the page. It
 * would have become live the moment the policy floor moved from 1 to 2 — a
 * correctness that depends on a setting nobody connected to it.
 *
 * The fix is to fetch by intent: per-severity for filing, by exact id for the
 * close sweep. These tests pin the second half, since it is the one that
 * silently destroys data.
 */
describe('a finding beyond any page is not treated as deleted', () => {
  const finding = (id: string, severity: string) => ({
    id, severity, category: 'security', title: `t ${id}`, file: `src/${id}.rs`,
    line: 1, rule: 'unwrap', why: 'w', agentPrompt: '', projectId: 'p1', status: 'open',
  });

  test('THE REGRESSION: a low-severity finding a card names is not closed', async () => {
    // maxPri 1 means 'low' is never FILED — but a card may already point at one
    // (filed when the floor was lower, or promoted by hand). The close sweep must
    // still see that it exists, which a severity-filtered filing query alone
    // would not show.
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.findings = [finding('cf_low', 'low')];
    state.tasks = [{
      id: 't_low', title: '[low] t cf_low', status: 'todo', createdBy: 'auto-tasks',
      linkedFindingId: 'cf_low', linkedFindingIdentity: 'cf_low', projectId: 'p1',
    }];
    const r = await runAutoTasks('t1');
    expect(r?.closed).toBe(0);
    expect(state.updated.some((u) => u.patch.status === 'done')).toBe(false);
  });

  test('and one that really is absent still closes', async () => {
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.findings = [];                       // nothing exists at any severity
    state.tasks = [{
      id: 't_gone', title: '[critical] t cf_gone', status: 'todo', createdBy: 'auto-tasks',
      linkedFindingId: 'cf_gone', linkedFindingIdentity: 'cf_gone', projectId: 'p1',
    }];
    const r = await runAutoTasks('t1');
    expect(r?.closed).toBe(1);
  });

  test('filing still respects the floor even though the sweep sees more', async () => {
    // The union must not widen what gets FILED — otherwise raising visibility for
    // the close sweep would quietly file everything.
    state.settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 1 }));
    state.findings = [finding('cf_crit', 'critical'), finding('cf_med', 'medium'), finding('cf_low', 'low')];
    state.tasks = [{
      id: 't_low', title: '[low] t cf_low', status: 'todo', createdBy: 'auto-tasks',
      linkedFindingId: 'cf_low', linkedFindingIdentity: 'cf_low', projectId: 'p1',
    }];
    await runAutoTasks('t1');
    expect(state.created).toEqual(['cf_crit']);   // not cf_med, not cf_low
  });
});
