/**
 * Memory service - backend for unified memory API.
 */

import {
  createStore, SourceRegistry,
  SessionSource, PlanSource, TaskSource, ClaudeMdSource, AgentMemorySource, HistorySource, PasteSource,
  GeminiSessionSource, GeminiBrainSource, OpenCodeSource, OpenCodeTodoSource, DiarySource,
  SkillsSource, McpsSource, SlashCommandsSource, SubagentsSource, HooksSource, PluginsSource,
  CodexSessionSource, currentTenant,
} from '../imports.js';
import type { SourceType, MemorySearchResult, MemoryMetadataRow, MemoryLinkRow, StorageDriver } from '../imports.js';
import { isServerMode } from '../util/mode.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { SearchCore } from './search-core.js';

const log = createLogger('memory');

export class MemoryService extends SearchCore {
  private registry: SourceRegistry;
  // Per-tenant store, built lazily in the request's ambient-tenant context
  // (createStore reads currentTenant()). The per-tenant vector index, embedder,
  // query expansion and vectorOk cache all live in SearchCore, shared with
  // SearchService — see search-core.ts.
  private stores = new Map<string, Promise<StorageDriver>>();

  private st(): Promise<StorageDriver> {
    const t = currentTenant() ?? 'default';
    let p = this.stores.get(t);
    if (!p) { p = createStore(); this.stores.set(t, p); }
    return p;
  }

  constructor() {
    super();

    // Initialize source registry. In server mode there is no local
    // filesystem to discover from (data arrives via /api/sync) and several
    // source constructors mkdir their watch dirs — which EACCESes in a
    // read-only/non-root container. Keep the registry empty there; reindex
    // becomes a no-op with a clear count of zero.
    this.registry = new SourceRegistry();
    if (isServerMode()) return;
    this.registry.register(new SessionSource());
    this.registry.register(new PlanSource());
    this.registry.register(new TaskSource());
    this.registry.register(new ClaudeMdSource());
    this.registry.register(new AgentMemorySource());
    this.registry.register(new HistorySource());
    this.registry.register(new PasteSource());
    this.registry.register(new GeminiSessionSource());
    this.registry.register(new GeminiBrainSource());
    this.registry.register(new OpenCodeSource());
    this.registry.register(new OpenCodeTodoSource());
    this.registry.register(new CodexSessionSource());
    this.registry.register(new DiarySource());
    this.registry.register(new SkillsSource());
    this.registry.register(new McpsSource());
    this.registry.register(new SlashCommandsSource());
    this.registry.register(new SubagentsSource());
    this.registry.register(new HooksSource());
    this.registry.register(new PluginsSource());
  }


  /**
   * Unified search across every source type.
   *
   * `wantSemantic` used to be absent here, which silently made this path — and
   * therefore `/api/memory/search`, the MemoryExplorer UI, `chat-recall memory
   * search` and the `recall_memory_search` MCP tool — FTS-only even with an
   * embedder configured, while `/api/search?includeMemory=true&semantic=true`
   * ran the vector tier over the same data. Threaded through `useSemantic` so
   * both services now make one shared decision.
   */
  async search(
    query: string,
    topK = 10,
    sourceTypes?: SourceType[],
    projectIdFilter?: string,
    wantSemantic = false
  ): Promise<MemorySearchResult[]> {
    const semantic = await this.useSemantic(wantSemantic);
    return await (await this.index()).search(await this.expandIfKeyword(query), {
      topK, sourceTypes, projectIdFilter, semantic,
    });
  }

  async getStatus() {

    let indexStats;
    try {
      indexStats = await (await this.index()).getStats();
    } catch {
      // LanceDB may be corrupted — fall back to SQLite-only stats
      indexStats = { totalChunks: 0, totalItems: 0, bySourceType: {}, indexPath: '' };
    }
    const storeStats = await (await this.st()).getStats();
    const linkCount = await (await this.st()).getLinkCount();

    // Per-(sourceType, tool) breakdown so the UI can hide tabs that have no
    // rows for the selected tool — the "tool-first" navigation rule.
    const bySourceAndTool = await this.computeBySourceAndTool();

    return {
      ...indexStats,
      storeStats,
      linkCount,
      bySourceAndTool,
    };
  }

