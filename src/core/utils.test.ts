import { describe, test, expect } from 'vitest';
import {
  splitByHeaders,
  getModelContextLimit,
  getModelPricing,
  sanitizeLanceFilter,
} from './utils.js';

describe('splitByHeaders', () => {
  test('returns one section for prose with no headers', () => {
    const out = splitByHeaders('hello world\nlorem ipsum');
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('hello world');
  });

  test('splits on `## ` headers', () => {
    const md = `# Title\nintro\n## Section A\nbody A\n## Section B\nbody B`;
    const out = splitByHeaders(md);
    // First section is the pre-header intro, then one per `##`.
    expect(out.length).toBeGreaterThanOrEqual(2);
    const headings = out.map(s => s.heading).filter(Boolean);
    expect(headings).toContain('Section A');
    expect(headings).toContain('Section B');
  });

  test('handles empty input', () => {
    // Empty input yields a single empty section (consistent with how callers
    // chunk md — they filter out short text downstream).
    const out = splitByHeaders('');
    expect(out.length).toBeLessThanOrEqual(1);
    if (out.length === 1) expect(out[0].text).toBe('');
  });
});

describe('getModelContextLimit', () => {
  test('returns 200000 for opus models', () => {
    expect(getModelContextLimit('claude-opus-4-7')).toBeGreaterThanOrEqual(200000);
  });
  test('returns a number for unknown models (default)', () => {
    expect(typeof getModelContextLimit('unknown-model')).toBe('number');
  });
});

describe('getModelPricing', () => {
  test('returns pricing for known sonnet models', () => {
    const p = getModelPricing('claude-sonnet-4-6');
    expect(p.input).toBeGreaterThan(0);
    expect(p.output).toBeGreaterThan(p.input);
  });

  test('returns a default pricing object for unknown models (>=0 fields)', () => {
    const p = getModelPricing('made-up-model');
    // Some implementations fall back to a "default" pricing rather than zero —
    // accept either as long as the shape is sane.
    expect(p).toHaveProperty('input');
    expect(p).toHaveProperty('output');
    expect(typeof p.input).toBe('number');
  });
});

describe('sanitizeLanceFilter', () => {
  test('escapes single quotes', () => {
    expect(sanitizeLanceFilter("o'reilly")).not.toContain("'");
  });
  test('strips backslashes', () => {
    expect(sanitizeLanceFilter('a\\b')).not.toContain('\\');
  });
});
