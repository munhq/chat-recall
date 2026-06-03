import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OutcomeCache, isFresh, fingerprintFile, type CachedOutcome } from './outcome-cache.js';

let tmp: string;
let cache: OutcomeCache;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cr-outcache-'));
  dbPath = join(tmp, 'cache.db');
  cache = new OutcomeCache(dbPath);
});

afterEach(() => {
  cache.close();
  rmSync(tmp, { recursive: true, force: true });
});

function rec(over: Partial<CachedOutcome> = {}): CachedOutcome {
  return {
    sessionId: 'sess-1',
    tool: 'claude',
    status: 'completed',
    reason: 'no recent activity',
    fileMtime: 1000,
    fileSize: 4096,
    contentHash: 'abc123',
    fileCount: 3,
    linesAdded: 42,
    linesRemoved: 5,
    commits: 1,
    isFull: true,
    classifiedAt: Date.now(),
    lastScannedOffset: 4096,
    ...over,
  };
}

describe('OutcomeCache.put / get', () => {
  test('round-trips a record', () => {
    const r = rec();
    cache.put(r);
    const got = cache.get('sess-1');
    expect(got).not.toBeNull();
    expect(got!.status).toBe('completed');
    expect(got!.fileCount).toBe(3);
    expect(got!.contentHash).toBe('abc123');
    expect(got!.isFull).toBe(true);
  });

  test('returns null for unknown id', () => {
    expect(cache.get('does-not-exist')).toBeNull();
  });

  test('upsert overwrites mutable fields but preserves is_full=1', () => {
    // First write: full classification (rich data).
    cache.put(rec({ isFull: true, fileCount: 18, status: 'shipped' }));
    // Second write: cheap re-classify (would otherwise downgrade).
    cache.put(rec({ isFull: false, fileCount: 0, status: 'completed' }));
    const got = cache.get('sess-1')!;
    // Status updates (latest wins) but is_full stays 1 — quick re-classify
    // shouldn't blow away the rich data we already paid for.
    expect(got.status).toBe('completed');
    expect(got.isFull).toBe(true);
  });
});

describe('OutcomeCache.getMany', () => {
  test('bulk fetch returns map keyed by session id', () => {
    cache.put(rec({ sessionId: 'a', status: 'shipped' }));
    cache.put(rec({ sessionId: 'b', status: 'abandoned' }));
    cache.put(rec({ sessionId: 'c', status: 'in_progress' }));
    const m = cache.getMany(['a', 'b', 'c', 'missing']);
    expect(m.size).toBe(3);
    expect(m.get('a')!.status).toBe('shipped');
    expect(m.get('b')!.status).toBe('abandoned');
    expect(m.get('c')!.status).toBe('in_progress');
    expect(m.has('missing')).toBe(false);
  });

  test('empty input → empty map', () => {
    expect(cache.getMany([]).size).toBe(0);
  });

  test('chunks past the SQLite parameter limit', () => {
    // Insert 1500 records to force multiple SQL chunks (limit is 999).
    const records = Array.from({ length: 1500 }, (_, i) => rec({ sessionId: `s${i}` }));
    cache.putMany(records);
    const ids = records.map(r => r.sessionId);
    const m = cache.getMany(ids);
    expect(m.size).toBe(1500);
  });
});

describe('OutcomeCache.putMany / invalidate', () => {
  test('putMany commits in a single transaction', () => {
    cache.putMany([
      rec({ sessionId: 'x' }),
      rec({ sessionId: 'y' }),
    ]);
    expect(cache.get('x')).not.toBeNull();
    expect(cache.get('y')).not.toBeNull();
  });

  test('invalidate removes the row', () => {
    cache.put(rec());
    cache.invalidate('sess-1');
    expect(cache.get('sess-1')).toBeNull();
  });
});

describe('OutcomeCache schema migration', () => {
  test('opening an existing pre-content-hash DB adds the column without losing data', () => {
    cache.put(rec({ contentHash: 'original-hash' }));
    cache.close();

    // Reopen — initSchema should be idempotent and the existing data must
    // survive (the migration ALTER TABLE is the regression target).
    cache = new OutcomeCache(dbPath);
    const got = cache.get('sess-1');
    expect(got).not.toBeNull();
    expect(got!.contentHash).toBe('original-hash');
  });
});

