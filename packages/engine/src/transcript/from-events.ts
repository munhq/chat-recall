/**
 * Generic bridge: a ToolBackend's canonical event stream → the {messages} shape
 * the sync/parse layer (parseTranscript → buildConversationSync) consumes.
 *
 * This is what lets parseTranscript handle ANY registered backend without a
 * hand-written per-tool parser. It exists because agy (Antigravity) was added as
 * a full ToolBackend but parseTranscript's hardcoded per-tool switch had no agy
 * branch, so every agy session parsed to null and never synced. Routing unknown
 * tools through readEvents → this converter closes that class of bug for the
 * next backend too (the ToolBackend promise: add a tool = write only the adapter).
 *
 * Grouping mirrors how a conversation reads:
 *   user           → a user message
 *   assistant_text → starts an assistant message
 *   tool_use       → a ToolCall on the current assistant message
 *   tool_result    → attached to its ToolCall by toolUseId
 *   summary        → a summary message
 */
import type { CanonicalEvent } from '../core/tool-backend.js';
import type { TranscriptMessage, ToolCall } from './types.js';

export function canonicalEventsToMessages(events: CanonicalEvent[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let cur: TranscriptMessage | null = null;          // assistant message being built
  const byToolUseId = new Map<string, ToolCall>();

  for (const e of events) {
    switch (e.kind) {
      case 'user':
        cur = null;
        messages.push({ line: e.line, role: 'user', content: e.text ?? '', timestamp: e.tsIso });
        break;
      case 'assistant_text':
        cur = { line: e.line, role: 'assistant', content: e.text ?? '', timestamp: e.tsIso };
        messages.push(cur);
        break;
      case 'tool_use': {
        if (!cur) { cur = { line: e.line, role: 'assistant', content: '', timestamp: e.tsIso }; messages.push(cur); }
        const tc: ToolCall = { name: e.toolName ?? '', input: e.toolInput };
        (cur.toolCalls ??= []).push(tc);
        if (e.toolUseId) byToolUseId.set(e.toolUseId, tc);
        break;
      }
      case 'tool_result': {
        const tc = e.toolUseId ? byToolUseId.get(e.toolUseId) : undefined;
        if (tc) { tc.result = e.resultBody; if (e.resultIsError !== undefined) tc.isError = e.resultIsError; }
        break;
      }
      case 'summary':
        cur = null;
        messages.push({ line: e.line, role: 'summary', content: e.text ?? '' });
        break;
    }
  }
  return messages;
}
