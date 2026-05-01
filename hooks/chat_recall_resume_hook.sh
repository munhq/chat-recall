#!/usr/bin/env bash
# chat-recall resume hint hook — fires on UserPromptSubmit.
#
# Reads the user's typed prompt from stdin (Claude Code hook input format) and,
# if it looks like a "real" task (not a slash command, not a one-word reply),
# searches chat-recall for sessions that worked on something similar. If high-
# confidence matches exist, prints a short note that gets injected into the
# session as additional context.
#
# Exit code 0 + stdout → injected as context for the assistant.
# Exit code 0 + no stdout → silent (the default when nothing useful to say).
# We never block the prompt (would be exit code 2). This is advisory only.
#
# Configurable via env:
#   CHAT_RECALL_RESUME_THRESHOLD  — min top score to surface (default 0.001 for FTS5)
#   CHAT_RECALL_RESUME_MAX        — max number of matches to mention (default 3)
#   CHAT_RECALL_BIN               — path to the chat-recall binary (default: which chat-recall)

set -euo pipefail

# Read the hook payload from stdin. Tolerate non-JSON or missing fields.
INPUT="$(cat)"

# Extract prompt — bail out cleanly if jq is missing or input is malformed.
if ! command -v jq >/dev/null 2>&1; then exit 0; fi
PROMPT="$(echo "$INPUT" | jq -r '.prompt // empty')"

# Skip if there's nothing useful to search on:
#  - empty / very short prompts
#  - slash commands (start with /)
#  - replies that are just confirmations ("yes", "ok", etc.)
if [[ -z "$PROMPT" ]]; then exit 0; fi
if [[ "${#PROMPT}" -lt 20 ]]; then exit 0; fi
if [[ "$PROMPT" == /* ]]; then exit 0; fi
if [[ "$PROMPT" =~ ^(yes|no|ok|okay|sure|continue|go|next|y|n)[[:space:]\.\!\?]*$ ]]; then exit 0; fi

CHAT_RECALL_BIN="${CHAT_RECALL_BIN:-$(command -v chat-recall || true)}"
if [[ -z "$CHAT_RECALL_BIN" ]] || [[ ! -x "$CHAT_RECALL_BIN" ]]; then
    # chat-recall not on PATH — install it first; nothing to do.
    exit 0
fi

MAX="${CHAT_RECALL_RESUME_MAX:-3}"

# Search the index. We use the search subcommand (not MCP) because hooks need
# to be fast and synchronous. Output is plain text we'll grep for session ids.
# Cap the prompt at 400 chars to avoid blowing up FTS5 query parsing.
PROMPT_SHORT="${PROMPT:0:400}"
SEARCH_OUT="$("$CHAT_RECALL_BIN" search "$PROMPT_SHORT" --top "$MAX" 2>/dev/null || true)"

# If we got no results back, exit silently — no context to add.
if [[ -z "$SEARCH_OUT" ]] || ! echo "$SEARCH_OUT" | grep -qE 'session|score|project'; then
    exit 0
fi

# Emit a compact, agent-friendly hint. The leading marker lets the assistant
# recognize the source of this context.
{
    echo "<!-- chat-recall-resume-hint -->"
    echo "**📚 You've worked on something similar before** — chat-recall found these sessions:"
    echo
    # Take the first ~15 lines of search output as the digest. The CLI already
    # formats nicely; we just trim.
    echo "$SEARCH_OUT" | head -n 18
    echo
    echo "_Use \`recall_show <session-id>\` or \`recall_smart_resume <session-id>\` to load full context if relevant._"
} || true

exit 0
