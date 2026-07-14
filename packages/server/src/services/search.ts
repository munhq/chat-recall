/**
 * Search service — uses unified MemoryIndex for all searches.
 */

// getAllSessions deliberately NOT imported here: the only FS walk this service
// needs runs via getSessionProjectCounts (sessions.ts), which is server-mode-guarded.
import { createVectorStore, getEmbedder, createMetadataCache, currentTenant } from '../imports.js';
import type { Embedder, EmbedderProvider, SourceType, MemorySearchResult, VectorStore } from '../imports.js';
import { QueryExpander } from './query-expander.js';
import { TenantTtlCache } from '../util/tenant-cache.js';

// See sessions.ts for why we strip client-injected banners here.
const INJECTED_BANNERS: RegExp[] = [
  /MCP issues detected\. ?Run \/mcp list for status\.?/g,
  /Context low[^\n]*Run \/compact[^\n]*/g,
  /API Error:[^\n]{0,120}/g,
];
function cleanBanner(text: string | undefined): string | undefined {
  if (!text) return text;
  let out = text;
  for (const re of INJECTED_BANNERS) out = out.replace(re, ' ');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/** Session search result shape (consumed by the frontend) */
export interface SearchResult {
  sessionId: string;
  score: number;
  chunkType: string;
  text: string;
  projectPath: string;
  created: string;
  modified: string;
  firstPrompt: string;
  summary?: string;
  matchedChunks: Array<{
    chunkType: string;
    text: string;
    score: number;
  }>;
}

export class SearchService {
  private embedder: Embedder;
  // One vector store per tenant (built lazily in the request's ambient-tenant
  // context). createVectorStore reads currentTenant(), so a single shared
  // instance would leak the startup tenant ('default') to every team.
  private indexes = new Map<string, Promise<VectorStore>>();

  // Cache project counts for 30 seconds to avoid scanning filesystem on every
  // SSE tick. Tenant-scoped for the same reason `indexes` above is per-tenant:
  // this service is a process-wide singleton, and an unscoped cache here
  // served one tenant's project names + session counts to every other tenant
  // via /api/status.
  private projectCountsCache = new TenantTtlCache<{ projects: Record<string, number>; totalSessions: number }>(30_000);

  // LLM query expansion ("semantic without embeddings"). Shared across tenants —
  // it holds no tenant state, only a query→terms cache keyed by the query text.
  private expander = new QueryExpander();
  // Per-tenant cache of "is the vector path actually serving semantic results?"
  // Expansion is the keyword-mode booster; when real embeddings are active it
  // steps aside (embedding a keyword-soup query is worse than the natural one).
  private vectorOkCache = new Map<string, { ok: boolean; t: number }>();

  constructor() {
    // Same env-driven factory the backfill worker uses — query embeddings and
    // stored vectors MUST come from the same model or similarity is garbage.
    // Default 'ollama' preserves the local/self-host behavior when unset.
    this.embedder = getEmbedder((process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider);
  }

  private index(): Promise<VectorStore> {
    const t = currentTenant() ?? 'default';
    let p = this.indexes.get(t);
    if (!p) { p = createVectorStore(this.embedder); this.indexes.set(t, p); }
    return p;
  }

  /** True when the tenant's vector store is serving real semantic results
   *  (pgvector active + embedder). Cached 60s; falls back to false on error. */
  private async vectorActive(): Promise<boolean> {
    const t = currentTenant() ?? 'default';
    const cached = this.vectorOkCache.get(t);
    const now = Date.now();
    if (cached && now - cached.t < 60_000) return cached.ok;
    let ok = false;
    try { ok = (await (await this.index()).getStats()).vectorOk === true; } catch { ok = false; }
    this.vectorOkCache.set(t, { ok, t: now });
    return ok;
  }

  /** Expand the query with related keywords iff expansion is enabled AND the
   *  store is in keyword (FTS) mode. Always returns a usable query string. */
  private async expandIfKeyword(query: string): Promise<string> {
    if (!this.expander.isEnabled) return query;
    if (await this.vectorActive()) return query;
    return (await this.expander.expand(query)).expanded;
  }

  /**
   * Search sessions only — returns results in the legacy SearchResult format
   * for backward compatibility with the frontend.
   */
  async search(
    query: string,
    topK = 10,
    projectIdFilter?: string,
    // Only an explicit search (Enter / Search button) asks for the semantic
    // tier; the debounced type-ahead leaves this false → FTS only, no embed.
    wantSemantic = false
  ): Promise<SearchResult[]> {
    const idx = await this.index();
    // Run the vector tier only when the caller asked AND embeddings are live;
    // then it embeds once (cached) and RRF-fuses with FTS. Otherwise pure FTS.
    const semantic = wantSemantic && (await this.vectorActive());
    const results = await idx.search(await this.expandIfKeyword(query), {
      topK,
      sourceTypes: ['session'],
      projectIdFilter,
      semantic,
    });

    // Enrich with metadata from cache (summaries, dates). Pre-fetch all cached
    // rows in parallel — the driver is async, so we can't call get() inside map().
    const cache = await createMetadataCache();
    const cachedList = await Promise.all(results.map((r: MemorySearchResult) => cache.get(r.itemId)));
    const searchResults: SearchResult[] = results.map((r: MemorySearchResult, i: number) => {
      const cached = cachedList[i];
      // Use the indexed item's mtime as both created/modified — we don't track
      // created separately, and an empty string here breaks client-side date
      // grouping ("Invalid Date") and Recent-sort (NaN comparisons).
      const iso = r.mtime ? new Date(r.mtime).toISOString() : '';
      return {
        sessionId: r.itemId,
        score: r.score,
        chunkType: r.matchedChunks[0]?.chunkType || 'unknown',
        text: r.matchedChunks[0]?.text || r.title,
        projectPath: r.projectPath,
        created: iso,
        modified: iso,
        firstPrompt: cleanBanner(cached?.firstPrompt || r.title) ?? '',
        summary: cleanBanner(cached?.summary),
        matchedChunks: r.matchedChunks,
      };
    });
    await cache.close();
    return searchResults;
  }

  async searchUnified(
    query: string,
    topK = 10,
    sourceTypes?: SourceType[],
    projectIdFilter?: string,
    wantSemantic = false
  ): Promise<MemorySearchResult[]> {
    const idx = await this.index();
    const semantic = wantSemantic && (await this.vectorActive());
    return await idx.search(await this.expandIfKeyword(query), { topK, sourceTypes, projectIdFilter, semantic });
  }

  async getStatus() {
    const idx = await this.index();
    let stats: Awaited<ReturnType<VectorStore['getStats']>>;
    try {
      stats = await idx.getStats();
    } catch (err) {
      stats = {
        totalChunks: 0,
        totalItems: 0,
        bySourceType: {},
        indexPath: '',
        vectorOk: false,
        vectorError: err instanceof Error ? err.message : String(err),
      };
    }

    // Build project counts from all sources (Claude + Codex + Gemini + OpenCode).
    // Uses the lean `getSessionProjectCounts` which skips firstPrompt/summary
    // extraction — `getStatus` only needs aggregate counts, and pulling
    // firstPrompts for 500+ sessions was the cause of the multi-second
    // cold status responses.
    let counts = this.projectCountsCache.get();
    if (!counts) {
      const { getSessionProjectCounts } = await import('./sessions.js');
      const { normalizeProjectPath } = await import('../util/paths.js');
      const { projects: rawCounts, total } = await getSessionProjectCounts();
      const projectCounts: Record<string, number> = {};
      for (const [path, count] of Object.entries(rawCounts)) {
        const norm = normalizeProjectPath(path);
        if (norm) projectCounts[norm] = (projectCounts[norm] || 0) + count;
      }
      counts = { projects: projectCounts, totalSessions: total };
      this.projectCountsCache.set(counts);
    }
    const { projects: projectCounts, totalSessions } = counts;

    return {
      totalChunks: stats.totalChunks,
      totalSessions,
      projects: projectCounts,
      indexPath: stats.indexPath,
      vectorOk: stats.vectorOk,
      vectorError: stats.vectorError,
    };
  }
}