  /**
   * Counts grouped by (source_type, tool). Falls back to 'claude' for rows
   * with no extra.tool field — that's the historical default.
   */
  private async computeBySourceAndTool(): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    const allTypes: SourceType[] = [
      'session', 'plan', 'task', 'claude_md', 'paste', 'history', 'diary',
      'skill', 'mcp', 'command', 'agent', 'hook', 'plugin',
    ];
    for (const t of allTypes) {
      const items = await (await this.st()).listItems(t, 50000, 0);
      const m: Record<string, number> = {};
      for (const it of items) {
        let tool = 'claude';
        try { tool = JSON.parse(it.extra_json || '{}').tool || 'claude'; } catch {}
        m[tool] = (m[tool] || 0) + 1;
      }
      if (items.length > 0) out[t] = m;
    }
    return out;
  }

  async getItem(id: string, sourceType: SourceType): Promise<MemoryMetadataRow | null> {

    return (await this.st()).getItem(id, sourceType);
  }

  async listItems(sourceType: SourceType, limit = 100, offset = 0): Promise<MemoryMetadataRow[]> {

    return (await this.st()).listItems(sourceType, limit, offset);
  }

  async getLinks(sourceType: SourceType, itemId: string): Promise<MemoryLinkRow[]> {

    return (await this.st()).getAllLinks(sourceType, itemId);
  }

  async getLinksFrom(sourceType: SourceType, itemId: string): Promise<MemoryLinkRow[]> {

    return (await this.st()).getLinksFrom(sourceType, itemId);
  }

  async getLinksTo(sourceType: SourceType, itemId: string): Promise<MemoryLinkRow[]> {

    return (await this.st()).getLinksTo(sourceType, itemId);
  }

  async updateItemProjectPath(id: string, sourceType: SourceType, projectPath: string): Promise<boolean> {

    return (await this.st()).updateItemProjectPath(id, sourceType, projectPath);
  }

  async reindex(sourceTypes: SourceType[], force = false): Promise<{
    itemsProcessed: number;
    chunksAdded: number;
    linksAdded: number;
    errors: number;
  }> {

    let totalItems = 0;
    let totalChunks = 0;
    let totalLinks = 0;
    let totalErrors = 0;

    for (const sourceType of sourceTypes) {
      const sources = this.registry.getAll(sourceType);
      if (sources.length === 0) {
        log.error({ sourceType }, 'no source registered for type');
        continue;
      }

      log.info({ sourceType }, 'reindexing');

      try {
        for (const source of sources) {
        for await (const item of source.discover()) {
          try {
            // Check if update needed (unless force)
            if (!force && !(await (await this.index()).needsUpdate(item.sourceType, item.id, item.mtime))) {
              continue;
            }

            // Delete old data
            await (await this.index()).deleteItem(item.sourceType, item.id);

            // Parse and buffer chunks (flushed in batches to reduce LanceDB versions)
            const chunks = await source.parse(item);
            if (chunks.length > 0) {
              await (await this.index()).bufferChunks(chunks);
              totalChunks += chunks.length;
            }

            // Update metadata
            await (await this.st()).setItem(item);

            // Extract and add links
            const links = await source.extractLinks(item);
            if (links.length > 0) {
              await (await this.st()).addLinks(links);
              totalLinks += links.length;
            }

            totalItems++;
          } catch (err) {
            totalErrors++;
            log.error({ err, itemId: item.id }, 'error indexing item');
          }
        }
        }
      } catch (err) {
        totalErrors++;
        log.error({ err, sourceType }, 'discovery error');
      }
    }

    // Flush remaining buffered chunks and optimize
    await (await this.index()).flushBuffer();
    // optimize() removed from auto flows to prevent data corruption

    return {
      itemsProcessed: totalItems,
      chunksAdded: totalChunks,
      linksAdded: totalLinks,
      errors: totalErrors,
    };
  }
}
