#!/usr/bin/env bash
# chat-recall escalate hook — fires on SessionEnd.
#
# The write half of the Context Engineering loop: the SessionStart wake-up
# hook injects prior knowledge INTO a new session; this hook escalates the
# finished session's learnings (decisions the agent announced, corrections
# the user gave, and the outcome) OUT into the temporal knowledge graph via
# `chat-recall escalate`, so the next wake-up already knows them.
#
# Runs asynchronously: the work is backgrounded and detached, so session end
# never waits on network writes. The delay gives the collector a chance to
# sync the session's final events before extraction.
#
# Always exits 0. A hook must never break session end.
#
# Configurable via env:
#   CHAT_RECALL_BIN              — path to the chat-recall binary (default: which chat-recall)
#   CHAT_RECALL_ESCALATE_TIMEOUT — seconds before the background run gives up (default 60)
#   CHAT_RECALL_ESCALATE_DELAY   — seconds to wait for the final sync (default 20)

set -uo pipefail

# Claude Code passes the hook payload as JSON on stdin; cwd is the project dir.
INPUT="$(cat 2>/dev/null || true)"
CWD=""
SESSION_ID=""
if command -v jq >/dev/null 2>&1; then
  CWD="$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)"
  SESSION_ID="$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)"
fi
[[ -z "$CWD" ]] && CWD="$PWD"

CHAT_RECALL_BIN="${CHAT_RECALL_BIN:-$(command -v chat-recall || true)}"
if [[ -z "$CHAT_RECALL_BIN" ]] || [[ ! -x "$CHAT_RECALL_BIN" ]]; then exit 0; fi

# Run a command under a time limit, on any platform.
#
# `timeout` is GNU coreutils and macOS does not ship it. Both hooks that used it
# swallowed the failure with `|| true`, so on every Mac the command never ran at
# all — silently, while `chat-recall doctor` reported the hook installed and
# healthy. Homebrew's coreutils installs it as `gtimeout`, so prefer whichever
# exists and fall back to a plain shell watchdog when neither does.
run_limited() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  else
    # Watchdog: run in the background, kill it if it outlives the budget.
    "$@" &
    local cmd_pid=$!
    ( sleep "$secs"; kill -TERM "$cmd_pid" 2>/dev/null || true ) &
    local watch_pid=$!
    wait "$cmd_pid" 2>/dev/null
    local rc=$?
    kill -TERM "$watch_pid" 2>/dev/null || true
    return $rc
  fi
}

TIMEOUT="${CHAT_RECALL_ESCALATE_TIMEOUT:-60}"
DELAY="${CHAT_RECALL_ESCALATE_DELAY:-20}"

# Detach completely: no stdio ties back to the session, so Claude Code's
# hook runner returns immediately and the escalation happens in the background.
(
  sleep "$DELAY"
  cd "$CWD" 2>/dev/null || true
  if [[ -n "$SESSION_ID" ]]; then
    run_limited "$TIMEOUT" "$CHAT_RECALL_BIN" escalate "$SESSION_ID" >/dev/null 2>&1 || true
  else
    run_limited "$TIMEOUT" "$CHAT_RECALL_BIN" escalate --latest >/dev/null 2>&1 || true
  fi
) </dev/null >/dev/null 2>&1 &

exit 0
