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

  constructor() {
    this.embedder = getEmbedder((process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider);
  }

  protected index(): Promise<VectorStore> {
    const t = currentTenant() ?? 'default';
    let p = this.indexes.get(t);
    if (!p) { p = createVectorStore(this.embedder); this.indexes.set(t, p); }
    return p;
  }

  /** True when the tenant's vector store is serving real semantic results
   *  (pgvector active + embedder). Cached 60s; false on error. */
  protected async vectorActive(): Promise<boolean> {
    const t = currentTenant() ?? 'default';
    const cached = this.vectorOkCache.get(t);
    const now = Date.now();
    if (cached && now - cached.t < 60_000) return cached.ok;
    let ok = false;
    try { ok = (await (await this.index()).getStats()).vectorOk === true; } catch { ok = false; }
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
