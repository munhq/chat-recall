/**
 * A finding's identity must survive its own counters.
 *
 * The board closes a card when its linked finding id stops being reported, so an
 * id that changes with a count means: card closed (nobody fixed it), near-copy
 * filed. That happened in prod on 2026-08-21 — 10 cards filed at 17:32 and
 * closed at 17:38 by the next run, same problems with different numbers.
 */
import { describe, test, expect } from 'vitest';
import { codeActionId } from './code-intel.js';

const P = 'git:github.com/munhq/chat-recall';
const at = (title: string, file = 'src/a.ts', line: number | null = 12) =>
  codeActionId(P, { category: 'duplication', title, loc: [{ file, line }] });

describe('codeActionId', () => {
  test('a changed count keeps the same identity', () => {
    expect(at('slice copy-pasted 29× (13 lines each)'))
      .toBe(at('slice copy-pasted 30× (13 lines each)'));
    expect(at('inflate copy-pasted 4× (899 lines each)'))
      .toBe(at('inflate copy-pasted 2× (827 lines each)'));
  });

  test('a different symbol is still a different finding', () => {
    expect(at('slice copy-pasted 29× (13 lines each)'))
      .not.toBe(at('getCurrentFee copy-pasted 29× (13 lines each)'));
  });

  test('the same title at a different place is a different finding', () => {
    expect(at('slice copy-pasted 3×', 'src/a.ts')).not.toBe(at('slice copy-pasted 3×', 'src/b.ts'));
    expect(at('slice copy-pasted 3×', 'src/a.ts', 12)).not.toBe(at('slice copy-pasted 3×', 'src/a.ts', 40));
  });

  test('category still separates two findings that share a title and a place', () => {
    const a = codeActionId(P, { category: 'duplication', title: 'x 2×', loc: [{ file: 'f.ts', line: 1 }] });
    const b = codeActionId(P, { category: 'security', title: 'x 2×', loc: [{ file: 'f.ts', line: 1 }] });
    expect(a).not.toBe(b);
  });

  test('a project rename is a different finding (ids are project-scoped)', () => {
    const a = codeActionId('proj-a', { category: 'dup', title: 't 1×', loc: [] });
    const b = codeActionId('proj-b', { category: 'dup', title: 't 1×', loc: [] });
    expect(a).not.toBe(b);
  });
});
