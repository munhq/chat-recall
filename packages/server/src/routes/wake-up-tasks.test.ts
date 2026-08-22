/**
 * The wake-up task count belongs to the project you are in.
 *
 * The KG facts in the same payload were already filtered by project_filter, and
 * the task count was not: it called listTeamTasks({}) and reported the whole
 * tenant. A session opened in chat-recall was told about munbot's backlog, which
 * is exactly the "I change project and the tasks change, plus some generic ones"
 * confusion.
 *
 * Substring, not equality: the filter is a loose name ("chat-recall") while a
 * stored project id is fully qualified ("git:github.com/munhq/chat-recall").
 */
import { describe, test, expect } from 'vitest';

type Task = { projectId: string; status: string; linkedFindingId: string | null };

/** The scoping rule as implemented in routes/memory.ts. */
function scopeTasks(tasks: Task[], projectFilter?: string) {
  const inScope = projectFilter
    ? tasks.filter((t) => (t.projectId || '').toLowerCase().includes(projectFilter.toLowerCase()))
    : tasks;
  const open = inScope.filter((t) => t.status !== 'done');
  return { total: open.length, auto: open.filter((t) => t.linkedFindingId).length };
}

const T = (projectId: string, status = 'todo', finding: string | null = null): Task =>
  ({ projectId, status, linkedFindingId: finding });

const BOARD: Task[] = [
  T('git:github.com/munhq/chat-recall', 'todo', 'ca_1'),
  T('git:github.com/munhq/chat-recall', 'in_progress'),
  T('git:github.com/munhq/chat-recall', 'done', 'ca_2'),
  T('git:github.com/munhq/munbot', 'todo', 'ca_3'),
  T('ws:personal', 'todo'),
  T('', 'todo'),                       // unscoped card
];

describe('wake-up task scope', () => {
  test('a loose project name matches the fully qualified id', () => {
    expect(scopeTasks(BOARD, 'chat-recall')).toEqual({ total: 2, auto: 1 });
  });

  test('another project is not counted', () => {
    expect(scopeTasks(BOARD, 'munbot')).toEqual({ total: 1, auto: 1 });
  });

  test('done cards never count as backlog', () => {
    expect(scopeTasks([T('p', 'done'), T('p', 'done')], 'p').total).toBe(0);
  });

  test('no filter still reports the whole tenant', () => {
    expect(scopeTasks(BOARD).total).toBe(5);
  });

  test('an unmatched filter reports nothing rather than everything', () => {
    expect(scopeTasks(BOARD, 'no-such-project')).toEqual({ total: 0, auto: 0 });
  });
});
