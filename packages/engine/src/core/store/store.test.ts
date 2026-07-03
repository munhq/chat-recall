/**
 * Tests for the StorageDriver seam. Three layers:
 *
 *   1. BEHAVIOR (dual-backend) — the same suite runs against SQLite AND, when
 *      DATABASE_URL is set, Postgres. Proves both backends are semantically
 *      correct, not just that the wrappers compile.
 *   2. WIRING PARITY (sqlite) — wrapper output === underlying class output, to
 *      catch a method that delegates to the wrong inner method.
 *   3. TEAMS (postgres) — two tenants never see each other's rows.
 *
 * Temp dbs/dirs per test; a fresh Postgres tenant per test for isolation.
 * Never touches the user's real ~/.chat-recall.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { MemoryStore } from '../memory-store.js';
import { MetadataCache } from '../metadata-cache.js';
import { SqliteStore } from './sqlite.js';
import { createStore, resolveBackend, type StorageDriver } from './index.js';
import { SqliteMetadataCache, createMetadataCache, createOutcomeCache, SqliteOutcomeCache } from './caches.js';
import { SqliteKnowledgeGraph, createKnowledgeGraph } from './knowledge-graph.js';
import { createVectorStore } from './vector.js';
import { FileWal, FileDiary, createDiary, createWal } from './journals.js';
import type { MemoryItem, MemoryChunk } from '../../types/memory.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;

function item(id: string, sourceType: MemoryItem['sourceType'] = 'plan'): MemoryItem {
  return { id, sourceType, title: id, projectPath: '/repo/x', contentPreview: `preview ${id}`, filePath: `/repo/x/${id}.ts`, mtime: 1000, extra: { tool: 'claude' } };
}
function chunk(itemId: string, text: string, sourceType: MemoryItem['sourceType'] = 'plan'): MemoryChunk {
  return { chunkId: `${itemId}_c1`, itemId, sourceType, title: itemId, text, chunkType: 'body', projectPath: '/repo/x', filePath: `/repo/x/${itemId}.ts`, mtime: 1000 };
}

interface Harness { store: StorageDriver; teardown: () => Promise<void>; }

let pgTenantSeq = 0;
function makeSqlite(): () => Promise<Harness> {
  return async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cr-store-'));
    const dbPath = join(tmp, 't.db');
    new MetadataCache(dbPath).close();  // create session_metadata so session setItem works
    const store = await createStore({ sqlitePath: dbPath });
    return { store, teardown: async () => { await store.close(); rmSync(tmp, { recursive: true, force: true }); } };
  };
}
function makePostgres(): () => Promise<Harness> {
  return async () => {
    const tenant = `test_${++pgTenantSeq}_${process.pid}`;  // unique tenant per test = isolation
    const store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant } as any);
    return { store, teardown: async () => { await store.close(); } };
  };
}

// ── Behavior suite, parametrized over backends ─────────────────────
function behaviorSuite(label: string, setup: () => Promise<Harness>) {
  describe(`StorageDriver behavior — ${label}`, () => {
    let h: Harness;
    let store: StorageDriver;
    beforeEach(async () => { h = await setup(); store = h.store; });
    afterEach(async () => { await h.teardown(); });

    test('metadata round-trip', async () => {
      await store.setItem(item('p1'));
      expect((await store.getItem('p1', 'plan'))?.title).toBe('p1');
      expect(await store.getItem('missing', 'plan')).toBeNull();
    });

    test('needsUpdate true for missing + stale', async () => {
      expect(await store.needsUpdate('missing', 'plan', 1)).toBe(true);
      await store.setItem(item('p1'));
      expect(await store.needsUpdate('p1', 'plan', 9999)).toBe(true);
    });

    test('links round-trip both directions', async () => {
      await store.addLink({ sourceType: 'plan', sourceId: 'p1', targetType: 'session', targetId: 's1', linkType: 'task_in_session', confidence: 1 });
      expect((await store.getLinksFrom('plan', 'p1')).length).toBe(1);
      expect((await store.getLinksTo('session', 's1')).length).toBe(1);
      expect((await store.getAllLinks('plan', 'p1')).length).toBe(1);
      expect(await store.getLinkCount()).toBe(1);
    });

    test('secret findings: replace is idempotent + readers see it', async () => {
      await store.setItem(item('p1'));
      await store.replaceSecretFindings('p1', [
        { detector: 'gitleaks', rule: 'AWS', line: 1, preview: '****QVGY', verified: true },
        { detector: 'trufflehog', rule: 'AWS', line: 1, preview: '****QVGY', verified: true },
        { detector: 'gitleaks', rule: 'GH', line: 5, preview: '****ABCD' },
      ]);
      expect((await store.secretFindingsForSession('p1')).length).toBe(3);
      await store.replaceSecretFindings('p1', [{ detector: 'gitleaks', rule: 'AWS', line: 1, preview: '****QVGY', verified: true }]);
      expect((await store.secretFindingsForSession('p1')).length).toBe(1);
      expect((await store.secretFindingsSummary()).sessionsWithFindings).toBe(1);
    });

    test('secret findings rollups (byProject / byRule / byDistinctSecret)', async () => {
      await store.setItem(item('s1', 'session'));
      await store.replaceSecretFindings('s1', [
        { detector: 'gitleaks', rule: 'AWS', line: 1, preview: '****QVGY', verified: true },
        { detector: 'trufflehog', rule: 'AWS', line: 1, preview: '****QVGY', verified: true },
      ]);
      const byProject = await store.secretFindingsByProject();
      expect(byProject.length).toBeGreaterThanOrEqual(1);
      const byRule = await store.secretFindingsByRule();
      expect(byRule.find(r => r.rule === 'AWS')?.distinctSecrets).toBe(1);
      const distinct = await store.secretFindingsByDistinctSecret();
      const qvgy = distinct.find(d => d.preview === '****QVGY');
      expect(qvgy?.detectors.sort()).toEqual(['gitleaks', 'trufflehog']);
      expect(qvgy?.verified).toBe(true);
      expect(await store.secretCrossSessionCount('****QVGY', 'other')).toBe(1);
    });

    test('secret rules upsert/list(enabled)/delete', async () => {
      const { id } = await store.upsertSecretRule({ name: 'r1', regex: 'AKIA[0-9A-Z]{16}', severity: 'high' });
      expect((await store.listSecretRules()).find(r => r.name === 'r1')?.enabled).toBe(1);
      await store.deleteSecretRule(id);
      expect((await store.listSecretRules()).find(r => r.name === 'r1')).toBeUndefined();
    });

    test('dismissals set/get/clear', async () => {
      await store.setSecretDismissal('****QVGY', 'rotated', 'done');
      expect((await store.getSecretDismissals()).get('****QVGY')?.status).toBe('rotated');
      await store.clearSecretDismissal('****QVGY');
      expect((await store.getSecretDismissals()).has('****QVGY')).toBe(false);
    });

    test('FTS index + search + counts', async () => {
      await store.addChunksFTS([chunk('p1', 'implement oauth login flow'), chunk('p2', 'docker compose postgres')]);
      expect((await store.searchFTS('oauth')).map(h => h.itemId)).toContain('p1');
      expect(await store.getFTSCount()).toBe(2);
      expect(await store.countDistinctItemsMatching('postgres')).toBe(1);
      // Multi-word natural-language query matches ANY term (OR), not ALL (AND).
      // No single chunk contains both "oauth" and "postgres"; the old pg path
      // used websearch_to_tsquery, which ANDs terms and returned nothing here.
      const multi = (await store.searchFTS('oauth postgres')).map(h => h.itemId);
      expect(multi).toContain('p1');
      expect(multi).toContain('p2');
      expect(await store.countDistinctItemsMatching('oauth postgres')).toBe(2);
    });

    test('project filter is a path SUBSTRING, not an exact project_id', async () => {
      // `-p` sends a cleartext path substring; it must match project_path, not
      // an exact project_id (the bug: exact-id match returned nothing for every
      // real query). Two chunks in different project paths:
      const base = { chunkType: 'body', filePath: '/x.ts', mtime: 1000, sourceType: 'plan' as const };
      await store.addChunksFTS([
        { ...base, chunkId: 'a_c1', itemId: 'a1', title: 'a1', text: 'oauth login', projectPath: '/home/me/code/alpha' },
        { ...base, chunkId: 'b_c1', itemId: 'b1', title: 'b1', text: 'oauth login', projectPath: '/home/me/code/beta' },
      ]);
      const hits = (await store.searchFTS('oauth', { projectIdFilter: 'code/alpha' })).map(h => h.itemId);
      expect(hits).toContain('a1');
      expect(hits).not.toContain('b1');
      // A substring matching neither narrows to empty.
      expect((await store.searchFTS('oauth', { projectIdFilter: 'nonexistent-proj' })).length).toBe(0);
    });

    test('content cache set/get with mtime gate', async () => {
      await store.setCachedContent('p1', 'plan', 1000, '{"x":1}');
      expect(await store.getCachedContent('p1', 'plan', 1000)).toBe('{"x":1}');
      expect(await store.getCachedContent('p1', 'plan', 2000)).toBeNull();
    });

    test('kv set/get/delete/list', async () => {
      await store.kvSet('scope', 'k', 'v');
      expect((await store.kvGet('scope', 'k'))?.value).toBe('v');
      expect((await store.kvList('scope')).length).toBe(1);
      expect(await store.kvDelete('scope', 'k')).toBe(true);
      expect(await store.kvGet('scope', 'k')).toBeNull();
    });

    test('listItems / getStats / clear / delete / updateProjectPath / querySessionIndex', async () => {
      await store.setItem(item('p1'));
      await store.setItem(item('p2'));
      expect((await store.listItems('plan', 10)).length).toBe(2);
      expect((await store.getStats()).plan).toBe(2);
      expect(await store.updateItemProjectPath('p1', 'plan', '/new/path')).toBe(true);
      expect((await store.getItem('p1', 'plan'))?.project_path).toBe('/new/path');
      await store.setItem(item('s1', 'session'));
      const idx = await store.querySessionIndex({ limit: 10, offset: 0, includeUntracked: true });
      expect(idx.total).toBe(1);
      await store.deleteItem('p1', 'plan');
      expect(await store.getItem('p1', 'plan')).toBeNull();
      await store.clearSourceType('plan');
      expect((await store.listItems('plan', 10)).length).toBe(0);
    });

    test('querySessionIndex project filter: bare term = substring, typed id = exact', async () => {
      // A bare human term (CLI/MCP `recall_recent project_filter:repo`) must
      // match project_path as a substring — exact `project_id=` matched nothing,
      // which is why the filtered feed always came back empty.
      await store.setItem({ ...item('s1', 'session'), projectPath: '/home/u/code/chat-recall' });
      await store.setItem({ ...item('s2', 'session'), projectPath: '/home/u/code/inco-monorepo' });

      const bare = await store.querySessionIndex({ limit: 10, offset: 0, projectIdFilter: 'chat-recall', includeUntracked: true });
      expect(bare.total).toBe(1);
      expect(bare.rows[0].id).toBe('s1');

      // Case-insensitive substring.
      const ci = await store.querySessionIndex({ limit: 10, offset: 0, projectIdFilter: 'INCO', includeUntracked: true });
      expect(ci.total).toBe(1);
      expect(ci.rows[0].id).toBe('s2');

      // No match → genuinely empty (the MCP now says "no match", not "no data").
      const none = await store.querySessionIndex({ limit: 10, offset: 0, projectIdFilter: 'does-not-exist', includeUntracked: true });
      expect(none.total).toBe(0);

      // A typed logical id (contains a scheme colon) stays an exact match, so the
      // sidebar's `path:`/`git:`/`ws:` filters don't accidentally substring.
      const typed = await store.querySessionIndex({ limit: 10, offset: 0, projectIdFilter: 'path:/no/such/id', includeUntracked: true });
      expect(typed.total).toBe(0);
    });
  });
}

behaviorSuite('sqlite', makeSqlite());
if (PG_URL) behaviorSuite('postgres', makePostgres());
else describe.skip('StorageDriver behavior — postgres (DATABASE_URL not set)', () => { test('skipped', () => {}); });

// ── Teams: postgres tenant isolation ──────────────────────────────
(PG_URL ? describe : describe.skip)('Postgres teams — tenant isolation', () => {
  test('two tenants never see each other rows', async () => {
    const a = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: `teamA_${process.pid}` } as any);
    const b = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: `teamB_${process.pid}` } as any);
    try {
      await a.clearSourceType('plan'); await b.clearSourceType('plan');
      await a.setItem(item('secretA', 'plan'));
      await a.kvSet('s', 'k', 'A-only');
      // Team B must not see Team A's item or kv.
      expect(await b.getItem('secretA', 'plan')).toBeNull();
      expect((await b.listItems('plan', 10)).length).toBe(0);
      expect(await b.kvGet('s', 'k')).toBeNull();
      // Team A still sees its own.
      expect((await a.getItem('secretA', 'plan'))?.title).toBe('secretA');
      expect((await a.kvGet('s', 'k'))?.value).toBe('A-only');
    } finally { await a.close(); await b.close(); }
  });
});

// ── Postgres FTS: recency tiebreaker ──────────────────────────────
// Near-equal relevance → newer session wins; clearly stronger relevance still
// wins across bands (recency only breaks ties, never overrides a better match).
(PG_URL ? describe : describe.skip)('Postgres FTS — recency tiebreaker', () => {
  test('newer wins among near-equal relevance; stronger relevance still wins', async () => {
    const store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: `fts_${process.pid}` } as any);
    const ftsChunk = (id: string, text: string, mtime: number): MemoryChunk => ({
      chunkId: `${id}_c1`, itemId: id, sourceType: 'session', title: id, text,
      chunkType: 'body', projectPath: '/x', filePath: `/x/${id}`, mtime,
    });
    try {
      await store.clearFTS();
      // "Stronger" under length-normalized ts_rank means matching MORE query
      // terms, not repeating one term (repetition dominance is exactly what
      // normalization flag 1 kills). Realistic mtimes so the +0.15·exp(−age/14d)
      // recency bonus is what separates newer from older, not the mtime
      // tiebreak; strong_old is a month old — its full-match rank (2× a
      // one-term match, normalized 1.0 vs 0.5) must still beat bonus-boosted
      // weak matches.
      const now = Date.now();
      await store.addChunksFTS([
        ftsChunk('newer', 'alpha beta', now),                            // same text as older →
        ftsChunk('older', 'alpha beta', now - 7 * 86400000),             // same rank → same band
        ftsChunk('strong_old', 'alpha gamma', now - 30 * 86400000),      // matches both terms → higher band
      ]);
      // addChunksFTS persists immediately on both backends — no buffer to flush
      // (flushBuffer lives on the vector store, not the StorageDriver).
      const order = (await store.searchFTS('alpha gamma', { topK: 10 })).map(r => r.itemId);
      // Stronger match ranks first even though it is the oldest (relevance > recency across bands).
      expect(order[0]).toBe('strong_old');
      // Equal relevance → the newer session ranks above the older one.
      expect(order.indexOf('newer')).toBeLessThan(order.indexOf('older'));
    } finally { await store.close(); }
  });
});

// ── Wiring parity (sqlite-only: compares against the wrapped MemoryStore) ──
describe('SqliteStore — wiring parity (wrapper === inner)', () => {
  let store: SqliteStore;
  let tmp: string;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'cr-parity-'));
    const dbPath = join(tmp, 't.db');
    new MetadataCache(dbPath).close();
    store = new SqliteStore(dbPath);
    await store.setItem(item('s1', 'session'));
    await store.setItem(item('p1', 'plan'));
    await store.addLink({ sourceType: 'plan', sourceId: 'p1', targetType: 'session', targetId: 's1', linkType: 'task_in_session', confidence: 1 });
    await store.addChunksFTS([chunk('s1', 'oauth login flow', 'session')]);
    await store.replaceSecretFindings('s1', [{ detector: 'gitleaks', rule: 'AWS', line: 1, preview: '****QVGY', verified: true }]);
    await store.upsertSecretRule({ name: 'r1', regex: 'x', severity: 'low' });
    await store.setSecretDismissal('****QVGY', 'dismissed');
    await store.kvSet('s', 'k', 'v');
    await store.setCachedContent('p1', 'plan', 1000, 'cached');
  });
  afterEach(async () => { await store.close(); rmSync(tmp, { recursive: true, force: true }); });

  const READ_CALLS: Array<[string, unknown[]]> = [
    ['getItem', ['s1', 'session']], ['needsUpdate', ['s1', 'session', 1]], ['listItems', ['plan', 10, 0]],
    ['listItemsByProject', ['plan', '/repo/x', 10]], ['listItemsByProjectId', [null, '', 0]],
    ['listAllProjectIdPaths', []], ['listProjectsSummary', []], ['listAllSessionsForPrecompute', []],
    ['listAllSessionProjectPaths', []], ['listSessionsModifiedSince', [0]], ['listAllSessionPaths', []],
    ['querySessionIndex', [{ limit: 10, offset: 0, includeUntracked: true }]], ['getStats', []],
    ['getLinksFrom', ['plan', 'p1']], ['getLinksTo', ['session', 's1']], ['getAllLinks', ['plan', 'p1']],
    ['getLinkCount', []], ['getCachedContent', ['p1', 'plan', 1000]], ['secretFindingsSummary', []],
    ['secretFindingsBySession', []], ['secretFindingsByProject', []], ['secretFindingsTrend', [30]],
    ['secretFindingsByRule', []], ['secretFindingsByDistinctSecret', []], ['secretCrossSessionCount', ['****QVGY', 'other']],
    ['secretFindingsForSession', ['s1']], ['listSecretRules', []], ['getSecretDismissals', []],
    ['searchFTS', ['oauth']], ['getFTSCount', []], ['countDistinctItemsMatching', ['oauth']],
    ['kvGet', ['s', 'k']], ['kvList', ['s']],
  ];
  test.each(READ_CALLS)('%s delegates to the same inner method', async (method, args) => {
    const viaWrapper = await (store as any)[method](...args);
    const viaInner = (store.inner as any)[method](...args);
    expect(viaWrapper).toEqual(viaInner);
  });
});

describe('SqliteMetadataCache', () => {
  let tmp: string; let mc: SqliteMetadataCache;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cr-mc-')); mc = new SqliteMetadataCache(new MetadataCache(join(tmp, 't.db'))); });
  afterEach(async () => { await mc.close(); rmSync(tmp, { recursive: true, force: true }); });
  test('set/get round-trip', async () => {
    await mc.set({ sessionId: 's1', firstPrompt: 'hi', summary: 'did x', summarySource: 'gemini', mtime: 5, indexedAt: 6 });
    const got = await mc.get('s1');
    expect(got?.summary).toBe('did x'); expect(got?.summarySource).toBe('gemini');
    expect(await mc.get('missing')).toBeNull();
  });
  test('compute cache + summary errors', async () => {
    await mc.setCompute('s1', 'turns', 5, { found: true });
    expect((await mc.getRawComputeRow('s1', 'turns'))?.mtime).toBe(5);
    await mc.recordSummaryError('s1', 'boom');
    expect((await mc.getSummaryError('s1'))?.error).toBe('boom');
    await mc.clearSummaryError('s1');
    expect(await mc.getSummaryError('s1')).toBeNull();
  });
});

describe('SqliteOutcomeCache', () => {
  let tmp: string; let oc: SqliteOutcomeCache;
  const rec = (sessionId: string) => ({ sessionId, tool: 'claude', status: 'shipped' as const, reason: 'merged', fileMtime: 1, fileSize: 2, contentHash: 'h', fileCount: 1, linesAdded: 10, linesRemoved: 2, commits: 1, isFull: true, lastScannedOffset: 0 });
  beforeEach(async () => { tmp = mkdtempSync(join(tmpdir(), 'cr-oc-')); oc = await createOutcomeCache({ sqlitePath: join(tmp, 't.db') }) as SqliteOutcomeCache; });
  afterEach(async () => { await oc.close(); rmSync(tmp, { recursive: true, force: true }); });
  test('put/get + getMany + invalidate', async () => {
    await oc.put(rec('s1'));
    expect((await oc.get('s1'))?.status).toBe('shipped');
    await oc.putMany([rec('s2'), rec('s3')]);
    expect((await oc.getMany(['s1', 's2', 's3'])).size).toBe(3);
    await oc.invalidate('s1');
    expect(await oc.get('s1')).toBeNull();
  });
});

describe('SqliteKnowledgeGraph', () => {
  let tmp: string; let kg: SqliteKnowledgeGraph;
  beforeEach(async () => { tmp = mkdtempSync(join(tmpdir(), 'cr-kg-')); kg = await createKnowledgeGraph({ sqlitePath: join(tmp, 'kg.db') }) as SqliteKnowledgeGraph; });
  afterEach(async () => { await kg.close(); rmSync(tmp, { recursive: true, force: true }); });
  test('addTriple → queryEntity → stats', async () => {
    await kg.addEntity('chat-recall', 'project');
    await kg.addTriple('chat-recall', 'uses', 'postgres');
    expect((await kg.queryEntity('chat-recall')).some(f => f.predicate === 'uses' && f.object === 'postgres')).toBe(true);
    expect((await kg.stats()).triples).toBeGreaterThanOrEqual(1);
    expect((await kg.listEntities(10)).length).toBeGreaterThanOrEqual(1);
  });
});

describe('FileWal', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cr-wal-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });
  test('log() appends a JSONL line with the operation', async () => {
    await new FileWal(tmp).log('kg_add', { subject: 's', predicate: 'p', object: 'o' });
    const parsed = JSON.parse(readFileSync(join(tmp, 'write_log.jsonl'), 'utf-8').trim().split('\n')[0]);
    expect(parsed.operation).toBe('kg_add');
  });
});

describe('FileDiary', () => {
  let tmp: string; const prev = process.env.CHAT_RECALL_DATA_DIR;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cr-diary-')); process.env.CHAT_RECALL_DATA_DIR = tmp; });
  afterEach(() => { if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = prev; rmSync(tmp, { recursive: true, force: true }); });
  test('write → read round-trip', async () => {
    const d: FileDiary = await createDiary() as FileDiary;
    const id = await d.write({ agent: 'tester', topic: 't', content: 'remembered this', timestamp: '2020-01-01T00:00:00.000Z' });
    expect(typeof id).toBe('string');
    const entries = await d.read('tester', 5);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe('remembered this');
  });
});

// ── Secondary drivers on Postgres (caches / KG / journals) ────────
(PG_URL ? describe : describe.skip)('Postgres secondary drivers', () => {
  let seq = 0;
  const opts = () => ({ backend: 'postgres' as const, databaseUrl: PG_URL, tenant: `sec_${++seq}_${process.pid}` });

  test('PgMetadataCache set/get + compute + summary errors', async () => {
    const mc = await createMetadataCache(opts());
    await mc.set({ sessionId: 's1', firstPrompt: 'hi', summary: 'did x', summarySource: 'gemini', mtime: 5, indexedAt: 6 });
    expect((await mc.get('s1'))?.summary).toBe('did x');
    await mc.setCompute('s1', 'turns', 5, { found: true });
    expect((await mc.getRawComputeRow('s1', 'turns'))?.mtime).toBe(5);
    await mc.recordSummaryError('s1', 'boom');
    expect((await mc.getSummaryError('s1'))?.error).toBe('boom');
    await mc.clearSummaryError('s1');
    expect(await mc.getSummaryError('s1')).toBeNull();
    await mc.close();
  });

  test('PgOutcomeCache put/get/getMany/invalidate', async () => {
    const oc = await createOutcomeCache(opts());
    const rec = (id: string) => ({ sessionId: id, tool: 'claude', status: 'shipped' as const, reason: 'm', fileMtime: 1, fileSize: 2, contentHash: 'h', fileCount: 1, linesAdded: 1, linesRemoved: 0, commits: 1, isFull: true, lastScannedOffset: 0 });
    await oc.put(rec('s1'));
    expect((await oc.get('s1'))?.status).toBe('shipped');
    await oc.putMany([rec('s2'), rec('s3')]);
    expect((await oc.getMany(['s1', 's2', 's3'])).size).toBe(3);
    await oc.invalidate('s1');
    expect(await oc.get('s1')).toBeNull();
    await oc.close();
  });

  test('PgKnowledgeGraph addTriple/queryEntity/stats + temporal invalidate', async () => {
    const kg = await createKnowledgeGraph(opts());
    await kg.addTriple('chat-recall', 'uses', 'postgres');
    expect((await kg.queryEntity('chat-recall')).some(f => f.predicate === 'uses' && f.object === 'postgres' && f.current)).toBe(true);
    expect((await kg.stats()).triples).toBeGreaterThanOrEqual(1);
    await kg.invalidate('chat-recall', 'uses', 'postgres');
    expect((await kg.queryEntity('chat-recall')).some(f => f.current)).toBe(false);
    await kg.close();
  });

  test('PgWal + PgDiary round-trip', async () => {
    const w = await createWal(opts());
    await w.log('kg_add', { subject: 's' });   // no throw
    await (w as any).close?.();
    const d = await createDiary(opts());
    const id = await d.write({ agent: 'tester', topic: 't', content: 'remembered', timestamp: '2020-01-01T00:00:00.000Z' });
    expect(typeof id).toBe('string');
    expect((await d.read('tester', 5))[0]?.content).toBe('remembered');
    await (d as any).close?.();
  });
});

// ── Vector store on Postgres (pgvector + FTS half) ────────────────
// Regression guard for two bugs the relational parity suite never caught
// because it doesn't touch the vector store:
//   1. fractional `stat.mtimeMs` bound to memory_vectors.mtime (BIGINT) threw
//      `invalid input syntax for type bigint` on the vector INSERT — only when
//      pgvector is present so the INSERT actually runs.
//   2. PgVectorStore never wrote the FTS half (memory_chunks) nor fell back to
//      FTS in search(), so keyword search returned nothing in pg mode.
(PG_URL ? describe : describe.skip)('Postgres vector store', () => {
  let seq = 0;
  const opts = () => ({ backend: 'postgres' as const, databaseUrl: PG_URL, tenant: `vec_${++seq}_${process.pid}` });
  // Deterministic 8-dim embedder — no network, stable across runs.
  const vec8 = (s: string) => { const v = new Array(8).fill(0); for (let i = 0; i < s.length; i++) v[i % 8] += s.charCodeAt(i) / 255; return v; };
  const embedder = { dimension: 8, embed: async (t: string[]) => t.map(vec8), embedQuery: async (q: string) => vec8(q) } as any;
  const FRACTIONAL = 1700000000123.456;
  const vchunk = (itemId: string, text: string): MemoryChunk => ({ chunkId: `${itemId}_c1`, itemId, sourceType: 'plan', title: itemId, text, chunkType: 'body', projectPath: '/repo/x', filePath: `/repo/x/${itemId}.ts`, mtime: FRACTIONAL });

  test('indexes chunks with a fractional mtime and serves FTS + vector search', async () => {
    const vs = await createVectorStore(embedder, opts());
    // Fractional mtime must NOT throw (bug #1) — pre-fix this rejected the
    // BIGINT bind on the memory_vectors INSERT.
    await vs.bufferChunks([vchunk('p1', 'postgres storage driver migration'), vchunk('p2', 'unrelated lancedb vector notes')]);
    const written = await vs.flushBuffer();
    expect(written).toBe(2);

    // FTS half is always populated (bug #2): keyword search returns the match.
    const fts = await vs.search('migration', { topK: 5 });
    expect(fts.some(r => r.itemId === 'p1')).toBe(true);
    // mtime is floored to whole ms on the way back, in both FTS and vector rows.
    expect(fts.find(r => r.itemId === 'p1')?.mtime).toBe(Math.floor(FRACTIONAL));

    // When pgvector is available the vector INSERT actually ran: rows exist.
    const health = await (vs as any).getHealth();
    if (health.vectorOk) {
      const stats = await (vs as any).getStats();
      expect(stats.totalChunks).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('createStore factory + resolveBackend', () => {
  test('explicit sqlite backend → SqliteStore', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cr-factory-'));
    const s = await createStore({ backend: 'sqlite', sqlitePath: join(tmp, 't.db') });
    expect(s).toBeInstanceOf(SqliteStore);
    await s.close(); rmSync(tmp, { recursive: true, force: true });
  });
  test('resolveBackend honors env + aliases and is fail-closed', () => {
    const prev = process.env.CHAT_RECALL_STORAGE;
    process.env.CHAT_RECALL_STORAGE = 'pg';
    expect(resolveBackend()).toBe('postgres');
    process.env.CHAT_RECALL_STORAGE = 'sqlite';
    expect(resolveBackend()).toBe('sqlite');
    // No silent fallback: unset or unknown values must throw, never guess.
    delete process.env.CHAT_RECALL_STORAGE;
    expect(() => resolveBackend()).toThrow(/CHAT_RECALL_STORAGE is not set/);
    expect(resolveBackend({ backend: 'sqlite' })).toBe('sqlite');
    process.env.CHAT_RECALL_STORAGE = 'postgress'; // typo must not become sqlite
    expect(() => resolveBackend()).toThrow(/Unrecognized/);
    if (prev !== undefined) process.env.CHAT_RECALL_STORAGE = prev;
    else delete process.env.CHAT_RECALL_STORAGE;
  });
});
