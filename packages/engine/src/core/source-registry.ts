/**
 * Registry of MemorySource plugins.
 *
 * Manages source discovery, parsing, and link extraction across
 * all registered data sources. Supports multiple sources per type
 * (e.g., Claude sessions + Gemini sessions + OpenCode sessions).
 */

import type {
  SourceType,
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
} from '../types/memory.js';
import { isItemAllowed } from './source-policy.js';

export class SourceRegistry {
  private sources = new Map<SourceType, MemorySource[]>();

  /** Register a memory source plugin. Multiple sources per type are supported. */
  register(source: MemorySource): void {
    const existing = this.sources.get(source.sourceType) || [];
    existing.push(source);
    this.sources.set(source.sourceType, existing);
  }

  /** Get the first registered source by type (for parse/extractLinks) */
  get(sourceType: SourceType): MemorySource | undefined {
    const sources = this.sources.get(sourceType);
    return sources?.[0];
  }

  /** Get all sources for a type (multiple tools may provide the same type) */
  getAll(sourceType: SourceType): MemorySource[] {
    return this.sources.get(sourceType) || [];
  }

  /** Get all registered source types */
  getRegisteredTypes(): SourceType[] {
    return Array.from(this.sources.keys());
  }

  /**
   * Discover all items from all registered sources, filtered by the
   * settings-driven policy in `source-policy.ts`. Disabled sources and
   * denylisted projects are dropped here so plugins stay unaware of the
   * gating logic.
   */
  async *discoverAll(sourceTypes?: SourceType[]): AsyncGenerator<MemoryItem> {
    const types = sourceTypes || this.getRegisteredTypes();

    for (const type of types) {
      const sources = this.sources.get(type) || [];
      for (const source of sources) {
        for await (const item of source.discover()) {
          if (isItemAllowed(item)) yield item;
        }
      }
    }
  }

  /** Parse a single item into chunks. Tries each source for the type until one works. */
  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    const sources = this.sources.get(item.sourceType) || [];
    for (const source of sources) {
      try {
        const chunks = await source.parse(item);
        if (chunks.length > 0) return chunks;
      } catch {}
    }
    return [];
  }

  /** Extract links from a single item */
  async extractLinks(item: MemoryItem): Promise<MemoryLink[]> {
    const sources = this.sources.get(item.sourceType) || [];
    for (const source of sources) {
      try {
        return await source.extractLinks(item);
      } catch {}
    }
    return [];
  }

  /**
   * Discover, parse, and extract links for all items from a source type.
   * Same policy filter as `discoverAll` is applied before the parse step
   * so disallowed items never get embedded.
   */
  async *processSource(sourceType: SourceType): AsyncGenerator<{
    item: MemoryItem;
    chunks: MemoryChunk[];
    links: MemoryLink[];
  }> {
    const sources = this.sources.get(sourceType) || [];

    for (const source of sources) {
      for await (const item of source.discover()) {
        if (!isItemAllowed(item)) continue;
        const chunks = await source.parse(item);
        const links = await source.extractLinks(item);
        yield { item, chunks, links };
      }
    }
  }
}
