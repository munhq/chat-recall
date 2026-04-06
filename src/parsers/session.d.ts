/**
 * Session parser for Claude Code JSONL files.
 */
export interface SessionEntry {
    sessionId: string;
    fullPath: string;
    fileMtime: number;
    firstPrompt: string;
    messageCount: number;
    created: string;
    modified: string;
    gitBranch: string;
    projectPath: string;
    isSidechain: boolean;
}
export interface ExtractedContent {
    text: string;
    lineNumber: number;
    contentType: 'user' | 'assistant' | 'tool_result' | 'web_search';
}
export interface SessionContent {
    sessionId: string;
    sessionPath: string;
    summaries: string[];
    userMessages: ExtractedContent[];
    assistantMessages: ExtractedContent[];
    toolResults: ExtractedContent[];
    toolsUsed: Set<string>;
    firstPrompt: string;
}
export declare function parseSessionsIndex(indexPath: string): SessionEntry[];
export declare function iterAllSessionIndices(claudeDir?: string): Generator<[string, SessionEntry[]]>;
export declare function parseSessionFile(sessionPath: string, maxMessages?: number): Promise<SessionContent>;
export declare function getAllSessions(claudeDir?: string): Generator<[SessionEntry, string]>;
