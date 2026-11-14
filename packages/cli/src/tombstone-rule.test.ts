/**
 * The rule for a tombstone (issue #20). On 2026-11-12 a list difference sent
 * 11,977 tombstones for sessions whose files were on disk.
 */
import { describe, test, expect } from 'vitest';
import {
  tombstoneMode, planTombstones, describeTombstonePlan,
  TOMBSTONE_MIN_GUARDED_BATCH,
  type SessionProbe,
} from './tombstone-rule.js';

const ids = (n: number, prefix = 's'): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
const probeOf = (answers: Record<string, SessionProbe>) => (id: string): SessionProbe => answers[id] ?? 'present';

describe('planTombstones', () => {
  test('a session whose source is missing is tombstoned', () => {
    const plan = planTombstones({
      ledgerIds: ['a', 'b', 'c'], visited: new Set(['a']),
      probe: probeOf({ b: 'missing' }),
    });
    expect(plan).toEqual({ ids: ['b'], refused: null });
  });

  test('a session in an unmounted folder is not tombstoned', () => {
    const plan = planTombstones({
      ledgerIds: ['a', 'b'], visited: new Set(),
      probe: probeOf({ a: 'unknown', b: 'unknown' }),
    });
    expect(plan.ids).toEqual([]);
  });

  test('a session that no backend owns is not tombstoned', () => {
    const plan = planTombstones({ ledgerIds: ['x'], visited: new Set(), probe: () => 'unknown' });
    expect(plan.ids).toEqual([]);
  });

  test('a probe that throws leaves the session alone', () => {
    const plan = planTombstones({
      ledgerIds: ['x', 'y'], visited: new Set(),
      probe: (id) => { if (id === 'x') throw new Error('disk error'); return 'missing'; },
    });
    expect(plan.ids).toEqual(['y']);
  });

  test('a visited session is never probed', () => {
    const probed: string[] = [];
    planTombstones({
      ledgerIds: ['a', 'b'], visited: new Set(['a']),
      probe: (id) => { probed.push(id); return 'present'; },
    });
    expect(probed).toEqual(['b']);
  });

  test('a session that is not in the list but is on disk is not tombstoned', () => {
    const all = ids(200);
    const plan = planTombstones({ ledgerIds: all, visited: new Set(), probe: () => 'present' });
    expect(plan.ids).toEqual([]);
  });

  test('a batch of more than 5 percent of the ledger is refused', () => {
    const all = ids(1000);
    const plan = planTombstones({ ledgerIds: all, visited: new Set(), probe: (id) => (id < 's-6' || Number(id.slice(2)) < 100 ? 'missing' : 'present') });
    expect(plan.ids.length).toBeGreaterThan(TOMBSTONE_MIN_GUARDED_BATCH);
    expect(plan.refused).toBe('batch_too_large');
  });

  test('a batch of 50 sessions or fewer is sent whatever its share', () => {
    const all = ids(60);
    const plan = planTombstones({ ledgerIds: all, visited: new Set(), probe: (id) => (Number(id.slice(2)) < 50 ? 'missing' : 'present') });
    expect(plan.ids).toHaveLength(50);
    expect(plan.refused).toBeNull();
  });

  test('a batch below 5 percent of a large ledger is sent', () => {
    const all = ids(4000);
    const plan = planTombstones({ ledgerIds: all, visited: new Set(), probe: (id) => (Number(id.slice(2)) < 100 ? 'missing' : 'present') });
    expect(plan.ids).toHaveLength(100);
    expect(plan.refused).toBeNull();
  });
});

describe('tombstoneMode', () => {
  test('the default reports and sends nothing', () => {
    expect(tombstoneMode({})).toBe('report');
  });
  test('act, off and report are honoured, in any case', () => {
    expect(tombstoneMode({ CHAT_RECALL_TOMBSTONES: 'ACT' })).toBe('act');
    expect(tombstoneMode({ CHAT_RECALL_TOMBSTONES: ' off ' })).toBe('off');
    expect(tombstoneMode({ CHAT_RECALL_TOMBSTONES: 'report' })).toBe('report');
  });
  test('a value that does not parse keeps report', () => {
    expect(tombstoneMode({ CHAT_RECALL_TOMBSTONES: 'yes' })).toBe('report');
    expect(tombstoneMode({ CHAT_RECALL_TOMBSTONES: '' })).toBe('report');
  });
});

describe('describeTombstonePlan', () => {
  test('names the count, the mode and the first five ids', () => {
    const line = describeTombstonePlan({ ids: ids(8), refused: null }, 'report');
    expect(line).toContain('8 session(s)');
    expect(line).toContain('mode report');
    expect(line).toContain('s-0, s-1, s-2, s-3, s-4');
    expect(line).not.toContain('s-5');
  });
  test('says that a refused batch is not sent', () => {
    const line = describeTombstonePlan({ ids: ids(80), refused: 'batch_too_large' }, 'act');
    expect(line).toContain('too large to send');
  });
});
