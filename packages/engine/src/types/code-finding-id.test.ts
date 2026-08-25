/**
 * A finding's identity must survive an edit somewhere else in the file.
 *
 * THE BUG. `codeFindingId` hashed `project|category|file|LINE|rule`. A line
 * number is the most volatile part of a finding — every insertion above it moves
 * it — and `replaceCodeFindings` carries `status` and `first_seen_at` forward BY
 * ID. So adding an import at the top of a file silently discarded every triage
 * verdict in it and reset every age to now. It is also why 7,670 findings were
 * all `status='open'`: no verdict could survive long enough to be seen.
 *
 * WHY AN ORDINAL. Measured on those 7,670 real findings:
 *
 *   with line                   7,670 distinct   unstable
 *   without line                2,464 distinct   merges real occurrences
 *   without line, with snippet  4,973 distinct   still merges ~2,700
 *
 * Eight `.unwrap()` calls in one file share a rule and a snippet, so no content
 * hash separates them. Their order does. Identity is therefore content plus an
 * ordinal among identical siblings, which is stable under edits elsewhere and
 * shifts only when an identical sibling is added or removed above one.
 */
import { describe, test, expect } from 'vitest';
import { codeFindingIds, codeFindingId } from './code-intel.js';

const f = (o: Partial<Parameters<typeof codeFindingIds>[1][number]> = {}) => ({
  category: 'security', file: 'src/main.rs', rule: 'unwrap', title: 'Unwrap in main',
  line: 10, snippet: 'let x = y.unwrap();', ...o,
});

describe('THE REGRESSION: a line shift must not change the id', () => {
  test('the same finding twenty lines lower keeps its id', async () => {
    // Someone adds twenty lines of imports at the top of the file. Nothing about
    // the finding changed. Under the old scheme every id in the file changed.
    const before = codeFindingIds('p', [f({ line: 10 })]);
    const after = codeFindingIds('p', [f({ line: 30 })]);
    expect(after[0]).toBe(before[0]);
  });

  test('a null line is handled and still stable', () => {
    // 738 of the real findings carry no line at all.
    expect(codeFindingIds('p', [f({ line: null })])[0])
      .toBe(codeFindingIds('p', [f({ line: null })])[0]);
  });
});

describe('identical siblings stay distinct', () => {
  test('eight unwraps in one file are eight ids, not one', () => {
    const eight = Array.from({ length: 8 }, (_, i) => f({ line: 10 + i * 5 }));
    const ids = codeFindingIds('p', eight);
    expect(new Set(ids).size).toBe(8);
  });

  test('their ordinals follow LINE ORDER, not the collector emit order', () => {
    // The collector's order is an implementation detail of the analyzer. If it
    // leaked into identity, re-running it over unchanged code would renumber
    // every sibling — which is exactly the class of bug that produced 93 phantom
    // task closures on the action side.
    const ascending = codeFindingIds('p', [f({ line: 10 }), f({ line: 20 }), f({ line: 30 })]);
    const shuffled = codeFindingIds('p', [f({ line: 30 }), f({ line: 10 }), f({ line: 20 })]);
    expect(shuffled[1]).toBe(ascending[0]);   // line 10 in both
    expect(shuffled[2]).toBe(ascending[1]);   // line 20
    expect(shuffled[0]).toBe(ascending[2]);   // line 30
  });

  test('a sibling inserted BELOW does not disturb the ones above it', () => {
    const two = codeFindingIds('p', [f({ line: 10 }), f({ line: 20 })]);
    const three = codeFindingIds('p', [f({ line: 10 }), f({ line: 20 }), f({ line: 99 })]);
    expect(three[0]).toBe(two[0]);
    expect(three[1]).toBe(two[1]);
  });
});

describe('different findings are different', () => {
  test('file, rule, category and project all separate', () => {
    const base = codeFindingIds('p', [f()])[0];
    expect(codeFindingIds('p', [f({ file: 'src/other.rs' })])[0]).not.toBe(base);
    expect(codeFindingIds('p', [f({ rule: 'expect' })])[0]).not.toBe(base);
    expect(codeFindingIds('p', [f({ category: 'stability' })])[0]).not.toBe(base);
    expect(codeFindingIds('q', [f()])[0]).not.toBe(base);
  });

  test('the snippet separates two different problems on one rule', () => {
    const a = codeFindingIds('p', [f({ snippet: 'cfg.unwrap()' })])[0];
    const b = codeFindingIds('p', [f({ snippet: 'conn.unwrap()' })])[0];
    expect(a).not.toBe(b);
  });

  test('snippet digits are NOT collapsed — retry(3) is not retry(9)', () => {
    // identityTitle collapses digits because a TITLE's numbers are counts the
    // collector computed. A snippet's numbers are the code.
    const a = codeFindingIds('p', [f({ snippet: 'retry(3).unwrap()' })])[0];
    const b = codeFindingIds('p', [f({ snippet: 'retry(9).unwrap()' })])[0];
    expect(a).not.toBe(b);
  });

  test('but whitespace and reindentation are ignored', () => {
    const a = codeFindingIds('p', [f({ snippet: 'let x = y.unwrap();' })])[0];
    const b = codeFindingIds('p', [f({ snippet: '    let  x =\n\ty.unwrap();  ' })])[0];
    expect(a).toBe(b);
  });
});

