/**
 * Search service — uses unified MemoryIndex for all searches.
 */

import { MemoryIndex, OllamaEmbedder, MetadataCache, getAllSessions } from '../imports.js';
import type { SourceType, MemorySearchResult } from '../imports.js';

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
  private memoryIndex: MemoryIndex;
  private embedder: OllamaEmbedder;

  // Cache project counts for 30 seconds to avoid scanning filesystem on every SSE tick
  private projectCountsCache: { projects: Record<string, number>; totalSessions: number } | null = null;
  private projectCountsCacheTime = 0;
  private static readonly CACHE_TTL_MS = 30_000;

  constructor() {
    this.embedder = new OllamaEmbedder();
    this.memoryIndex = new MemoryIndex(this.embedder);
  }

  /**
   * Search sessions only — returns results in the legacy SearchResult format
   * for backward compatibility with the frontend.
   */
  async search(
    query: string,
    topK = 10,
    projectFilter?: string
  ): Promise<SearchResult[]> {
    const results = await this.memoryIndex.search(query, {
      topK,
      sourceTypes: ['session'],
      projectFilter,
    });

    // Enrich with metadata from cache (summaries, dates)
    const cache = new MetadataCache();
    const searchResults: SearchResult[] = results.map((r: MemorySearchResult) => {
      const cached = cache.get(r.itemId);
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
    cache.close();
    return searchResults;
  }

  async searchUnified(
    query: string,
    topK = 10,
    sourceTypes?: SourceType[],
    projectFilter?: string
  ): Promise<MemorySearchResult[]> {
    return await this.memoryIndex.search(query, { topK, sourceTypes, projectFilter });
  }

  async getStatus() {
    let stats;
    try {
      stats = await this.memoryIndex.getStats();
    } catch {
      stats = { totalChunks: 0, totalItems: 0, bySourceType: {}, indexPath: '' };
    }

    // Build project counts from all sources (Claude + Codex + Gemini + OpenCode).
    // Uses the lean `getSessionProjectCounts` which skips firstPrompt/summary
    // extraction — `getStatus` only needs aggregate counts, and pulling
    // firstPrompts for 500+ sessions was the cause of the multi-second
    // cold status responses.
    const now = Date.now();
    if (!this.projectCountsCache || (now - this.projectCountsCacheTime) > SearchService.CACHE_TTL_MS) {
      const { getSessionProjectCounts } = await import('./sessions.js');
      const { normalizeProjectPath } = await import('../utils/paths.js');
      const { projects: rawCounts, total } = await getSessionProjectCounts();
      const projectCounts: Record<string, number> = {};
      for (const [path, count] of Object.entries(rawCounts)) {
        const norm = normalizeProjectPath(path);
        if (norm) projectCounts[norm] = (projectCounts[norm] || 0) + count;
      }
      this.projectCountsCache = { projects: projectCounts, totalSessions: total };
      this.projectCountsCacheTime = now;
    }
    const { projects: projectCounts, totalSessions } = this.projectCountsCache;

    return {
      totalChunks: stats.totalChunks,
      totalSessions,
      projects: projectCounts,
      indexPath: stats.indexPath,
    };
  }
}
