/**
 * Detector for chat-recall's OWN LLM invocations that an AI CLI (Claude/Gemini)
 * logged as ordinary session transcripts.
 *
 * When chat-recall shells out to `claude -p` / `gemini` to generate a session
 * summary (or to health-check an endpoint), that invocation writes a transcript
 * into ~/.claude/projects — which the collector would then re-index as a
 * "conversation". The result is a self-pollution loop: on this machine ~half of
 * all indexed sessions were these internal calls (5079 of 10593), drowning the
 * real conversation list (1314 shown for one project that has ~131 real
 * transcripts on disk).
 *
 * The collector calls `isInternalToolPrompt()` on a session's first user message
 * and skips the session when it matches. Signatures are anchored to the START of
 * the prompt so a real conversation that merely *quotes* one of these strings is
 * not dropped.
 */

/** Prompt-prefix signatures of chat-recall's own LLM calls. Keep anchored. */
const INTERNAL_PROMPT_PREFIXES: string[] = [
  // summary-generator.ts → buildPrompt()
  'You are summarizing a coding assistant conversation',
];

/** Whole-prompt signatures (short health-checks / pings). */
const INTERNAL_PROMPT_EXACT: RegExp[] = [
  /^say (?:just|exactly) the word PONG/i,
  /^"?Say exactly the word PONG/i,
];

/**
 * True when `firstUserMessage` is one of chat-recall's own internal LLM prompts
 * (summary generation, health-check ping) rather than a human conversation.
 * Trims leading whitespace/quotes so wrapped prompts still match.
 */
export function isInternalToolPrompt(firstUserMessage: string | undefined | null): boolean {
  if (!firstUserMessage) return false;
  const s = firstUserMessage.replace(/^[\s"'`]+/, '');
  for (const p of INTERNAL_PROMPT_PREFIXES) if (s.startsWith(p)) return true;
  for (const re of INTERNAL_PROMPT_EXACT) if (re.test(s)) return true;
  return false;
}
