/**
 * The batched compute writer must behave exactly like the per-row one.
 *
 * It replaces four writes per session plus a stale read for `markers`. Three
 * things had to survive the change and each is asserted here: the markers
 * shrink guard (a smaller marker set must never overwrite a larger one), the
 * count the ingest reports back as `derived`, and not rewriting rows that
 * already match.
 *
 * Acceptance criteria 2 and 7 of docs/SYNC-BATCH-WRITES.md.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createMetadataCache } from './caches.js';
import { pgAdminUrl } from '../../test-support/pg-urls.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const T = 'compute_batch_team';

const markers = (n: number) => ({ prompts: Array.from({ length: n }, (_, i) => ({ line: i, text: `p${i}` })) });

(PG_URL ? describe : describe.skip)('setComputeMany', () => {
  let cache: any; let sudo: any;

  /** (session,kind) → physical row location, so a rewrite is visible. */
  async function placed(): Promise<Map<string, string>> {
    const r = await sudo.query(
      `SELECT session_id, kind, ctid::text AS loc FROM compute_cache WHERE tenant=$1`, [T]);
    return new Map(r.rows.map((x: any) => [`${x.session_id}/${x.kind}`, x.loc]));
  }

  beforeAll(async () => {
    sudo = new pg.Pool({ connectionString: pgAdminUrl() });
    const { createStore } = await import('./index.js');
    const s = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: T } as any);
    await s.close();
    await sudo.query(`DELETE FROM compute_cache WHERE tenant=$1`, [T]);
    cache = await createMetadataCache({ backend: 'postgres', databaseUrl: PG_URL, tenant: T } as any);
  }, 40000);

  afterAll(async () => {
    try { await sudo.query(`DELETE FROM compute_cache WHERE tenant=$1`, [T]); } catch { /* best effort */ }
    await cache?.close(); await sudo?.end();
  });

  test('all four kinds for two sessions land in one call', async () => {
    const rows = ['s1', 's2'].flatMap((sessionId) =>
      ['diff', 'outcome', 'commits', 'markers'].map((kind) => ({
        sessionId, kind, mtime: 1000, data: kind === 'markers' ? markers(5) : { kind, of: sessionId },
      })));
    expect(await cache.setComputeMany(rows)).toBe(8);
    const n = (await sudo.query(`SELECT count(*)::int n FROM compute_cache WHERE tenant=$1`, [T])).rows[0].n;
    expect(n).toBe(8);
  }, 30000);

  test('CRITERION 2: writing the same rows again rewrites nothing', async () => {
    const rows = ['s1', 's2'].flatMap((sessionId) =>
      ['diff', 'outcome', 'commits', 'markers'].map((kind) => ({
        sessionId, kind, mtime: 1000, data: kind === 'markers' ? markers(5) : { kind, of: sessionId },
      })));
    const before = await placed();
    await cache.setComputeMany(rows);
    const after = await placed();
    for (const [key, loc] of after) expect(after.get(key), `${key} moved`).toBe(before.get(key) ?? loc);
    expect([...after.keys()].every((k) => before.get(k) === after.get(k))).toBe(true);
  }, 30000);

  test('THE GUARD: a smaller marker set never overwrites a larger one', async () => {
    // markersPromptCount drives computeShrinkRefused — a truncated re-parse
    // must not replace the full set. The per-row writer read the stored value
    // to decide; the batch reads them all in one query and must decide the same.
    const offered = await cache.setComputeMany([
      { sessionId: 's1', kind: 'markers', mtime: 2000, data: markers(2) },
    ]);
    expect(offered).toBe(0);
    const got = await cache.getComputeStale('s1', 'markers');
    expect((got!.data as any).prompts).toHaveLength(5);
  }, 30000);

  test('a larger marker set does replace a smaller one', async () => {
    const offered = await cache.setComputeMany([
      { sessionId: 's1', kind: 'markers', mtime: 3000, data: markers(9) },
    ]);
    expect(offered).toBe(1);
    const got = await cache.getComputeStale('s1', 'markers');
    expect((got!.data as any).prompts).toHaveLength(9);
  }, 30000);

  test('the guard applies per session, not across them', async () => {
    // s2 still holds 5. A shrink for s1 must not suppress a legitimate write
    // for s2, which is the bug a single shared "stale" lookup would introduce.
    const offered = await cache.setComputeMany([
      { sessionId: 's1', kind: 'markers', mtime: 4000, data: markers(3) },   // refused
      { sessionId: 's2', kind: 'markers', mtime: 4000, data: markers(8) },   // accepted
    ]);
    expect(offered).toBe(1);
    expect(((await cache.getComputeStale('s2', 'markers'))!.data as any).prompts).toHaveLength(8);
    expect(((await cache.getComputeStale('s1', 'markers'))!.data as any).prompts).toHaveLength(9);
  }, 30000);

  test('the same key twice in one call keeps the last, not both', async () => {
    const offered = await cache.setComputeMany([
      { sessionId: 's3', kind: 'diff', mtime: 1, data: { v: 'first' } },
      { sessionId: 's3', kind: 'diff', mtime: 2, data: { v: 'second' } },
    ]);
    expect(offered).toBe(2);                       // both were offered
    const n = (await sudo.query(`SELECT count(*)::int n FROM compute_cache WHERE tenant=$1 AND session_id='s3'`, [T])).rows[0].n;
    expect(n).toBe(1);                             // one row survives
    expect(((await cache.getComputeStale('s3', 'diff'))!.data as any).v).toBe('second');
  }, 30000);

  test('an empty call touches nothing', async () => {
    expect(await cache.setComputeMany([])).toBe(0);
  });
});
