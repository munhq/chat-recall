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
    // set() never writes user_title, so a freshly-set row reads back null.
    expect(got).toEqual({ ...sample, userTitle: null });
  });

  test('setUserTitle round-trips and set() never clobbers it', () => {
    cache.set(sample);
    cache.setUserTitle('s1', 'auth refactor');
    expect(cache.get('s1')!.userTitle).toBe('auth refactor');

    // The indexer/summary worker re-running set() must NOT wipe the name —
    // this is the core invariant of the rename feature.
    cache.set({ ...sample, summary: 'regenerated', mtime: 9000 });
    const got = cache.get('s1')!;
    expect(got.userTitle).toBe('auth refactor');
    expect(got.summary).toBe('regenerated');

    // Empty/null clears it back to the auto title.
    cache.setUserTitle('s1', null);
    expect(cache.get('s1')!.userTitle).toBeNull();
  });

  test('setUserTitle creates a stub row when none exists yet', () => {
    cache.setUserTitle('ghost', 'named before indexed');
    const got = cache.get('ghost')!;
    expect(got.userTitle).toBe('named before indexed');
    expect(got.summary).toBe('');
  });

  test('get returns null for unknown id', () => {
    expect(cache.get('nope')).toBeNull();
  });

  test('upsert (ON CONFLICT) keeps latest values', () => {
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
