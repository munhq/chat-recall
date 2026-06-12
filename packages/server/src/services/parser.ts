/**
 * COMPATIBILITY SHIM — the parser moved to the engine.
 *
 * The canonical transcript parser lives in
 * `@chat-recall/engine/transcript/` (docs/ARCHITECTURE_RESET.md). This file
 * only maps the old server-local names onto it so existing imports keep
 * working while routes migrate to reading content_cache. No parsing logic
 * may be added here — new code imports from the engine directly.
 */
export {
  parseClaudeTranscript as getConversation,
  parseClaudeSubagents as getSubagents,
  parseGeminiTranscript as getGeminiConversation,
  parseOpenCodeTranscript as getOpenCodeConversation,
  parseOpenCodeSubagents as getOpenCodeSubagents,
  parseCodexTranscript as getCodexConversation,
  parseCodexSubagents as getCodexSubagents,
  type TranscriptMessage as Message,
  type Subagent,
} from '../imports.js';
