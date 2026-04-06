/**
 * Smart chunking for Claude Code sessions.
 *
 * Strategy:
 * 1. Primary: Use existing Claude summaries (best signal)
 * 2. Secondary: First user prompt (captures intent)
 * 3. Tertiary: User messages combined (for context)
 * 4. Quaternary: Assistant key responses (what was discovered/explained)
 * 5. Quinary: Tool results and web searches (valuable context)
 */
import type { SessionEntry, SessionContent } from './session.js';
export interface SessionChunk {
    chunkId: string;
    sessionId: string;
    chunkType: 'summary' | 'first_prompt' | 'user_context' | 'assistant' | 'tool_result' | 'web_search';
    text: string;
    projectPath: string;
    created: string;
    modified: string;
    mtime: number;
    firstPrompt: string;
    sourceFile: string;
    sourceLine: number;
}
export declare function chunkSession(entry: SessionEntry, content: SessionContent, maxChunks?: number, maxTokensPerChunk?: number): SessionChunk[];
