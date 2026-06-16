import { describe, test, expect, afterEach } from 'vitest';
import { isFuzzyFinding, dropFuzzyFindings, keepFuzzyFindings } from './secret-precision.js';

afterEach(() => { delete process.env.CHAT_RECALL_INCLUDE_FUZZY; });

describe('secret precision policy — fuzzy detectors off by default', () => {
  test('fuzzy rules are flagged regardless of detector or case', () => {
    expect(isFuzzyFinding('gitleaks', 'generic-api-key')).toBe(true);
    expect(isFuzzyFinding('trufflehog', 'Box')).toBe(true);   // TitleCase
    expect(isFuzzyFinding('trufflehog', 'URI')).toBe(true);
  });

  test('high-precision rules are kept', () => {
    expect(isFuzzyFinding('builtin', 'env-secret')).toBe(false);
    expect(isFuzzyFinding('builtin', 'aws-access-token')).toBe(false);
    expect(isFuzzyFinding('builtin', 'github-pat')).toBe(false);
    expect(isFuzzyFinding('trufflehog', 'Postgres')).toBe(false);     // real connection strings
    expect(isFuzzyFinding('trufflehog', 'GoogleGeminiAPIKey')).toBe(false);
  });

  test('dropFuzzyFindings strips fuzzy by default, keeps with env opt-in', () => {
    const findings = [
      { detector: 'builtin', rule: 'env-secret' },
      { detector: 'gitleaks', rule: 'generic-api-key' },
      { detector: 'trufflehog', rule: 'Box' },
      { detector: 'builtin', rule: 'github-pat' },
    ];
    const pick = (f: { detector: string; rule: string }) => f;
    const dropped = dropFuzzyFindings(findings, pick);
    expect(dropped.map(f => f.rule)).toEqual(['env-secret', 'github-pat']);

    process.env.CHAT_RECALL_INCLUDE_FUZZY = '1';
    expect(keepFuzzyFindings()).toBe(true);
    expect(dropFuzzyFindings(findings, pick)).toHaveLength(4);
  });
});
