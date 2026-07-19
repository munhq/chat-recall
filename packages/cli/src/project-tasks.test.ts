/**
 * TEAM_TASKS.md round-trip (Phase 4 projection): render assigned team tasks to
 * markdown, simulate a user editing checkboxes / status tokens, and confirm the
 * parser recovers exactly the intended status changes (and nothing else).
 */
import { describe, test, expect } from 'vitest';
import { renderTeamTasksMd, parseTeamTasksFile } from './project-tasks.js';

describe('TEAM_TASKS.md render + parse round-trip', () => {
  const tasks = [
    { id: 't_aaa', title: 'Wire the thing', status: 'todo' },
    { id: 't_bbb', title: 'Review the PR', status: 'in_progress' },
    { id: 't_ccc', title: 'Ship it', status: 'done' },
  ];

  test('renders one anchored line per task, done tasks ticked', () => {
    const md = renderTeamTasksMd(tasks);
    expect(md).toContain('<!-- cr-task kind=team id=t_aaa was=todo -->');
    expect(md).toContain('- [x] Ship it  status: `done` <!-- cr-task kind=team id=t_ccc was=done -->');
    expect(md).toContain('- [ ] Wire the thing');
  });

  test('an unedited file yields NO changes', () => {
    expect(parseTeamTasksFile(renderTeamTasksMd(tasks))).toEqual([]);
  });

  test('ticking a todo task → done', () => {
    const md = renderTeamTasksMd(tasks).replace('- [ ] Wire the thing', '- [x] Wire the thing');
    const edits = parseTeamTasksFile(md);
    expect(edits).toEqual([{ kind: 'team', id: 't_aaa', was: 'todo', intent: 'done' }]);
  });

  test('editing the status token → that status wins', () => {
    const md = renderTeamTasksMd(tasks).replace('status: `in_progress`', 'status: `blocked`');
    const edits = parseTeamTasksFile(md);
    expect(edits).toEqual([{ kind: 'team', id: 't_bbb', was: 'in_progress', intent: 'blocked' }]);
  });

  test('unticking a done task → todo', () => {
    const md = renderTeamTasksMd(tasks).replace('- [x] Ship it', '- [ ] Ship it');
    const edits = parseTeamTasksFile(md);
    expect(edits.find((e) => e.id === 't_ccc')).toMatchObject({ intent: 'todo' });
  });

  test('an invalid status token is ignored (no bogus change)', () => {
    const md = renderTeamTasksMd(tasks).replace('status: `todo`', 'status: `banana`');
    expect(parseTeamTasksFile(md)).toEqual([]);
  });
});
