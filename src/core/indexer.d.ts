/**
 * LanceDB indexer for session chunks.
 */
import type { Embedder } from './embedder.js';
import type { SessionChunk } from '../parsers/chunker.js';
export interface ChunkRecord {
    id: string;
    session_id: string;
    vector: number[];
    text: string;
    project_path: string;
    created: string;
    modified: string;
    mtime: number;
    first_prompt: string;
    chunk_type: string;
    source_file: string;
    source_line: number;
}
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
export declare class SessionIndex {
    static readonly TABLE_NAME = "session_chunks";
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
    needsUpdate(sessionId: string, mtime: number): boolean;
    addChunks(chunks: SessionChunk[], showProgress?: boolean): Promise<number>;
    deleteSession(sessionId: string): Promise<void>;
    getStats(): Promise<{
        totalChunks: number;
        totalSessions: number;
        projects: Record<string, number>;
        indexPath: string;
    }>;
    clear(): Promise<void>;
    search(query: string, topK?: number, projectFilter?: string, dedupeSessions?: boolean): Promise<SearchResult[]>;
}
export interface IndexStats {
    sessionsProcessed: number;
    sessionsSkipped: number;
    chunksAdded: number;
    errors: number;
}
export declare function indexAllSessions(embedder: Embedder, options?: {
    indexPath?: string;
    claudeDir?: string;
    force?: boolean;
    showProgress?: boolean;
}): Promise<IndexStats>;
export declare function searchSessions(query: string, embedder: Embedder, options?: {
    topK?: number;
    projectFilter?: string;
    indexPath?: string;
}): Promise<SearchResult[]>;
