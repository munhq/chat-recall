/**
 * Done is earned; rejection is the human's.
 *
 * A card asserts a problem exists in the code, so moving it to done asserts the
 * code changed. The board carried 93 "done" cards that nobody had worked — every
 * one closed because a finding stopped being reported, several because its id
 * shifted underneath it. Meanwhile a person could drag anything to Done and the
 * product would agree.
 *
 * So: done needs a session to point at, and disagreement gets its own verdict —
 * one that reaches the FINDING, or the auto-filer just files it again.
 *
 * THIS FILE DRIVES THE REAL ROUTER. The first version of it re-implemented the
 * rule as a local `mayApply()` and asserted against the copy, so it passed
 * while the shipped feature was dead on arrival: `rejected` had reached the
 * route, the client and the board and never reached the CHECK constraint in
 * pg-schema.ts, and every reject 500ed. A test that cannot see the shipped code
 * cannot see that. Mount the router; mock only the store.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const state: {
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  dismissed: string[];
  task: { id: string; status: string; linkedSessionId: string | null; linkedFindingId: string | null } | null;
  features: string[];
  statusWriteFails: boolean;
} = { patches: [], dismissed: [], task: null, features: [], statusWriteFails: false };

vi.mock('../imports.js', () => ({
  createStore: async () => ({
    getTeamTask: async (id: string) => (state.task ? { task: { ...state.task, id } } : null),
    updateTeamTask: async (id: string, patch: Record<string, unknown>) => {
      // The real Postgres driver refuses a status outside the CHECK constraint.
      // Model that, so a status the route accepts but the DB rejects fails here
      // instead of in production.
      const ALLOWED = new Set(['todo', 'in_progress', 'blocked', 'done', 'rejected']);
      if (typeof patch.status === 'string' && !ALLOWED.has(patch.status)) {
        throw new Error('new row for relation "team_tasks" violates check constraint "team_tasks_status_check"');
      }
      state.patches.push({ id, patch });
      // Mirror the pg driver: UPDATE ... RETURNING * re-reads the whole row, so
      // the caller gets linkedFindingId back even when the patch never touched
      // it. The route's reject write-through depends on exactly that.
      state.task = { ...(state.task as any), ...patch, id };
      return { ...state.task };
    },
    setCodeActionStatus: async (id: string, status: string) => {
      if (state.statusWriteFails) throw new Error('code action store unavailable');
      if (status === 'dismissed') state.dismissed.push(id);
    },
    close: async () => {},
  }),
}));

vi.mock('../util/billing.js', () => ({ tenantFeatures: async () => state.features }));
vi.mock('../util/entitlements.js', () => ({
  featureRequired: (feature: string) => ({ error: `${feature} plan required`, feature }),
}));

async function app(): Promise<Express> {
  const { default: router } = await import('./tasks.js');
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as any).tenant = 't1'; (req as any).authorSub = 'me'; next(); });
  a.use('/api/tasks', router);
  return a;
}

beforeEach(() => {
  state.patches = []; state.dismissed = []; state.features = []; state.statusWriteFails = false;
  state.task = { id: 't_1', status: 'todo', linkedSessionId: null, linkedFindingId: 'ca_123' };
});

describe('marking a task done', () => {
  test('refused with nothing to check, and the store is never written', async () => {
    const res = await request(await app()).patch('/api/tasks/t_1').send({ status: 'done' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('not by hand');
    expect(state.patches).toHaveLength(0);
  });

  test('the refusal tells the caller how to reject instead', async () => {
    const res = await request(await app()).patch('/api/tasks/t_1').send({ status: 'done' });
    expect(res.body.reject).toContain('"status":"rejected"');
  });

  test('allowed when the agent attaches its session AND names the commits', async () => {
    // The session alone stopped being enough: it proves WHO worked, not WHAT
    // changed, and one card's session badge showed commits from another repo.
    const res = await request(await app())
      .patch('/api/tasks/t_1')
      .send({ status: 'done', linkedSessionId: 'sess_abc', doneEvidence: { commits: ['a1b2c3d'] } });
    expect(res.status).toBe(200);
    expect(state.patches[0].patch.status).toBe('done');
    expect(state.patches[0].patch.linkedSessionId).toBe('sess_abc');
  });

  test('allowed when the card was already claimed, with the commits', async () => {
    state.task = { id: 't_1', status: 'in_progress', linkedSessionId: 'sess_abc', linkedFindingId: null };
    const res = await request(await app()).patch('/api/tasks/t_1')
      .send({ status: 'done', doneEvidence: { commits: ['a1b2c3d'] } });
    expect(res.status).toBe(200);
    expect(state.patches[0].patch.status).toBe('done');
  });

  test('every other move stays free — a person may park or reject anything', async () => {
    for (const s of ['todo', 'in_progress', 'rejected']) {
      state.patches = [];
      const res = await request(await app()).patch('/api/tasks/t_1').send({ status: s });
      expect(res.status, s).toBe(200);
      expect(state.patches[0].patch.status, s).toBe(s);
    }
  });

  test('an unknown status is refused by the route, not by the database', async () => {
    const res = await request(await app()).patch('/api/tasks/t_1').send({ status: 'nonsense' });
    expect(res.status).toBe(400);
    expect(state.patches).toHaveLength(0);
  });

  test("'blocked' is retired: the route will not set a status the board cannot show", async () => {
    // The board has no blocked column, so a card set to blocked would vanish
    // from the UI entirely — byStatus() never queries that bucket.
    const res = await request(await app()).patch('/api/tasks/t_1').send({ status: 'blocked' });
    expect(res.status).toBe(400);
    expect(state.patches).toHaveLength(0);
  });
});

/**
 * The write-through. Without it, "no" lasts until the next code index: the filer
 * materialises every 'suggested' action above the floor, so a card rejected on
 * the board alone comes straight back.
 */
describe('rejecting a card', () => {
  test('stores the verdict AND dismisses the finding behind it', async () => {
    const res = await request(await app()).patch('/api/tasks/t_1').send({ status: 'rejected' });
    expect(res.status).toBe(200);
    expect(state.patches[0].patch.status).toBe('rejected');
    expect(state.dismissed).toEqual(['ca_123']);
  });

  test('a hand-written card has no finding to dismiss, and that is fine', async () => {
    state.task = { id: 't_1', status: 'todo', linkedSessionId: null, linkedFindingId: null };
    const res = await request(await app()).patch('/api/tasks/t_1').send({ status: 'rejected' });
    expect(res.status).toBe(200);
    expect(state.dismissed).toEqual([]);
  });

  test('parking a card does not dismiss anything', async () => {
    const res = await request(await app()).patch('/api/tasks/t_1').send({ status: 'todo' });
    expect(res.status).toBe(200);
    expect(state.dismissed).toEqual([]);
  });

  test('a failed dismissal does not lose the rejection', async () => {
    // Best-effort by design: the verdict is the user's and must persist even if
    // the findings store is unreachable. Worst case the card is re-filed later.
    state.statusWriteFails = true;
    const res = await request(await app()).patch('/api/tasks/t_1').send({ status: 'rejected' });
    expect(res.status).toBe(200);
    expect(state.patches[0].patch.status).toBe('rejected');
  });
});
