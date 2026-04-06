/**
 * LanceDB vector index for unified memory chunks.
 *
 * Stores all memory types in a single `memory_chunks` table alongside
 * the existing `session_chunks` table, enabling cross-type semantic
 * search in one query with optional source type filtering.
 */
import type { Embedder } from './embedder.js';
import type { SourceType, MemoryChunk, MemorySearchResult } from '../types/memory.js';
export interface MemoryChunkRecord {
    id: string;
    item_id: string;
    source_type: string;
    title: string;
    vector: number[];
    text: string;
    chunk_type: string;
    project_path: string;
    file_path: string;
    mtime: number;
}
export declare class MemoryIndex {
    static readonly TABLE_NAME = "memory_chunks";
    static readonly DEFAULT_INDEX_PATH: string;
    private embedder;
    private indexPath;
    private db;
    private table;
    private mtimeCache;
    private mtimeCachePath;
    constructor(embedder: Embedder, indexPath?: string);
    connect(): Promise<void>;
    private loadMtimeCache;
    private saveMtimeCache;
    /** Cache key combines source type and item ID for uniqueness */
    private cacheKey;
    needsUpdate(sourceType: string, itemId: string, mtime: number): boolean;
    addChunks(chunks: MemoryChunk[]): Promise<number>;
    deleteItem(sourceType: string, itemId: string): Promise<void>;
    deleteSourceType(sourceType: string): Promise<void>;
    search(query: string, options?: {
        topK?: number;
        sourceTypes?: SourceType[];
        projectFilter?: string;
    }): Promise<MemorySearchResult[]>;
    getStats(): Promise<{
        totalChunks: number;
        totalItems: number;
        bySourceType: Record<string, {
            items: number;
            chunks: number;
        }>;
        indexPath: string;
    }>;
    clear(): Promise<void>;
}
