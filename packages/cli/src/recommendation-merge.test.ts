/**
 * The merge layer behind recall_claude_suggestions / recall_improvements.
 *
 * The property that matters most is the PARTITION: the two tools split the
 * recommendation engines' output, so no item can appear in both. If that
 * breaks, an agent reading both lists opens two tasks for one problem.
 */
import { describe, test, expect } from 'vitest';
import {
  INSTRUCTION_KINDS, sevRank, priToSeverity, partitionRecs,
  actionToImprovement, recToImprovement, isOpenAction,
  rankImprovements, rankInstructions, taskBody,
  type EngineRec, type EngineAction, type Improvement,
} from './recommendation-merge.js';

const rec = (over: Partial<EngineRec> = {}): EngineRec => ({
  id: 'rec_1', kind: 'rule', severity: 'medium', title: 'T', rationale: 'because',
  evidence: [], action: { type: 'append_claude_md', payload: { text: 'do the thing' } }, ...over,
});

const action = (over: Partial<EngineAction> = {}): EngineAction => ({
  id: 'ca_1', projectId: 'proj', pri: 0, category: 'security', title: 'A', fix: 'fix it',
  loc: [], agentPrompt: 'go', status: 'suggested', ...over,
});

describe('severity scale', () => {
  test('high sorts before medium before low', () => {
    expect(sevRank('high')).toBeLessThan(sevRank('medium'));
    expect(sevRank('medium')).toBeLessThan(sevRank('low'));
  });

  test('an unknown severity is treated as low, never as urgent', () => {
    expect(sevRank('bogus')).toBe(sevRank('low'));
  });
});

describe('priToSeverity', () => {
  test('pri 0 is the most urgent band', () => {
    expect(priToSeverity(0)).toBe('high');
  });

  test('pri 1 is medium and anything beyond is low', () => {
    expect(priToSeverity(1)).toBe('medium');
    expect(priToSeverity(2)).toBe('low');
    expect(priToSeverity(99)).toBe('low');
  });

  test('a malformed pri surfaces as high rather than vanishing', () => {
    // Dropping it would silently shrink the plan, which is the worse failure.
    expect(priToSeverity(NaN)).toBe('high');
    expect(priToSeverity(-1)).toBe('high');
  });
});

describe('partitionRecs — the two tools never overlap', () => {
  test('rule and skill go to instructions, everything else to improvements', () => {
    const { instruction, improvement } = partitionRecs([
      rec({ id: 'a', kind: 'rule' }),
      rec({ id: 'b', kind: 'skill' }),
      rec({ id: 'c', kind: 'review' }),
      rec({ id: 'd', kind: 'label' }),
      rec({ id: 'e', kind: 'reset' }),
    ]);
    expect(instruction.map((r) => r.id)).toEqual(['a', 'b']);
    expect(improvement.map((r) => r.id)).toEqual(['c', 'd', 'e']);
  });

  test('every input lands in exactly one half', () => {
    const input = ['rule', 'skill', 'review', 'label', 'reset', 'future_kind']
      .map((kind, n) => rec({ id: `r${n}`, kind }));
    const { instruction, improvement } = partitionRecs(input);
    expect(instruction.length + improvement.length).toBe(input.length);
    const ids = [...instruction, ...improvement].map((r) => r.id);
    expect(new Set(ids).size).toBe(input.length);
  });

  test('a kind the engine adds later defaults to improvements, not to silence', () => {
    const { instruction, improvement } = partitionRecs([rec({ kind: 'brand_new_kind' })]);
    expect(instruction).toHaveLength(0);
    expect(improvement).toHaveLength(1);
  });

  test('INSTRUCTION_KINDS is what drives the split', () => {
    expect([...INSTRUCTION_KINDS]).toEqual(['rule', 'skill']);
  });
});

describe('isOpenAction', () => {
  test('done and dismissed actions are not improvements', () => {
    expect(isOpenAction(action({ status: 'done' }))).toBe(false);
    expect(isOpenAction(action({ status: 'dismissed' }))).toBe(false);
  });

  test('suggested and queued actions are', () => {
    expect(isOpenAction(action({ status: 'suggested' }))).toBe(true);
    expect(isOpenAction(action({ status: 'queued' }))).toBe(true);
  });
});

