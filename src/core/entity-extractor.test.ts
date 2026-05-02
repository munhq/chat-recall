import { describe, test, expect } from 'vitest';
import { extractEntities } from './entity-extractor.js';

describe('extractEntities', () => {
  test('returns no triples for empty text', () => {
    expect(extractEntities('')).toEqual([]);
  });

  test('extracts a tool/technology mention with category', () => {
    const ts = extractEntities('we use postgres for transactional storage');
    const has = ts.find(t => t.predicate === 'is_a' && t.subject.toLowerCase().includes('postgres'));
    expect(has).toBeDefined();
  });

  test('links tool to project when projectPath is provided', () => {
    const ts = extractEntities('we use docker for dev', { projectPath: '/code/myapp' });
    const usesLink = ts.find(t => t.predicate === 'uses' && t.subject.toLowerCase() === 'myapp');
    expect(usesLink).toBeDefined();
  });

  test('deduplicates identical triples', () => {
    const ts = extractEntities('postgres postgres postgres');
    const isAs = ts.filter(t => t.subject.toLowerCase().includes('postgres') && t.predicate === 'is_a');
    expect(isAs.length).toBeLessThanOrEqual(1);
  });

  test('confidence is bounded to (0, 1]', () => {
    const ts = extractEntities('we use redis and docker', { projectPath: '/p/myapp' });
    for (const t of ts) {
      expect(t.confidence).toBeGreaterThan(0);
      expect(t.confidence).toBeLessThanOrEqual(1);
    }
  });
});
