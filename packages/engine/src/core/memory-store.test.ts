/**
 * Unit tests for MemoryStore — focused on the helpers added in this
 * session, especially countDistinctItemsMatching (the patterns count
 * fix that replaced the topK-capped approach).
 *
 * Uses a temp-file SQLite db per test so we never touch the user's
 * real chat-recall-cache.db.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryStore } from './memory-store.js';
import type { MemoryChunk, MemoryItem } from '../types/memory.js';

let store: MemoryStore;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mem-store-'));
  store = new MemoryStore(join(tmp, 'test.db'));
});
afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

function chunk(itemId: string, text: string, sourceType: 'session' | 'plan' = 'session'): MemoryChunk {
  return {
    chunkId: `${itemId}_c${Math.random().toString(36).slice(2, 6)}`,
    itemId,
    sourceType,
    title: itemId,
    text,
    chunkType: 'test',
    projectPath: '/tmp/proj',
    filePath: '/tmp/proj/x.ts',
    mtime: Date.now(),
  };
}

function item(id: string, sourceType: 'session' | 'plan' = 'session'): MemoryItem {
  return {
    id,
    sourceType,
    title: `Item ${id}`,
    projectPath: '/tmp/proj',
    filePath: '/tmp/proj/x.ts',
    mtime: Date.now(),
  };
}

describe('countDistinctItemsMatching', () => {
  test('returns 0 when no chunks match', () => {
    store.addChunksFTS([chunk('s1', 'hello world')]);
    const n = store.countDistinctItemsMatching('zzzunusedterm');
    expect(n).toBe(0);
  });

  test('counts each session once even with multiple matching chunks', () => {
    // Same itemId across 5 chunks all containing "auth" — should count 1.
    store.addChunksFTS([
      chunk('s1', 'auth setup notes'),
      chunk('s1', 'auth flow follow-up'),
      chunk('s1', 'auth and login wiring'),
      chunk('s1', 'auth review'),
      chunk('s1', 'auth retro'),
    ]);
    expect(store.countDistinctItemsMatching('auth')).toBe(1);
  });

  test('counts multiple distinct sessions', () => {
    store.addChunksFTS([
      chunk('s1', 'docker compose for dev env'),
      chunk('s2', 'docker compose plus k8s'),
      chunk('s3', 'docker container hardening'),
    ]);
    expect(store.countDistinctItemsMatching('docker')).toBe(3);
  });

  test('honors sourceTypes filter', () => {
    store.addChunksFTS([
      chunk('s1', 'docker setup', 'session'),
      chunk('p1', 'docker plan', 'plan'),
    ]);
    expect(store.countDistinctItemsMatching('docker', { sourceTypes: ['session'] })).toBe(1);
    expect(store.countDistinctItemsMatching('docker', { sourceTypes: ['plan']    })).toBe(1);
  });

  test('returns true count past topK*5 — the bug this method fixed', () => {
    // Insert 200 distinct sessions all matching "everywhere".
    const chunks: MemoryChunk[] = [];
    for (let i = 0; i < 200; i++) chunks.push(chunk(`s${i}`, `everywhere indexed ${i}`));
    store.addChunksFTS(chunks);
    const n = store.countDistinctItemsMatching('everywhere');
    expect(n).toBe(200);
    // searchFTS with topK=30 by contrast caps at <=30 distinct sessions —
    // this is exactly the gap the new method closes for the patterns route.
    const ranked = store.searchFTS('everywhere', { topK: 30 });
    expect(ranked.length).toBeLessThanOrEqual(150);
  });

  test('returns 0 for an empty query', () => {
    expect(store.countDistinctItemsMatching('')).toBe(0);
  });
});

describe('FTS phrase / required-token search', () => {
  test('quoted phrase matches the literal sequence, not OR of tokens', () => {
    store.addChunksFTS([
      chunk('s1', 'erpc logs from the ireland production server'),
      chunk('s2', 'logs about erpc misconfiguration unrelated'),
      // Tokens present but not adjacent — should NOT match "erpc logs"
      chunk('s3', 'erpc was down, see logs'),
    ]);
    const phraseHits = store.searchFTS('"erpc logs"', { topK: 10 });
    const ids = phraseHits.map(h => h.itemId);
    expect(ids).toContain('s1');
    expect(ids).not.toContain('s3');
  });

  test('+token enforces required AND match (combined with OR group)', () => {
    store.addChunksFTS([
      chunk('s1', 'docker compose and kubernetes for dev'),
      chunk('s2', 'kubernetes alone for orchestration'),
      chunk('s3', 'docker swarm primer'),
    ]);
    // `+docker kubernetes` → docker AND (kubernetes) — both must match.
    const both = store.searchFTS('+docker kubernetes', { topK: 10 });
    const bothIds = both.map(h => h.itemId);
    expect(bothIds).toContain('s1');
    expect(bothIds).not.toContain('s2'); // missing required docker
    expect(bothIds).not.toContain('s3'); // missing kubernetes from OR group

    // `+docker` alone → only require docker, any other content.
    const onlyDocker = store.searchFTS('+docker', { topK: 10 });
    const ids = onlyDocker.map(h => h.itemId);
    expect(ids).toContain('s1');
    expect(ids).toContain('s3');
    expect(ids).not.toContain('s2');
  });

  test('bare OR search keeps legacy permissive behavior', () => {
    store.addChunksFTS([
      chunk('s1', 'just docker'),
      chunk('s2', 'just kubernetes'),
    ]);
    const hits = store.searchFTS('docker kubernetes', { topK: 10 });
    const ids = hits.map(h => h.itemId);
    expect(ids).toContain('s1');
    expect(ids).toContain('s2');
  });
});

describe('FTS dedup-on-reindex', () => {
  test('re-inserting the same chunk_id does not create duplicate FTS rows', () => {
    const c = chunk('s1', 'hello erpc world');
    store.addChunksFTS([c]);
    store.addChunksFTS([c]);
    store.addChunksFTS([c]);
    // 1 distinct row, not 3
    const hits = store.searchFTS('erpc', { topK: 10 });
    expect(hits.length).toBe(1);
  });
});

describe('listItems', () => {
  test('returns inserted items in mtime-desc order', () => {
    // Use 'plan' (not 'session') — setItem on session triggers a
    // session_metadata table delete that lives in a separate cache schema
    // owned by MetadataCache, not initialized in this isolated MemoryStore.
    store.setItem({ ...item('a', 'plan'), mtime: 100 });
    store.setItem({ ...item('b', 'plan'), mtime: 300 });
    store.setItem({ ...item('c', 'plan'), mtime: 200 });
    const rows = store.listItems('plan', 10, 0);
    expect(rows.map(r => r.id)).toEqual(['b', 'c', 'a']);
  });
});
