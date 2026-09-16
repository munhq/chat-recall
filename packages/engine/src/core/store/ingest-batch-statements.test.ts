/**
 * Acceptance criterion 1: a batch of N sessions costs a FIXED number of
 * statements, whatever N is.
 *
 * This is the criterion the whole change exists for. The ingest used to issue
 * about 17 statements per session — 850 for a 50-session batch — each one a
 * round trip holding a pooled connection, which is how a request came to spend
 * 120 seconds queueing for a connection that a pool of 20 could not give it.
 *
 * Counting is done by wrapping `query` on the pg pool and client prototypes, so
 * what is measured is round trips the application actually made, not what the
 * code appears to do. A statement count read off the source would have missed
 * that the per-table methods each opened their own transaction.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { MemoryItem, MemoryChunk } from '../../types/memory.js';
import type { IngestBatch } from './ingest-batch.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const T = 'ingest_stmt_team';

/** Round trips made while `fn` runs, and how many of them opened a transaction. */
async function counted<T>(fn: () => Promise<T>): Promise<{ result: T; statements: number; transactions: number }> {
  const targets = [pg.Pool.prototype, (pg as any).Client.prototype];
  const originals = targets.map((t: any) => t.query);
  let statements = 0, transactions = 0;
  targets.forEach((t: any, i) => {
    t.query = function (...args: any[]) {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      statements++;
      if (/^\s*BEGIN/i.test(sql)) transactions++;
      return originals[i].apply(this, args);
    };
  });
  try {
    return { result: await fn(), statements, transactions };
  } finally {
    targets.forEach((t: any, i) => { t.query = originals[i]; });
  }
}

const session = (n: number): MemoryItem => ({
  id: `s${n}`, sourceType: 'session', title: `session ${n}`,
  projectPath: '/home/user/code/example', projectId: 'git:github.com/owner/example',
  filePath: '', mtime: 1000 + n, contentPreview: `first prompt ${n}`, extra: { tool: 'claude' },
});

const chunk = (n: number, i: number): MemoryChunk => ({
  chunkId: `s${n}_user_${i}`, itemId: `s${n}`, sourceType: 'session', title: `session ${n}`,
  text: `turn ${i} of session ${n}`, chunkType: 'user',
  projectPath: '/home/user/code/example', projectId: 'git:github.com/owner/example',
  filePath: '', mtime: 1000 + n,
} as MemoryChunk);

/** A realistic batch: each session brings metadata, chunks, content, meta,
 *  four derived computations and a finding — the shape the ingest builds. */
function batchOf(sessions: number, chunksEach: number): IngestBatch {
  const ids = Array.from({ length: sessions }, (_, n) => n);
  return {
    items: ids.map(session),
    chunks: ids.flatMap((n) => Array.from({ length: chunksEach }, (_, i) => chunk(n, i))),
    cachedContent: ids.map((n) => ({ id: `s${n}`, sourceType: 'session', mtime: 1000 + n, content: JSON.stringify({ v: 1, messages: [] }) })),
    sessionMeta: ids.map((n) => ({
      sessionId: `s${n}`, firstPrompt: `first prompt ${n}`, summary: '',
      summarySource: 'original' as const, mtime: 1000 + n, indexedAt: 1,
    })),
    compute: ids.flatMap((n) => ['diff', 'outcome', 'commits', 'markers'].map((kind) => ({
      sessionId: `s${n}`, kind, mtime: 1000 + n, data: { kind, n },
    }))),
    findings: ids.map((n) => ({
      sessionId: `s${n}`,
      findings: [{ detector: 'd', rule: 'r', line: 1, preview: `****${n}` }],
    })),
    links: [],
  };
}

(PG_URL ? describe : describe.skip)('ingest statement count', () => {
  let store: any; let sudo: any;

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: PG_URL });
    const { createStore } = await import('./index.js');
    store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: T } as any);
    for (const t of ['memory_chunks', 'memory_metadata', 'content_cache', 'session_metadata', 'compute_cache', 'secret_findings']) {
      await sudo.query(`DELETE FROM ${t} WHERE tenant=$1`, [T]);
    }
  }, 60000);

  afterAll(async () => {
    try {
      for (const t of ['memory_chunks', 'memory_metadata', 'content_cache', 'session_metadata', 'compute_cache', 'secret_findings']) {
        await sudo.query(`DELETE FROM ${t} WHERE tenant=$1`, [T]);
      }
    } catch { /* best effort */ }
    await store?.close(); await sudo?.end();
  });

  test('CRITERION 1: 5 sessions and 50 sessions cost the same statements', async () => {
    const five = await counted(() => store.writeIngestBatch(batchOf(5, 20)));
    const fifty = await counted(() => store.writeIngestBatch(batchOf(50, 20)));
    // Ten times the sessions, ten times the rows, the same number of round trips.
    expect(fifty.statements).toBe(five.statements);
    // And it is a small fixed number, not a large one that happens to match.
    expect(fifty.statements).toBeLessThan(25);
  }, 120000);

  test('it is ONE transaction, not one per table', async () => {
    // Seven per-table methods each opened their own, so a request took and
    // released a connection seven times and a failure halfway left the tables
    // disagreeing with each other.
    const { transactions } = await counted(() => store.writeIngestBatch(batchOf(10, 20)));
    expect(transactions).toBe(1);
  }, 60000);

  test('chunk volume does not change the statement count either', async () => {
    const thin = await counted(() => store.writeIngestBatch(batchOf(10, 5)));
    const fat = await counted(() => store.writeIngestBatch(batchOf(10, 200)));
    expect(fat.statements).toBe(thin.statements);
  }, 120000);

  test('an empty batch opens no transaction at all', async () => {
    const { statements } = await counted(() => store.writeIngestBatch({}));
    expect(statements).toBe(0);
  });

  test('the rows really landed — the count is not low because nothing was written', async () => {
    const n = (await sudo.query(`SELECT count(*)::int n FROM memory_chunks WHERE tenant=$1`, [T])).rows[0].n;
    expect(n).toBeGreaterThan(1000);
    const s = (await sudo.query(`SELECT count(*)::int n FROM memory_metadata WHERE tenant=$1`, [T])).rows[0].n;
    expect(s).toBe(50);
  });
});
