/**
 * The wake-up task count belongs to the project you are in.
 *
 * The KG facts in the same payload were already filtered by project_filter and
 * the task count was not: it called listTeamTasks({}) and reported the whole
 * tenant, so a session opened in chat-recall was told about munbot's backlog.
 * That is exactly the "I change project and the tasks change, plus some generic
 * ones" confusion.
 *
 * THIS FILE IMPORTS THE SHIPPED RULE. The first version re-implemented it as a
 * local scopeTasks() and asserted against the copy — which also meant it pinned
 * the WRONG answer for unscoped cards as if it were correct. A test that cannot
 * see the shipped code cannot tell you the shipped code is wrong; the same
 * mistake let `rejected` ship without a database column.
 *
 * The rule is exported from routes/memory.ts rather than exercised over HTTP
 * because the sqlite driver used in tests has no team-task table — it returns
 * [] — so a route-level test could never see a card at all.
 */
import { describe, test, expect } from 'vitest';
import { scopeOpenTasks } from './memory.js';

type Task = { id: string; projectId: string; status: string; linkedFindingId: string | null };

const T = (id: string, projectId: string, status = 'todo', finding: string | null = null): Task =>
  ({ id, projectId, status, linkedFindingId: finding });

const BOARD: Task[] = [
  T('1', 'git:github.com/munhq/chat-recall', 'todo', 'ca_1'),
  T('2', 'git:github.com/munhq/chat-recall', 'in_progress'),
  T('3', 'git:github.com/munhq/chat-recall', 'done', 'ca_2'),
  T('4', 'git:github.com/munhq/chat-recall', 'rejected', 'ca_9'),
  T('5', 'git:github.com/munhq/munbot', 'todo', 'ca_3'),
  T('6', 'ws:personal', 'todo'),
  T('7', '', 'todo'),                       // a card filed by hand, no project
];

const wakeUp = (project?: string) => scopeOpenTasks(BOARD, project);

describe('wake-up task scope', () => {
  test('a loose project name matches the fully qualified id', () => {
    // 2 open chat-recall cards (todo + in_progress) + the unscoped one.
    expect(wakeUp('chat-recall')).toEqual({ total: 3, auto: 1, scope: 'chat-recall' });
  });

  test('another project is not counted', () => {
    expect(wakeUp('munbot')).toEqual({ total: 2, auto: 1, scope: 'munbot' });
  });

  test('a card with NO project stays visible under any filter', () => {
    // '' .includes('chat-recall') is false, so the old rule silently swallowed
    // every hand-filed card the moment a filter was supplied. A card with no
    // project is not some other repo's card.
    expect(wakeUp('no-such-project')).toEqual({ total: 1, auto: 0, scope: 'no-such-project' });
  });

  test('done cards never count as backlog', () => {
    expect(scopeOpenTasks([T('a', 'p', 'done'), T('b', 'p', 'done')], 'p').total).toBe(0);
  });

  test('rejected cards never count either — the user already said no', () => {
    // recall_tasks excludes them; if the wake-up did not, one session would see
    // two different backlog numbers in one payload.
    expect(scopeOpenTasks([T('a', 'p', 'rejected'), T('b', 'p', 'todo')], 'p').total).toBe(1);
  });

  test('no filter reports the whole tenant, and says so by omitting scope', () => {
    const t = wakeUp();
    expect(t.total).toBe(5);            // 7 cards, minus one done and one rejected
    expect(t.scope).toBeUndefined();
  });

  test('auto counts only cards filed from a finding', () => {
    expect(wakeUp('chat-recall').auto).toBe(1);
  });

  test('matching is case-insensitive on both sides', () => {
    expect(scopeOpenTasks([T('a', 'git:GitHub.com/Munhq/Chat-Recall')], 'chat-recall').total).toBe(1);
  });
});
