import { describe, it, expect } from 'vitest';
import { listDecisionGaps, areasByScope, type DecidedFact, type ProjectRef } from './decision-gaps.js';
import { DECISION_AREAS } from '@chat-recall/engine/core/decision-areas.js';

/**
 * The production shape this exists for: eight decisions recorded against the
 * account sentinel from inside one repository, which every other project then
 * inherited.
 */
const ACCOUNT_STACK: DecidedFact[] = [
  { subject: '*:database', object: 'Postgres', valid_to: null },
  { subject: '*:api', object: 'Express', valid_to: null },
  { subject: '*:auth', object: 'BetterAuth', valid_to: null },
];

const PROJECTS: ProjectRef[] = [
  { project_id: 'git:github.com/owner/example-app', project_path: '/home/user/code/personal/example-app' },
  { project_id: 'git:github.com/owner/other-app', project_path: '/home/user/code/personal/other-app' },
];

const gapFor = (gaps: ReturnType<typeof listDecisionGaps>, path: string, area: string) =>
  gaps.find((g) => g.projectPath === path && g.area === area);

describe('areasByScope', () => {
  it('buckets live decisions by their scope key', () => {
    const map = areasByScope(ACCOUNT_STACK);
    expect(map.get('*')?.get('database')).toBe('Postgres');
  });

  it('ignores a superseded row', () => {
    const map = areasByScope([{ subject: '*:database', object: 'MySQL', valid_to: '2026-01-01' }]);
    expect(map.get('*')).toBeUndefined();
  });

  it('ignores a free-text subject from before areas existed', () => {
    const map = areasByScope([{ subject: 'we should use postgres', object: 'yes', valid_to: null }]);
    expect(map.size).toBe(0);
  });
});

describe('listDecisionGaps', () => {
  it('reports an area the project inherits from the account', () => {
    const gaps = listDecisionGaps(PROJECTS, ACCOUNT_STACK);
    const g = gapFor(gaps, '/home/user/code/personal/example-app', 'database');
    expect(g).toBeDefined();
    expect(g!.inherited).toEqual({ value: 'Postgres', from: 'the account' });
    expect(g!.title).toContain('inherits its database decision from the account');
  });

  it('ranks an inherited answer above a blank one', () => {
    const gaps = listDecisionGaps(PROJECTS, ACCOUNT_STACK);
    expect(gapFor(gaps, '/home/user/code/personal/example-app', 'database')!.pri).toBe(2);
    // Nobody decided pricing anywhere, so it is unrecorded rather than wrong.
    expect(gapFor(gaps, '/home/user/code/personal/example-app', 'pricing')!.pri).toBe(3);
    expect(gapFor(gaps, '/home/user/code/personal/example-app', 'pricing')!.inherited).toBeNull();
  });

  it('stops reporting an area once the project decides it', () => {
    const decided = [...ACCOUNT_STACK,
      { subject: 'git:github.com/owner/example-app:database', object: 'SQLite', valid_to: null }];
    const gaps = listDecisionGaps(PROJECTS, decided);
    expect(gapFor(gaps, '/home/user/code/personal/example-app', 'database')).toBeUndefined();
    // The sibling still inherits, so its card stays.
    expect(gapFor(gaps, '/home/user/code/personal/other-app', 'database')).toBeDefined();
  });

  it('treats a folder-group decision as the project answering for itself', () => {
    const decided = [...ACCOUNT_STACK, { subject: 'ws:personal:database', object: 'SQLite', valid_to: null }];
    const gaps = listDecisionGaps(PROJECTS, decided);
    expect(gapFor(gaps, '/home/user/code/personal/example-app', 'database')).toBeUndefined();
    expect(gapFor(gaps, '/home/user/code/personal/other-app', 'database')).toBeUndefined();
  });

  it('does not treat a personal preference as the project answering', () => {
    const decided: DecidedFact[] = [{ subject: 'user:u1:database', object: 'SQLite', valid_to: null }];
    const gaps = listDecisionGaps(PROJECTS, decided, { userId: 'u1' });
    const g = gapFor(gaps, '/home/user/code/personal/example-app', 'database');
    expect(g).toBeDefined();
    expect(g!.inherited).toEqual({ value: 'SQLite', from: 'a personal preference' });
  });

  it('gives a gap the same id every time, and a different one per area and project', () => {
    const a = listDecisionGaps(PROJECTS, ACCOUNT_STACK);
    const b = listDecisionGaps(PROJECTS, ACCOUNT_STACK);
    expect(a.map((g) => g.id)).toEqual(b.map((g) => g.id));
    expect(new Set(a.map((g) => g.id)).size).toBe(a.length);
  });

  it('keys a gap on the project key, not on the path it was indexed under', () => {
    // The same repository checked out somewhere else on another machine.
    const elsewhere: ProjectRef[] = [
      { project_id: 'git:github.com/owner/example-app', project_path: '/Users/alice/work/personal/example-app' },
    ];
    const here = listDecisionGaps([PROJECTS[0]], ACCOUNT_STACK);
    const there = listDecisionGaps(elsewhere, ACCOUNT_STACK);
    expect(there.map((g) => g.id)).toEqual(here.map((g) => g.id));
  });

  it('skips a project with no path, because there is nothing to scan', () => {
    const gaps = listDecisionGaps([{ project_id: 'git:github.com/owner/app', project_path: '' }], []);
    expect(gaps).toEqual([]);
  });

  it('reports only canonical areas', () => {
    const decided: DecidedFact[] = [{ subject: '*:package-pinning', object: 'exact', valid_to: null }];
    const gaps = listDecisionGaps([PROJECTS[0]], decided);
    for (const g of gaps) expect(DECISION_AREAS).toContain(g.area);
    expect(gaps.some((g) => (g.area as string) === 'package-pinning')).toBe(false);
  });

  it('tells the agent to ask rather than guess', () => {
    const g = gapFor(listDecisionGaps(PROJECTS, ACCOUNT_STACK), '/home/user/code/personal/example-app', 'database')!;
    expect(g.agentPrompt).toContain('recall_decision_scan');
    expect(g.agentPrompt).toContain('ASK THE USER');
    expect(g.agentPrompt).toContain('do not record a decision nobody made');
    // The path the agent has to open must be in the prompt.
    expect(g.agentPrompt).toContain('/home/user/code/personal/example-app');
  });

  it('files every area for a project with no decisions anywhere', () => {
    const gaps = listDecisionGaps([PROJECTS[0]], []);
    expect(gaps).toHaveLength(DECISION_AREAS.length);
    expect(gaps.every((g) => g.pri === 3 && g.inherited === null)).toBe(true);
  });
});
