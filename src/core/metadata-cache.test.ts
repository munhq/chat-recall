import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MetadataCache } from './metadata-cache.js';

let cache: MetadataCache;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'meta-'));
  cache = new MetadataCache(join(tmp, 'meta.db'));
});
afterEach(() => {
  cache.close();
  rmSync(tmp, { recursive: true, force: true });
});

const sample = {
  sessionId: 's1',
  firstPrompt: 'hello',
  summary: 'said hi',
  summarySource: 'gemini' as const,
  mtime: 1000,
  indexedAt: 2000,
};

describe('MetadataCache', () => {
  test('set + get round-trips a row', () => {
    cache.set(sample);
    const got = cache.get('s1');
    expect(got).toEqual(sample);
  });

  test('get returns null for unknown id', () => {
    expect(cache.get('nope')).toBeNull();
  });

  test('upsert (INSERT OR REPLACE) keeps latest values', () => {
    cache.set(sample);
    cache.set({ ...sample, summary: 'updated', mtime: 3000 });
    const got = cache.get('s1')!;
    expect(got.summary).toBe('updated');
    expect(got.mtime).toBe(3000);
  });

  test('needsUpdate reflects mtime comparison', () => {
    expect(cache.needsUpdate('s1', 100)).toBe(true);
    cache.set({ ...sample, mtime: 100 });
    expect(cache.needsUpdate('s1', 100)).toBe(false);
    expect(cache.needsUpdate('s1', 101)).toBe(true);
  });

  test('getStats counts by summary source', () => {
    cache.set(sample);
    cache.set({ ...sample, sessionId: 's2', summarySource: 'claude' });
    cache.set({ ...sample, sessionId: 's3', summarySource: 'gemini' });
    const stats = cache.getStats();
    expect(stats.totalSessions).toBe(3);
    expect(stats.bySources.gemini).toBe(2);
    expect(stats.bySources.claude).toBe(1);
  });
});
