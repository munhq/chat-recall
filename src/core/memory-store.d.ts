/**
 * SQLite storage for memory metadata and links.
 *
 * Adds memory_metadata and memory_links tables to the existing
 * chat-recall-cache.db alongside session_metadata.
 */
import type { SourceType, MemoryItem, MemoryLink, MemoryMetadataRow, MemoryLinkRow } from '../types/memory.js';
export declare class MemoryStore {
    private db;
    private static readonly DEFAULT_DB_PATH;
    constructor(dbPath?: string);
    private initSchema;
    /** Upsert a memory item's metadata */
    setItem(item: MemoryItem): void;
    /** Get a memory item by ID and source type */
    getItem(id: string, sourceType: SourceType): MemoryMetadataRow | null;
    /** Check if an item needs re-indexing based on mtime */
    needsUpdate(id: string, sourceType: SourceType, currentMtime: number): boolean;
    /** Add a link between two memory items */
    addLink(link: MemoryLink): void;
    /** Add multiple links in a transaction */
    addLinks(links: MemoryLink[]): void;
    /** Get all links FROM a given item */
    getLinksFrom(sourceType: SourceType, sourceId: string): MemoryLinkRow[];
    /** Get all links TO a given item */
    getLinksTo(targetType: SourceType, targetId: string): MemoryLinkRow[];
    /** Get all links involving a given item (both directions) */
    getAllLinks(sourceType: SourceType, itemId: string): MemoryLinkRow[];
    /** List all items of a given source type */
    listItems(sourceType: SourceType, limit?: number, offset?: number): MemoryMetadataRow[];
    /** Get counts by source type */
    getStats(): Record<SourceType | string, number>;
    /** Get total link count */
    getLinkCount(): number;
    /** Delete all items and links for a source type */
    clearSourceType(sourceType: SourceType): void;
    /** Delete a specific item and its links */
    deleteItem(id: string, sourceType: SourceType): void;
    close(): void;
}
