/**
 * A decision gap reaching the board, and leaving it again.
 *
 * The producer is unit-tested next door; this is the wiring — that a gap files
 * a card through the same filer as a code finding, obeys the same policy knobs,
 * and closes itself when the project finally has an answer of its own. The
 * close is the half that has been wrong before on this board, so it is asserted
 * here rather than assumed from the shared code path.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const settings = new Map<string, string>();

/** The register, as `decided` rows. Rewritten per test. */
let decided: Array<{ subject: string; object: string; valid_to: string | null }> = [];
/** Cards the filer created, and the updates it applied to them. */
let created: Array<Record<string, unknown>> = [];
let updated: Array<{ id: string; patch: Record<string, unknown> }> = [];
let existingTasks: Array<Record<string, unknown>> = [];

const PROJECTS = [
  { project_id: 'git:github.com/owner/example-app', project_path: '/home/user/code/personal/example-app' },
];

vi.mock('../imports.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createControlPlane: async () => ({
    getTenantSetting: async (_t: string, k: string) => settings.get(k) ?? null,
    setTenantSetting: async (_t: string, k: string, v: string) => { settings.set(k, v); },
    close: async () => {},
  }),
  createKnowledgeGraph: async () => ({
    queryRelationship: async (predicate: string) => (predicate === 'decided' ? decided : []),
    close: async () => {},
  }),
  createStore: async () => ({
    listCodeActions: async () => [],
    listCodeFindings: async () => [],
    codeFindingsByIds: async () => [],
    teamTasksByFindingIds: async () => existingTasks,
    listAllProjectIdPaths: async () => PROJECTS,
    createTeamTask: async (t: Record<string, unknown>) => { created.push(t); return { id: `t_${created.length}` }; },
    updateTeamTask: async (id: string, patch: Record<string, unknown>) => { updated.push({ id, patch }); },
    addTeamTaskComment: async () => {},
    close: async () => {},
  }),
  runWithTenant: async (_t: string, fn: () => unknown) => fn(),
  runWithAuthor: async (_a: unknown, fn: () => unknown) => fn(),
  runUnrestricted: async (fn: () => unknown) => fn(),
}));

const { runAutoTasks, AUTO_TASKS_KEY } = await import('./auto-tasks.js');

/** Turn the policy on at a floor that admits the value under test. */
function policy(extra: Record<string, unknown> = {}) {
  settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: true, maxPri: 2, ...extra }));
}

beforeEach(() => {
  settings.clear();
  created = []; updated = []; existingTasks = [];
  decided = [{ subject: '*:database', object: 'Postgres', valid_to: null }];
});

describe('a decision gap on the board', () => {
  test('files a card for an area the project inherits and never decided', async () => {
    policy();
    const r = await runAutoTasks('t1', { force: true });
    expect(r?.created).toBeGreaterThan(0);

    const card = created.find((c) => String(c.title).includes('database'));
    expect(card).toBeDefined();
    expect(card!.projectId).toBe('git:github.com/owner/example-app');
    expect(String(card!.title)).toContain('inherits its database decision from the account');
    expect(String(card!.description)).toContain('recall_decision_scan');
    // The footer must describe where the card came from. A decision gap is not
    // re-indexed, so promising a re-index would be a lie to whoever reads it.
    expect(String(card!.description)).toContain('closes itself once this project has an answer of its own');
    expect(String(card!.description)).not.toContain('re-index');
  });

  test('a blank area stays below a medium floor', async () => {
    policy({ maxPri: 2 });
    await runAutoTasks('t1', { force: true });
    // pricing is decided nowhere, so it is pri 3 and this floor excludes it.
    expect(created.some((c) => String(c.title).includes('pricing'))).toBe(false);
  });

  test('a low floor files the blank areas too', async () => {
    policy({ maxPri: 3 });
    await runAutoTasks('t1', { force: true });
    expect(created.some((c) => String(c.title).includes('pricing'))).toBe(true);
  });

  test('the category filter can ask for decisions alone', async () => {
    policy({ maxPri: 3, categories: ['decisions'] });
    await runAutoTasks('t1', { force: true });
    expect(created.length).toBeGreaterThan(0);
  });

  test('a category filter that omits decisions files none of them', async () => {
    policy({ maxPri: 3, categories: ['security'] });
    await runAutoTasks('t1', { force: true });
    expect(created).toEqual([]);
  });

  test('an excluded project files nothing', async () => {
    policy({ maxPri: 3, excludedProjects: ['git:github.com/owner/example-app'] });
    await runAutoTasks('t1', { force: true });
    expect(created).toEqual([]);
  });

  test('files the same gap once, however often it runs', async () => {
    policy();
    await runAutoTasks('t1', { force: true });
    const first = created.length;
    // The board now holds those cards, keyed by the finding id the filer stored.
    existingTasks = created.map((c, i) => ({
      id: `t_${i + 1}`, status: 'todo', createdBy: 'auto-tasks',
      linkedFindingId: c.linkedFindingId, linkedFindingIdentity: c.linkedFindingIdentity,
    }));
    created = [];
    await runAutoTasks('t1', { force: true });
    expect(first).toBeGreaterThan(0);
    expect(created).toEqual([]);
  });

  test('closes the card once the project records its own decision', async () => {
    policy();
    await runAutoTasks('t1', { force: true });
    const card = created.find((c) => String(c.title).includes('database'))!;
    existingTasks = [{
      id: 't_db', status: 'todo', createdBy: 'auto-tasks',
      linkedFindingId: card.linkedFindingId, linkedFindingIdentity: card.linkedFindingIdentity,
    }];
    created = [];

    // The agent did the work: the repository's own answer, at project scope.
    decided = [
      ...decided,
      { subject: 'git:github.com/owner/example-app:database', object: 'SQLite', valid_to: null },
    ];
    const r = await runAutoTasks('t1', { force: true });

    expect(r?.closed).toBeGreaterThan(0);
    expect(updated.find((u) => u.id === 't_db')?.patch.status).toBe('closed');
  });

  test('leaves the card open while the gap is still there', async () => {
    policy();
    await runAutoTasks('t1', { force: true });
    const card = created.find((c) => String(c.title).includes('database'))!;
    existingTasks = [{
      id: 't_db', status: 'todo', createdBy: 'auto-tasks',
      linkedFindingId: card.linkedFindingId, linkedFindingIdentity: card.linkedFindingIdentity,
    }];
    created = [];

    const r = await runAutoTasks('t1', { force: true });
    expect(r?.closed).toBe(0);
    expect(updated.find((u) => u.id === 't_db')).toBeUndefined();
  });

  test('files nothing when the policy is off', async () => {
    settings.set(AUTO_TASKS_KEY, JSON.stringify({ enabled: false, maxPri: 3 }));
    expect(await runAutoTasks('t1', { force: true })).toBeNull();
    expect(created).toEqual([]);
  });

  test('an unreadable register does not stop the run', async () => {
    policy();
    decided = null as never;   // queryRelationship returns something unusable
    const r = await runAutoTasks('t1', { force: true });
    expect(r).not.toBeNull();
    expect(created).toEqual([]);
  });
});
