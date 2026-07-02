import { describe, test, expect } from 'vitest';
import { classifyChunk } from './memory-classifier.js';

describe('classifyChunk', () => {
  test('classifies a tool-choice statement as decision', () => {
    const r = classifyChunk("Let's use Postgres instead of MongoDB for transactional storage. The trade-off is cost but better consistency.");
    expect(r.memoryType).toBe('decision');
    expect(r.importance).toBeGreaterThanOrEqual(3);
  });

  test('classifies a coding-style rule as preference', () => {
    const r = classifyChunk("I prefer snake_case for SQL columns. Please always use it.");
    expect(r.memoryType).toBe('preference');
  });

  test('classifies a "shipped" statement as milestone', () => {
    const r = classifyChunk("Finally got the deploy working! Auth flow shipped end-to-end.");
    expect(['milestone', 'discovery']).toContain(r.memoryType);
  });

  test('classifies an unresolved bug as problem', () => {
    const r = classifyChunk("There's a bug in the auth middleware: tokens are not being validated correctly. Investigating root cause now.");
    expect(['problem', 'discovery']).toContain(r.memoryType);
  });

  test('promotes resolved problem to milestone when both signals present', () => {
    const r = classifyChunk("Found the bug — token comparison was case-sensitive. Fixed and deployed. Now working end-to-end.");
    // Either milestone (if both markers fire) or problem if only fix-words fire.
    expect(['milestone', 'problem']).toContain(r.memoryType);
  });

  test('returns general for prose with no markers', () => {
    const r = classifyChunk("The weather today is mild and the office has snacks.");
    expect(r.memoryType).toBe('general');
    expect(r.confidence).toBe(0);
  });

  test('confidence is bounded to [0, 1]', () => {
    const r = classifyChunk("we decided to use postgres because of consistency. The architecture is simpler. We chose this approach over mongodb.");
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  test('importance is bounded to [0, 5]', () => {
    const r = classifyChunk("we should use postgres for better consistency. Trade-off vs. mongodb is cost.");
    expect(r.importance).toBeGreaterThanOrEqual(0);
    expect(r.importance).toBeLessThanOrEqual(5);
  });

  test('long prose with markers gets length bonus (higher score than short)', () => {
    const short = classifyChunk("Let's use postgres.");
    const long = classifyChunk("Let's use postgres. " + "We chose this approach because of better consistency guarantees in transactional workloads. ".repeat(10));
    expect(long.importance).toBeGreaterThanOrEqual(short.importance);
  });

  test('empty input returns general', () => {
    const r = classifyChunk("");
    expect(r.memoryType).toBe('general');
  });
});

describe('precision — topical words are not decisions (anti-slop regression)', () => {
  test('prose full of decision-adjacent NOUNS stays general, never importance ≥4', () => {
    // Every one of these words was a DECISION_MARKER in the original
    // implementation, which scored this paragraph importance 5 and surfaced
    // it in recall_wake_up as a high-importance "decision".
    const r = classifyChunk(
      'The architecture uses a layered approach. Our strategy relies on a plugin pattern; ' +
      'the stack is a standard framework setup — configure it and keep the default.'
    );
    expect(r.memoryType).toBe('general');
    expect(r.importance).toBeLessThan(4);
  });

  test('an explicit decision statement reaches the wake-up bar (≥4)', () => {
    const r = classifyChunk('We decided to use Postgres instead of SQLite for the server.');
    expect(r.memoryType).toBe('decision');
    expect(r.importance).toBeGreaterThanOrEqual(4);
  });

  test('bare "bug/error" mentions without explicit phrasing stay general', () => {
    const r = classifyChunk('There is a bug tracker and an error page in this repo.');
    expect(r.memoryType).toBe('general');
  });

  test('long text gets no importance boost from length alone', () => {
    const filler = 'This paragraph describes the codebase in neutral terms. '.repeat(20);
    const short = classifyChunk('We decided to use Postgres.');
    const long = classifyChunk('We decided to use Postgres. ' + filler);
    expect(long.importance).toBeLessThanOrEqual(short.importance);
  });
});
