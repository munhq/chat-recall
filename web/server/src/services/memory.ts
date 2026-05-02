/**
 * Memory service - backend for unified memory API.
 */

import {
  MemoryIndex, MemoryStore, OllamaEmbedder, SourceRegistry,
  SessionSource, PlanSource, TaskSource, ClaudeMdSource, HistorySource, PasteSource,
  GeminiSessionSource, GeminiBrainSource, OpenCodeSource, OpenCodeTodoSource, DiarySource,
  SkillsSource, McpsSource, SlashCommandsSource, SubagentsSource, HooksSource, PluginsSource,
  CodexSessionSource,
} from '../imports.js';
import type { SourceType, MemorySearchResult, MemoryMetadataRow, MemoryLinkRow } from '../imports.js';

export class MemoryService {
  private index: MemoryIndex;
  private store: MemoryStore;
  private embedder: OllamaEmbedder;
  private registry: SourceRegistry;

  constructor() {
    this.embedder = new OllamaEmbedder();
    this.index = new MemoryIndex(this.embedder);
    this.store = new MemoryStore();

    // Initialize source registry
    this.registry = new SourceRegistry();
    this.registry.register(new SessionSource());
    this.registry.register(new PlanSource());
    this.registry.register(new TaskSource());
    this.registry.register(new ClaudeMdSource());
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

  async search(
    query: string,
    topK = 10,
    sourceTypes?: SourceType[],
    projectFilter?: string
  ): Promise<MemorySearchResult[]> {
    return await this.index.search(query, { topK, sourceTypes, projectFilter });
  }

  async getStatus() {
    let indexStats;
    try {
      indexStats = await this.index.getStats();
    } catch {
      // LanceDB may be corrupted — fall back to SQLite-only stats
      indexStats = { totalChunks: 0, totalItems: 0, bySourceType: {}, indexPath: '' };
    }
    const storeStats = this.store.getStats();
    const linkCount = this.store.getLinkCount();

    // Per-(sourceType, tool) breakdown so the UI can hide tabs that have no
    // rows for the selected tool — the "tool-first" navigation rule.
    const bySourceAndTool = this.computeBySourceAndTool();

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
  private computeBySourceAndTool(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    const allTypes: SourceType[] = [
      'session', 'plan', 'task', 'claude_md', 'paste', 'history', 'diary',
      'skill', 'mcp', 'command', 'agent', 'hook', 'plugin',
    ];
    for (const t of allTypes) {
      const items = this.store.listItems(t, 50000, 0);
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

  getItem(id: string, sourceType: SourceType): MemoryMetadataRow | null {
    return this.store.getItem(id, sourceType);
  }

  listItems(sourceType: SourceType, limit = 100, offset = 0): MemoryMetadataRow[] {
    return this.store.listItems(sourceType, limit, offset);
  }

  getLinks(sourceType: SourceType, itemId: string): MemoryLinkRow[] {
    return this.store.getAllLinks(sourceType, itemId);
  }

  getLinksFrom(sourceType: SourceType, itemId: string): MemoryLinkRow[] {
    return this.store.getLinksFrom(sourceType, itemId);
  }

  getLinksTo(sourceType: SourceType, itemId: string): MemoryLinkRow[] {
    return this.store.getLinksTo(sourceType, itemId);
  }

  updateItemProjectPath(id: string, sourceType: SourceType, projectPath: string): boolean {
    return this.store.updateItemProjectPath(id, sourceType, projectPath);
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
        console.error(`No source registered for type: ${sourceType}`);
        continue;
      }

      console.log(`Reindexing ${sourceType}...`);

      try {
        for (const source of sources) {
        for await (const item of source.discover()) {
          try {
            // Check if update needed (unless force)
            if (!force && !this.index.needsUpdate(item.sourceType, item.id, item.mtime)) {
              continue;
            }

            // Delete old data
            await this.index.deleteItem(item.sourceType, item.id);

            // Parse and buffer chunks (flushed in batches to reduce LanceDB versions)
            const chunks = await source.parse(item);
            if (chunks.length > 0) {
              await this.index.bufferChunks(chunks);
              totalChunks += chunks.length;
            }

            // Update metadata
            this.store.setItem(item);

            // Extract and add links
            const links = await source.extractLinks(item);
            if (links.length > 0) {
              this.store.addLinks(links);
              totalLinks += links.length;
            }

            totalItems++;
          } catch (err) {
            totalErrors++;
            console.error(`Error indexing ${item.id}:`, err);
          }
        }
        }
      } catch (err) {
        totalErrors++;
        console.error(`Discovery error for ${sourceType}:`, err);
      }
    }

    // Flush remaining buffered chunks and optimize
    await this.index.flushBuffer();
    // optimize() removed from auto flows to prevent data corruption

    return {
      itemsProcessed: totalItems,
      chunksAdded: totalChunks,
      linksAdded: totalLinks,
      errors: totalErrors,
    };
  }
}
