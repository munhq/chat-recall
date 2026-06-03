import { describe, test, expect } from 'vitest';
import { normalizeProjectPath, matchesPrefix } from './paths.js';

describe('normalizeProjectPath', () => {
  test('returns empty string for null/undefined/empty', () => {
    expect(normalizeProjectPath(null)).toBe('');
    expect(normalizeProjectPath(undefined)).toBe('');
    expect(normalizeProjectPath('')).toBe('');
    expect(normalizeProjectPath('  ')).toBe('');
  });

  test('normalizes backslashes to forward slashes', () => {
    expect(normalizeProjectPath('C:\\Users\\me')).toContain('/');
  });

  test('collapses multiple slashes to a single slash', () => {
    expect(normalizeProjectPath('/home//adi///code')).toBe('/home/user/code');
  });

  test('trims trailing slash', () => {
    expect(normalizeProjectPath('/home/user/code/')).toBe('/home/user/code');
    // Single "/" is preserved
    expect(normalizeProjectPath('/')).toBe('/');
  });
});

describe('matchesPrefix', () => {
  test('exact match', () => {
    expect(matchesPrefix('/home/user/code', '/home/user/code')).toBe(true);
  });

  test('candidate is a child of folder', () => {
    expect(matchesPrefix('/home/user/code/proj', '/home/user/code')).toBe(true);
  });

  test('candidate is unrelated', () => {
    expect(matchesPrefix('/home/user/other', '/home/user/code')).toBe(false);
  });

  test('matching is case-sensitive (paths are case-sensitive on Linux)', () => {
    expect(matchesPrefix('/HOME/adi/code', '/home/user/code')).toBe(false);
  });

  test('handles empty inputs', () => {
    expect(matchesPrefix('', '/home')).toBe(false);
  });
});