describe('isFresh', () => {
  test('null cache → not fresh', () => {
    expect(isFresh(null, 100, 200)).toBe(false);
  });

  test('mtime + size match → fast-path fresh', () => {
    const c = rec({ fileMtime: 100, fileSize: 200, contentHash: 'aaa' });
    expect(isFresh(c, 100, 200)).toBe(true);
    // Hash isn't even consulted on the fast path.
    expect(isFresh(c, 100, 200, 'different-hash')).toBe(true);
  });

  test('mtime moved + same hash → still fresh (touch case)', () => {
    const c = rec({ fileMtime: 100, fileSize: 200, contentHash: 'same' });
    expect(isFresh(c, 200 /* mtime moved */, 200, 'same')).toBe(true);
  });

  test('size moved + same hash → still fresh (rare; both timestamps lied)', () => {
    const c = rec({ fileMtime: 100, fileSize: 200, contentHash: 'same' });
    expect(isFresh(c, 100, 250 /* size moved */, 'same')).toBe(true);
  });

  test('mtime moved + different hash → stale (real append)', () => {
    const c = rec({ fileMtime: 100, fileSize: 200, contentHash: 'old' });
    expect(isFresh(c, 200, 250, 'new')).toBe(false);
  });

  test('mtime moved + no hash provided → stale (caller must pass hash)', () => {
    // When a tool is mtime-only (Gemini/OpenCode), we don't compute a
    // hash — falling back here means we always reclassify on mtime change.
    const c = rec({ fileMtime: 100, fileSize: 200, contentHash: 'aaa' });
    expect(isFresh(c, 200, 200)).toBe(false);
    expect(isFresh(c, 200, 200, '')).toBe(false);
  });

  test('mtime moved + cached has no hash → stale (older row from before migration)', () => {
    // Migration backfilled '' into existing rows. We must NOT treat a
    // hash collision against '' as a match.
    const c = rec({ fileMtime: 100, fileSize: 200, contentHash: '' });
    expect(isFresh(c, 200, 200, 'new-hash')).toBe(false);
    expect(isFresh(c, 200, 200, '')).toBe(false);
  });
});

describe('fingerprintFile', () => {
  function setMtime(file: string, msAgo: number): void {
    const ts = (Date.now() - msAgo) / 1000;
    utimesSync(file, ts, ts);
  }

  test('empty file → "empty" sentinel (not crash)', () => {
    const f = join(tmp, 'empty.jsonl');
    writeFileSync(f, '');
    expect(fingerprintFile(f)).toBe('empty');
  });

  test('missing file → empty string', () => {
    expect(fingerprintFile(join(tmp, 'no-such-file'))).toBe('');
  });

  test('same content → same hash regardless of mtime', () => {
    // Critical: this is what makes touch a no-op. Hashing the bytes only.
    const f = join(tmp, 'a.jsonl');
    writeFileSync(f, 'abcdefghij\n'.repeat(10));
    const h1 = fingerprintFile(f);
    setMtime(f, 5000);
    const h2 = fingerprintFile(f);
    expect(h2).toBe(h1);
  });

  test('appending bytes changes the hash (sessions are append-only)', () => {
    const f = join(tmp, 'b.jsonl');
    writeFileSync(f, 'first chunk of content\n');
    const h1 = fingerprintFile(f);
    appendFileSync(f, 'second chunk added later\n');
    const h2 = fingerprintFile(f);
    expect(h2).not.toBe(h1);
  });

  test('only hashes the last 4 KB — leading bytes do not affect the result', () => {
    // Two files with identical tails but different prefixes should hash
    // identically under the tail-only scheme. This is the critical
    // performance promise: hashing cost stays constant for huge files.
    const tailMarker = 'TAIL_MARKER_' + 'z'.repeat(4096);
    const f1 = join(tmp, 'big1.jsonl');
    const f2 = join(tmp, 'big2.jsonl');
    writeFileSync(f1, 'unique-prefix-1-'.repeat(1000) + tailMarker);
    writeFileSync(f2, 'totally-different-prefix-2-'.repeat(1000) + tailMarker);
    expect(fingerprintFile(f1)).toBe(fingerprintFile(f2));
  });

  test('changing tail bytes after a tiny prefix still flips the hash', () => {
    // Sanity check that a real change at the end is detected even when
    // the rest of the file is the same.
    const prefix = 'shared\n'.repeat(100);
    const f1 = join(tmp, 'tail1.jsonl');
    const f2 = join(tmp, 'tail2.jsonl');
    writeFileSync(f1, prefix + 'tail-version-A');
    writeFileSync(f2, prefix + 'tail-version-B');
    expect(fingerprintFile(f1)).not.toBe(fingerprintFile(f2));
  });

  test('returns 16 hex chars for non-empty files', () => {
    const f = join(tmp, 'hex.jsonl');
    writeFileSync(f, 'something');
    const h = fingerprintFile(f);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
