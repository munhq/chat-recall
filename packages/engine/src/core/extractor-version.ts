/**
 * Version of the session-extraction logic — the code that turns a raw
 * transcript (main .jsonl + any subagents/) into chunks, summaries,
 * metadata, and the derived rows (diff / commits / markers / outcome).
 *
 * This is the freshness dimension that file mtime CANNOT capture: when the
 * extraction code changes, previously-synced rows are potentially wrong even
 * though the source transcript is byte-for-byte unchanged. The sync ledger
 * records the version each session was synced under and re-pushes any session
 * whose recorded version is older than the version that applies to it — so an
 * extraction fix self-heals on the next `chat-recall sync`, with no manual
 * ledger surgery and no blanket --full backfill.
 *
 * VERSIONING IS PER-TOOL. A fix to one backend's extractor (e.g. Antigravity's
 * project attribution) must NOT re-ship every Claude/Gemini/OpenCode session on
 * every device — that's a huge, pointless resync. So the effective version for
 * a session is `BASE + (per-tool bump for that session's tool)`:
 *   - Bump BASE for a CROSS-CUTTING change (shared parser/engine) → all tools
 *     re-ship.
 *   - Add/raise a TOOL_EXTRACTOR_BUMP entry for a change that only affects one
 *     backend → only that tool's sessions re-ship.
 *
 * History:
 *   BASE 1 — implicit original (pre-versioning).
 *   BASE 2 — include the main transcript alongside subagents/ in both
 *            parseSessionFile and resolveSessionContentPaths. Sessions that
 *            spawned sub-agents previously dropped their entire main thread
 *            (all Edit/Write/Bash work) from chunks, summaries, and diffs.
 *   agy +1 — Antigravity project attribution + edit extraction. agy sessions
 *            were all mis-attributed to trustedWorkspaces[0] (one global
 *            fallback); findSession/listSessions now derive the real project
 *            from the file paths the session touched, and readEvents normalizes
 *            TargetFile → file_path. Only agy sessions re-ship — Claude/Gemini/
 *            OpenCode data is untouched.
 *   agy +2 — read `transcript_full.jsonl` instead of the compacted
 *            `transcript.jsonl`. The plain file is only the last exchange, so
 *            most turns AND edits were dropped; the full log is the complete
 *            record. Re-ships agy sessions with their full conversation + edits.
 *   claude +1 — read `queue-operation` records as prompts. A prompt typed WHILE
 *            A TOOL RUNS is stored as {type:'queue-operation',
 *            operation:'enqueue'}, never as a type:'user' record, so both the
 *            event reader and the chunk parser dropped it: 12 of 61 prompts in
 *            one measured session, and precisely the interruptions and
 *            corrections. The same bump also covers the system-reminder gate,
 *            which discarded a whole prompt when a reminder was appended to it.
 *            Claude-only: backends/claude.ts and the Claude-gated
 *            parsers/session.ts. Gemini/OpenCode/Codex/agy data is untouched.
 *   codex +1 — read prompts from response_item/message with role='user'. They
 *            were read only from event_msg/user_message, which current rollouts
 *            do not write, so EVERY Codex session extracted zero user turns:
 *            no prompts, no markers, no first prompt. Re-ships codex sessions.
 */
const BASE_EXTRACTOR_VERSION = 2;

/** Per-tool bumps ON TOP of the base. Key by AiTool id (the id prefix's tool). */
const TOOL_EXTRACTOR_BUMP: Record<string, number> = {
  agy: 2,
  claude: 1,
  codex: 1,
};

/** The tool a prefixed id belongs to (mirrors the ToolBackend prefixes). Works
 *  for session ids AND item ids (plans/tasks carry the same tool prefix). */
export function toolOfId(id: string): string {
  if (id.startsWith('agy_')) return 'agy';
  if (id.startsWith('gemini_')) return 'gemini';
  if (id.startsWith('opencode_')) return 'opencode';
  if (id.startsWith('codex_')) return 'codex';
  return 'claude'; // claude has no prefix
}

/** Effective extractor version for a given tool. */
export function extractorVersionForTool(tool: string | undefined): number {
  return BASE_EXTRACTOR_VERSION + (TOOL_EXTRACTOR_BUMP[tool ?? ''] ?? 0);
}

/** Effective extractor version for a prefixed session id (derives the tool). */
export function extractorVersionForId(id: string): number {
  return extractorVersionForTool(toolOfId(id));
}

/**
 * Back-compat constant for callers without per-session context. It is the BASE
 * only — the max across tools is never needed, since every read/write site that
 * has a session id uses the per-id function. Kept so existing imports compile.
 */
export const EXTRACTOR_VERSION = BASE_EXTRACTOR_VERSION;

// Per-FIELD versions (native title, …) used to live here. They now live with
// each field in the derived-field registry (core/sync-fields.ts), so adding or
// re-versioning a field is one local edit and the sync/ledger stay generic.
// A field re-scan pushes only that field — it never re-pushes conversations.
