/**
 * THE canonical transcript shape. Every surface — local dashboard, self-host,
 * SaaS, MCP, sync — renders conversations from this and nothing else.
 *
 * Rules (docs/ARCHITECTURE_RESET.md):
 *   R1  only engine/transcript/ parses transcript files for rendering
 *   R2  the indexer materializes this into content_cache at index time
 *   R3  sync forwards it verbatim (trimmed, never re-parsed elsewhere)
 *   R4  extractTurnsAny (session-turns) is analysis-only — outcomes/markers
 */

export interface ToolCall {
  name: string;
  input: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface TranscriptMessage {
  line: number;
  role: 'user' | 'assistant' | 'summary';
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  timestamp?: string;
}

export interface Subagent {
  id: string;                   // basename without .jsonl (or prefixed child id)
  kind: 'explore' | 'compact' | 'aside' | 'other';
  agentType?: string;           // from .meta.json (e.g. "Explore")
  description?: string;         // from .meta.json
  filePath: string;
  messageCount: number;
  toolUseCount: number;
  messages: TranscriptMessage[];
}

export interface Transcript {
  messages: TranscriptMessage[];
  subagents: Subagent[];
}

/** Version stamp for the content_cache envelope `{v, messages, subagents}`.
 *  Bump when TranscriptMessage's shape changes so stale envelopes from older
 *  parsers are re-parsed instead of served. */
export const TRANSCRIPT_VERSION = 6;