describe('conversion to Improvement', () => {
  test('an action keeps its numeric pri as the sort rank', () => {
    expect(actionToImprovement(action({ pri: 3 })).rank).toBe(3);
  });

  test('a location renders file:line, and a line-less one renders the file', () => {
    const i = actionToImprovement(action({ loc: [{ file: 'a.ts', line: 12 }, { file: 'b.ts' }] }));
    expect(i.where).toEqual(['a.ts:12', 'b.ts']);
  });

  test('account-scope recommendations carry no project', () => {
    expect(recToImprovement(rec({ kind: 'review' }), 'account').project).toBeUndefined();
    expect(recToImprovement(rec({ kind: 'review' }), 'proj-x').project).toBe('proj-x');
  });
});

describe('rankImprovements', () => {
  const items: Improvement[] = [
    { rank: 2, severity: 'low', title: 'low one', detail: '', source: 's', where: [] },
    { rank: 0, severity: 'high', title: 'high one', detail: '', source: 's', where: [] },
    { rank: 1, severity: 'medium', title: 'medium one', detail: '', source: 's', where: [] },
  ];

  test('orders most urgent first', () => {
    expect(rankImprovements(items, { minSeverity: 'low', limit: 10 }).map((i) => i.title))
      .toEqual(['high one', 'medium one', 'low one']);
  });

  test('min_severity drops everything below the floor', () => {
    expect(rankImprovements(items, { minSeverity: 'high', limit: 10 }).map((i) => i.title))
      .toEqual(['high one']);
    expect(rankImprovements(items, { minSeverity: 'medium', limit: 10 })).toHaveLength(2);
  });

  test('limit caps after ranking, so the cap never drops a high for a low', () => {
    expect(rankImprovements(items, { minSeverity: 'low', limit: 1 }).map((i) => i.title))
      .toEqual(['high one']);
  });

  test('a zero or negative limit returns nothing rather than throwing', () => {
    expect(rankImprovements(items, { minSeverity: 'low', limit: 0 })).toEqual([]);
    expect(rankImprovements(items, { minSeverity: 'low', limit: -5 })).toEqual([]);
  });

  test('ties break deterministically, so create_tasks is repeatable', () => {
    const tied: Improvement[] = [
      { rank: 0, severity: 'high', title: 'zebra', detail: '', source: 's', where: [] },
      { rank: 0, severity: 'high', title: 'alpha', detail: '', source: 's', where: [] },
    ];
    const once = rankImprovements(tied, { minSeverity: 'low', limit: 10 }).map((i) => i.title);
    const twice = rankImprovements([...tied].reverse(), { minSeverity: 'low', limit: 10 }).map((i) => i.title);
    expect(once).toEqual(['alpha', 'zebra']);
    expect(twice).toEqual(once);
  });

  test('does not mutate the caller\'s array', () => {
    const input = [...items];
    rankImprovements(input, { minSeverity: 'low', limit: 10 });
    expect(input.map((i) => i.title)).toEqual(items.map((i) => i.title));
  });
});

describe('rankInstructions', () => {
  test('severity first, then title, and the input is left alone', () => {
    const rows = [
      { rec: rec({ severity: 'low', title: 'c' }) },
      { rec: rec({ severity: 'high', title: 'b' }) },
      { rec: rec({ severity: 'high', title: 'a' }) },
    ];
    const snapshot = rows.map((r) => r.rec.title);
    expect(rankInstructions(rows).map((r) => r.rec.title)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => r.rec.title)).toEqual(snapshot);
  });
});

describe('taskBody', () => {
  const base: Improvement = {
    rank: 0, severity: 'high', title: 'T', detail: 'what is wrong',
    source: 'code action · security', where: ['a.ts:1'], agentPrompt: 'fix it',
  };

  test('carries the detail, the provenance and the agent prompt', () => {
    const body = taskBody(base);
    expect(body).toContain('what is wrong');
    expect(body).toContain('Source: code action · security');
    expect(body).toContain('a.ts:1');
    expect(body).toContain('fix it');
    expect(body).toContain('Opened by recall_improvements.');
  });

  test('omits the optional sections when absent', () => {
    const body = taskBody({ ...base, where: [], agentPrompt: undefined });
    expect(body).not.toContain('Where:');
    expect(body).not.toContain('Agent prompt:');
  });

  test('stays within the description column limit', () => {
    const body = taskBody({ ...base, detail: 'x'.repeat(50_000) });
    expect(body.length).toBeLessThanOrEqual(20_000);
  });
});