describe('the single-finding helper', () => {
  test('agrees with the batch call for a lone finding', () => {
    expect(codeFindingId('p', f())).toBe(codeFindingIds('p', [f()])[0]);
  });

  test('every id is prefixed cf_ and is a stable length', () => {
    const ids = codeFindingIds('p', [f(), f({ line: 20 }), f({ file: 'x.rs' })]);
    for (const id of ids) expect(id).toMatch(/^cf_[0-9a-f]{16}$/);
  });
});

/**
 * THE SECOND BUG. The ordinal counted emissions, so a collector that reported one
 * finding four times got four ids — and the board got four cards for
 * `memory-index.ts:53`. 387 of 8,290 stored findings were duplicates of exactly
 * this kind. An ordinal is a position in a file, so it counts distinct LINES.
 */
describe('a repeated emission is one finding, not several', () => {
  test('THE POINT: four byte-identical findings on one line share one id', () => {
    const four = codeFindingIds('p', [f(), f(), f(), f()]);
    expect(new Set(four).size).toBe(1);
  });

  test('two on the same line, one below: two ids, and the lower one is unaffected', () => {
    const dupThenNext = codeFindingIds('p', [f({ line: 10 }), f({ line: 10 }), f({ line: 40 })]);
    expect(dupThenNext[0]).toBe(dupThenNext[1]);
    expect(dupThenNext[2]).not.toBe(dupThenNext[0]);
    // …and the one below keeps the id it has without the duplicate present.
    const clean = codeFindingIds('p', [f({ line: 10 }), f({ line: 40 })]);
    expect(dupThenNext[2]).toBe(clean[1]);
  });

  test('duplicates with NO line collapse too', () => {
    // 918 real findings carry no line: type_drift names a type, not a place.
    const three = codeFindingIds('p', [f({ line: null }), f({ line: null }), f({ line: null })]);
    expect(new Set(three).size).toBe(1);
  });
});

/**
 * THE THIRD BUG, and the reason the title had to join the key. With no line to
 * sort by, the ordinal fell back to the COLLECTOR'S EMIT ORDER — so 38 distinct
 * missing fields on one type were held apart by nothing more stable than the
 * analyzer's output order, and re-running it renumbered every one of them.
 */
describe('null-line siblings are separated by content, not by emit order', () => {
  const drift = (title: string) => ({
    category: 'type_drift', file: 'AppState', rule: 'missing_field',
    line: null, title, snippet: 'field missing in one language',
  });

  test('THE POINT: distinct titles are distinct findings', () => {
    const ids = codeFindingIds('p', [drift('AppState.foo missing'), drift('AppState.bar missing')]);
    expect(new Set(ids).size).toBe(2);
  });

  test('and their ids do not depend on the order they were emitted in', () => {
    const asc = codeFindingIds('p', [drift('a missing'), drift('b missing')]);
    const desc = codeFindingIds('p', [drift('b missing'), drift('a missing')]);
    expect(desc[1]).toBe(asc[0]);   // 'a missing' in both
    expect(desc[0]).toBe(asc[1]);   // 'b missing' in both
  });

  test('a title COUNT still does not move the id', () => {
    // identityTitle collapses digits: "copy-pasted 29×" must stay the same
    // finding at 30, or the card closes itself and a twin is filed.
    const a = codeFindingIds('p', [f({ title: 'slice copy-pasted 29× (13 lines each)' })])[0];
    const b = codeFindingIds('p', [f({ title: 'slice copy-pasted 30× (13 lines each)' })])[0];
    expect(a).toBe(b);
  });

  test('but the title is otherwise part of identity', () => {
    const a = codeFindingIds('p', [f({ title: 'Unwrap in main' })])[0];
    const b = codeFindingIds('p', [f({ title: 'Unwrap in shutdown' })])[0];
    expect(a).not.toBe(b);
  });
});
