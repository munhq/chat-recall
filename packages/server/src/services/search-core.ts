/**
 * Shared search plumbing for `SearchService` (sessions) and `MemoryService`
 * (all source types).
 *
 * Both services independently grew the same four pieces — a per-tenant vector
 * store map, a per-tenant `vectorOk` cache, `vectorActive()` and
 * `expandIfKeyword()` — and `MemoryService` even documented the copy ("same
 * keyword-expansion the sessions-only SearchService uses"). They had drifted in
 * a way that mattered: `SearchService.searchUnified` threaded `semantic` into
 * the index call while `MemoryService.search` did not, so `/api/memory/search`
 * was permanently FTS-only even with an embedder configured, while
 * `/api/search?includeMemory=true&semantic=true` got the vector tier over the
 * same source types. Folding the plumbing here is what lets both paths share one
 * `semantic` decision instead of two.
 *
 * Per-tenant maps are essential, not incidental: these services are
 * process-wide singletons and `createVectorStore` reads `currentTenant()`, so a
 * single shared instance would leak the startup tenant ('default') to every team.
 */

import { createVectorStore, getEmbedder, currentTenant } from '../imports.js';
import type { Embedder, EmbedderProvider, VectorStore } from '../imports.js';
import { QueryExpander } from './query-expander.js';
import { TenantTtlCache } from '../util/tenant-cache.js';

export abstract class SearchCore {
  /** Query embeddings and stored vectors MUST come from the same model or
   *  similarity is garbage — hence one env-driven factory for every caller. */
  protected embedder: Embedder;

  /** One vector store per tenant, built lazily inside the request's ambient
   *  tenant context. */
  private indexes = new Map<string, Promise<VectorStore>>();

  /** LLM query expansion ("semantic without embeddings"). Shared across tenants —
   *  holds no tenant state, only a query→terms cache keyed by query text. */
  private expander = new QueryExpander();

  /** Per-tenant "is the vector path actually serving semantic results?". */
  private vectorOkCache = new Map<string, { ok: boolean; t: number }>();

  /**
   * `getStats()` results, cached 30s per tenant AND viewer.
   *
   * The store's `getStats()` is three whole-corpus aggregates over
   * `memory_chunks` — `COUNT(*)`, `COUNT(DISTINCT …)` and a `GROUP BY` — so its
   * cost scales with everything the tenant has ever indexed and cannot be
   * paginated: a total has no pages. Measured on a 246k-chunk / 1.1GB tenant:
   * 346ms + 704ms + 129ms.
   *
   * Nothing on the read path can change those numbers — only a sync/index can —
   * yet three callers reached for them per request and `/api/status` sat on the
   * dashboard's boot path (`App.tsx`: `Promise.all([getProjectTree(),
   * getStatus()])`). Every one of 877 consecutive `/api/status` responses
   * measured between 1.0s and 3.0s; not one came in under a second, which is
   * what a missing cache looks like as opposed to a cold one.
   *
   * These counts are RLS-filtered per VIEWER — `memory_chunks` carries an
   * author-visibility policy — so entries are keyed by tenant AND viewer. A
   * tenant-only key serves one member's filtered totals to another member.
   */
  private statsCache = new TenantTtlCache<Awaited<ReturnType<VectorStore['getStats']>>>(30_000);

  constructor() {
    this.embedder = getEmbedder((process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider);
  }

  protected index(): Promise<VectorStore> {
    const t = currentTenant() ?? 'default';
    let p = this.indexes.get(t);
    if (!p) { p = createVectorStore(this.embedder); this.indexes.set(t, p); }
    return p;
  }

  /**
   * `getStats()` behind a 30s per-tenant/viewer cache — see `statsCache`.
   *
   * Every caller that wants index totals comes through here. Three call sites
   * each paid the full corpus scan on every request: `/api/status`,
   * `/api/memory/status`, and `vectorActive()` for a single boolean.
   */
  protected async cachedStats(): Promise<Awaited<ReturnType<VectorStore['getStats']>>> {
    const hit = this.statsCache.get();
    if (hit) return hit;
    const stats = await (await this.index()).getStats();
    this.statsCache.set(stats);
    return stats;
  }

  /** True when the tenant's vector store is serving real semantic results
   *  (pgvector active + embedder). Cached 60s; false on error. */
  protected async vectorActive(): Promise<boolean> {
    const t = currentTenant() ?? 'default';
    const cached = this.vectorOkCache.get(t);
    const now = Date.now();
    if (cached && now - cached.t < 60_000) return cached.ok;
    let ok = false;
    // One boolean, read from the shared 30s stats cache.
    try { ok = (await this.cachedStats()).vectorOk === true; } catch { ok = false; }
    this.vectorOkCache.set(t, { ok, t: now });
    return ok;
  }

  /**
   * Expand the query with related keywords iff expansion is enabled AND the
   * store is in keyword (FTS) mode — when real embeddings are active, expansion
   * steps aside (embedding a keyword-soup query is worse than the natural one).
   * Always returns a usable query string; a failing expander must never fail the
   * search (this tolerance came from MemoryService's copy and is the behaviour
   * worth keeping).
   */
  protected async expandIfKeyword(query: string): Promise<string> {
    if (!this.expander.isEnabled) return query;
    if (await this.vectorActive()) return query;
    try { return (await this.expander.expand(query)).expanded; } catch { return query; }
  }

  /**
   * Resolve the caller's `wantSemantic` against live capability. Run the vector
   * tier only when the caller asked AND embeddings are actually live; then the
   * store embeds once (cached) and RRF-fuses with FTS. Otherwise pure FTS.
   */
  protected async useSemantic(wantSemantic: boolean): Promise<boolean> {
    return wantSemantic ? await this.vectorActive() : false;
  }
}
