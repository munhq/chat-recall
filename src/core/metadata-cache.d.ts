/**
 * SQLite cache for session metadata (summaries, titles).
 * Stores AI-generated summaries for sessions that don't have them.
 */
export interface SessionMetadata {
    sessionId: string;
    firstPrompt: string;
    summary: string;
    summarySource: 'original' | 'gemini' | 'claude' | 'ollama';
    mtime: number;
    indexedAt: number;
}
export declare class MetadataCache {
    private db;
    private static readonly DEFAULT_DB_PATH;
    constructor(dbPath?: string);
    private initSchema;
    set(metadata: SessionMetadata): void;
    get(sessionId: string): SessionMetadata | null;
    needsUpdate(sessionId: string, currentMtime: number): boolean;
    getStats(): {
        totalSessions: number;
        bySources: Record<string, number>;
    };
    close(): void;
}
