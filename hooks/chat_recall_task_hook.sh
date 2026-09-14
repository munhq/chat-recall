#!/usr/bin/env bash
# chat-recall task hook — keeps the board in step with the work.
#
# Two events, one script:
#   --claim   UserPromptSubmit. A prompt that names a card id claims that card
#             and links this session to it.
#   --close   SessionEnd. A commit in this repository whose message names a card
#             id closes that card, with the commit as the evidence.
#
# The id is the whole signal. A card the writer did not name is left alone, so
# the board never carries a claim nobody made.
#
# Set CHAT_RECALL_TASK_HOOK=0 to switch both off.

set -uo pipefail

if [[ "${CHAT_RECALL_TASK_HOOK:-1}" == "0" ]]; then exit 0; fi

INPUT="$(cat 2>/dev/null || true)"
[[ -z "$INPUT" ]] && exit 0

BIN="${CHAT_RECALL_BIN:-$(command -v chat-recall 2>/dev/null || true)}"
if [[ -z "$BIN" ]] || [[ ! -x "$BIN" ]]; then exit 0; fi

MODE="${1:---claim}"

# The claim path prints one short block into the turn, so it runs in the
# foreground with a tight bound. 8 seconds covers a read and a write against the
# server; past that the prompt matters more than the bookkeeping.
if [[ "$MODE" == "--claim" ]]; then
  printf '%s' "$INPUT" | timeout 8 "$BIN" task-hook --claim 2>/dev/null || true
  exit 0
fi

# The close path writes and prints nothing, and session end must never wait for
# a network call. Detach it, exactly as the escalate hook does.
(
  printf '%s' "$INPUT" | timeout 30 "$BIN" task-hook --close >/dev/null 2>&1 || true
) </dev/null >/dev/null 2>&1 &

exit 0
