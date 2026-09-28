/**
 * The shell command that resumes a session, per AI tool.
 *
 * WHY THIS IS SHARED, not inlined at each call site.
 *
 * Every printer used to hardcode `claude --resume <id>`. For any other tool
 * that string is wrong twice over: it names the wrong binary, and it keeps the
 * chat-recall id prefix (`agy_`, `cursor_`, …) that the tool itself never
 * wrote and will not accept. It shipped because it is a string handed to a
 * human — no type checks it, no unit test asserts it, and a grep for
 * tool-enumerations does not match a line that names exactly one tool.
 *
 * So it lives in one place, and the callers import it: the CLI printers, the
 * MCP tool output, the context/dossier renderers, and the web UI's Resume
 * button (which carried a second copy of this switch until it did not).
 *
 * The mapping, and why each one is what it is:
 *
 *   claude   → claude --resume <id>            (no prefix on a claude id)
 *   codex    → codex resume <id>               (codex_)
 *   opencode → opencode -s <id>                (opencode_; -s/--session)
 *   agy      → agy --conversation <id>         (agy_; Antigravity)
 *   cursor   → cursor-agent --resume <id>      (cursor_)
 *   gemini   → (none) — `gemini --resume` takes an index or "latest", never
 *              a session id, so there is no command to print.
 *
 * Keep this in step with the tool backends in `./backends/`.
 */

/**
 * The id prefix chat-recall puts on each tool's sessions. A claude id carries
 * none. `gemini_` stays because rows synced before Gemini CLI was switched off
 * still carry it.
 */
export const SESSION_ID_PREFIXES = {
  codex: 'codex_',
  opencode: 'opencode_',
  agy: 'agy_',
  cursor: 'cursor_',
  gemini: 'gemini_',
} as const;

/** Prefix → tool, for ids whose tool is not already known. */
function toolOfSessionId(sessionId: string): string {
  for (const [tool, prefix] of Object.entries(SESSION_ID_PREFIXES)) {
    if (sessionId.startsWith(prefix)) return tool;
  }
  return 'claude';  // claude ids carry no prefix
}

/**
 * Resume command for a session, or null when the tool cannot resume by id.
 *
 * Pass `tool` when the caller already knows it; otherwise it is derived from
 * the id prefix.
 */
export function resumeCommandFor(sessionId: string, tool?: string): string | null {
  if (!sessionId) return null;
  const t = tool || toolOfSessionId(sessionId);
  const raw = (prefix: string) => (sessionId.startsWith(prefix) ? sessionId.slice(prefix.length) : sessionId);
  switch (t) {
    case 'claude':   return `claude --resume ${sessionId}`;
    case 'codex':    return `codex resume ${raw('codex_')}`;
    case 'opencode': return `opencode -s ${raw('opencode_')}`;
    case 'agy':      return `agy --conversation ${raw('agy_')}`;
    // The cursor-agent CLI only. An IDE composer id is not resumable from a
    // shell, but both surfaces share the `cursor_` prefix, so this is the best
    // available answer for either.
    case 'cursor':   return `cursor-agent --resume ${raw('cursor_')}`;
    // Gemini's `--resume` takes an index or "latest", never a session id.
    default:         return null;
  }
}
