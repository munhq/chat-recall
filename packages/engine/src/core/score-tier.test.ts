import { describe, test, expect } from 'vitest';
import { tierFor, tierAll } from './score-tier.js';

describe('tierFor', () => {
  test('top score is always strong', () => {
    expect(tierFor(0.5, 0.5)).toBe('strong');
    expect(tierFor(100, 100)).toBe('strong');
    // Even tiny absolute scores: if you ARE the top, you're strong.
    expect(tierFor(0.001, 0.001)).toBe('strong');
  });

  test('FTS5-range scores tier correctly relative to top', () => {
    // BM25 ranks of -2 (best) and -12 (worst) → scores of 0.33 and 0.077.
    // 0.077 / 0.33 = 0.23 → weak
    expect(tierFor(0.077, 0.33)).toBe('weak');
    // 0.20 / 0.33 = 0.6 → good
    expect(tierFor(0.20, 0.33)).toBe('good');
    // 0.30 / 0.33 = 0.91 → strong
    expect(tierFor(0.30, 0.33)).toBe('strong');
  });

  test('vector-range scores tier correctly relative to top', () => {
    // Vector L2 distances of 50 (best) and 500 (worst) → scores 0.0196 and 0.002.
    // The previous absolute display rounded both to 0/100 — the tier system
    // must distinguish them by *relative* position.
    expect(tierFor(0.0196, 0.0196)).toBe('strong'); // top
    expect(tierFor(0.018, 0.0196)).toBe('strong');  // 0.92 ratio
    expect(tierFor(0.012, 0.0196)).toBe('good');    // 0.61
    expect(tierFor(0.005, 0.0196)).toBe('weak');    // 0.26
  });

  test('returns unranked when top score is non-positive', () => {
    // Defensive: degenerate input (no real matches) shouldn't divide by zero.
    expect(tierFor(0.5, 0)).toBe('unranked');
    expect(tierFor(0.5, -1)).toBe('unranked');
    expect(tierFor(0.5, NaN)).toBe('unranked');
  });

  test('boundary thresholds are stable', () => {
    // Exact ratio of 0.85 → strong; just below → good.
    expect(tierFor(0.85, 1.0)).toBe('strong');
    expect(tierFor(0.8499, 1.0)).toBe('good');
    expect(tierFor(0.55, 1.0)).toBe('good');
    expect(tierFor(0.5499, 1.0)).toBe('weak');
  });

  test('handles invalid result score defensively', () => {
    // NaN/negative/Infinity scores all imply a backend that produced
    // garbage — surface as 'weak' rather than letting Infinity round to
    // a misleadingly strong "match".
    expect(tierFor(NaN, 1.0)).toBe('weak');
    expect(tierFor(-0.5, 1.0)).toBe('weak');
    expect(tierFor(Infinity, 1.0)).toBe('weak');
  });
});

describe('tierAll', () => {
  test('returns parallel tiers for sorted result set', () => {
    const results = [
      { score: 0.30 },  // top → strong
      { score: 0.27 },  // 0.9 → strong
      { score: 0.18 },  // 0.6 → good
      { score: 0.05 },  // 0.16 → weak
    ];
    expect(tierAll(results)).toEqual(['strong', 'strong', 'good', 'weak']);
  });

  test('empty input → empty output', () => {
    expect(tierAll([])).toEqual([]);
  });

  test('single result is always strong', () => {
    expect(tierAll([{ score: 0.001 }])).toEqual(['strong']);
  });

  test('all-zero results → all unranked', () => {
    // When no matches found, the whole batch should report unranked rather
    // than misleadingly claiming the top zero-score is "strong".
    expect(tierAll([{ score: 0 }, { score: 0 }, { score: 0 }])).toEqual([
      'unranked',
      'unranked',
      'unranked',
    ]);
  });
});
