/**
 * Turn shapes shared across the codebase. The actual turn extraction lives
 * in `generic-engine.ts` (`extractTurnsFromEvents`) — each backend's
 * `extractTurns()` calls into it. Callers that want a raw function form
 * use `extractTurnsAny` in `session-multi-tool.ts`, which routes through
 * the registry.
 */

export type TurnKind = 'user' | 'assistant_text' | 'tool_use' | 'tool_result';

export interface SessionTurn {
  kind: TurnKind;
  ts: number;
  tsIso?: string;
  line: number;
  // Content shape varies by kind:
  text?: string;                                          // user / assistant_text
  toolName?: string;                                      // tool_use / tool_result
  toolUseId?: string;                                     // both
  toolInputSummary?: string;                              // tool_use — short
  command?: string;                                       // tool_use Bash command
  resultSummary?: string;                                 // tool_result — short
  resultIsError?: boolean;                                // tool_result
  resultExitCode?: number;                                // tool_result for Bash, parsed when present
  resultBytes?: number;                                   // tool_result raw size
}

export interface ExtractedTurns {
  sessionId: string;
  found: boolean;
  turns: SessionTurn[];
  /** Exposed so callers don't have to reparse for the same numbers. */
  startMs: number;
  endMs: number;
}
