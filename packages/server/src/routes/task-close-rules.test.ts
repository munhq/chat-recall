/**
 * The three ways a card can leave the board, and what each one has to prove.
 *
 * `done` was the only ending with a rule, and the rule was too weak: it asked
 * for a session and nothing more. A munbot card closed with a real session
 * attached rendered "74 commits in chat-recall" — the session's whole footprint,
 * from another repository. Right session, wrong evidence, and the card said
 * nothing about which was which.
 *
 * So: `done` names the commits, `closed` names a reason, and `rejected` stays the
 * human's verdict. A machine may not simply assert that work happened.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const tasks = new Map<string, any>();
const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];

vi.mock('../imports.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createStore: async () => ({
    getTeamTask: async (id: string) => (tasks.has(id) ? { task: tasks.get(id), comments: [] } : null),
    updateTeamTask: async (id: string, patch: Record<string, unknown>) => {
      patches.push({ id, patch });
      const t = { ...(tasks.get(id) ?? {}), ...patch };
      tasks.set(id, t);
      return t;
    },
    listTeamTasks: async () => [...tasks.values()],
    close: async () => {},
  }),
  createControlPlane: async () => ({
    getTenantSetting: async () => null, setTenantSetting: async () => {}, close: async () => {},
  }),
}));

const { default: tasksRouter } = await import('./tasks.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as never as { userId: string; tenant: string }).userId = 'alice';
    (req as never as { tenant: string }).tenant = 't1';
    next();
  });
  a.use('/api/tasks', tasksRouter);
  return a;
}

const card = (o: Record<string, unknown> = {}) => ({
  id: 't_1', projectId: 'git:h/o/munbot', title: 'panic', description: '', status: 'todo',
  assigneeSub: null, createdBy: 'auto-tasks', blocks: [], blockedBy: [],
  linkedSessionId: null, linkedFindingId: 'cf_1', linkedFindingIdentity: 'cf_1',
  closedReason: null, doneEvidence: null, due: null, createdAt: 1, updatedAt: 1, ...o,
});

beforeEach(() => { tasks.clear(); patches.length = 0; tasks.set('t_1', card()); });

describe('done', () => {
  test('still refused without the session that did the work', async () => {
    const r = await request(app()).patch('/api/tasks/t_1').send({ status: 'done' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/done by the work/);
  });

  test('THE POINT: refused with a session but NO commits', async () => {
    tasks.set('t_1', card({ linkedSessionId: 's_1' }));
    const r = await request(app()).patch('/api/tasks/t_1').send({ status: 'done' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/needs the commits/);
    expect(patches).toHaveLength(0);
  });

  test('accepted with commits, and the shas are stored on the card', async () => {
    tasks.set('t_1', card({ linkedSessionId: 's_1' }));
    const r = await request(app()).patch('/api/tasks/t_1')
      .send({ status: 'done', doneEvidence: { commits: ['10bba674', '48c2ce65'], summary: 'panics → Result' } });
    expect(r.status).toBe(200);
    expect(patches[0].patch.doneEvidence).toMatchObject({ commits: ['10bba674', '48c2ce65'] });
  });

  test('empty or blank shas do not count as evidence', async () => {
    tasks.set('t_1', card({ linkedSessionId: 's_1' }));
    const r = await request(app()).patch('/api/tasks/t_1')
      .send({ status: 'done', doneEvidence: { commits: ['   ', ''] } });
    expect(r.status).toBe(409);
  });

  test('a card that already carries evidence can be re-marked done', async () => {
    // Re-opening and re-closing must not demand the shas a second time.
    tasks.set('t_1', card({ linkedSessionId: 's_1', doneEvidence: { commits: ['abc1234'] } }));
    const r = await request(app()).patch('/api/tasks/t_1').send({ status: 'done' });
    expect(r.status).toBe(200);
  });
});

describe('closed', () => {
  test('THE POINT: refused without a reason', async () => {
    const r = await request(app()).patch('/api/tasks/t_1').send({ status: 'closed' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/needs a reason/);
    expect(patches).toHaveLength(0);
  });

  test('a whitespace-only reason is not a reason', async () => {
    const r = await request(app()).patch('/api/tasks/t_1').send({ status: 'closed', closedReason: '  ' });
    expect(r.status).toBe(400);
  });

  test('accepted with one, and it is stored — no session needed', async () => {
    const r = await request(app()).patch('/api/tasks/t_1')
      .send({ status: 'closed', closedReason: 'duplicate of t_2' });
    expect(r.status).toBe(200);
    expect(patches[0].patch).toMatchObject({ status: 'closed', closedReason: 'duplicate of t_2' });
  });
});

describe('rejected', () => {
  test('needs neither session nor commits — it is a verdict, not a claim of work', async () => {
    const r = await request(app()).patch('/api/tasks/t_1').send({ status: 'rejected' });
    expect(r.status).toBe(200);
  });
});
