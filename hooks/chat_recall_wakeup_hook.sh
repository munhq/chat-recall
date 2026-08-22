#!/usr/bin/env bash
# chat-recall wake-up hook — fires on SessionStart (matcher: startup|clear).
#
# Prints the project-scoped wake-up bundle (high-importance facts + current
# knowledge-graph facts) to stdout. Claude Code injects stdout into the new
# session's context. This gives manual sessions the same preamble that
# coolcode injects into its spawned sessions.
#
# Exit code 0 + stdout → injected as context.
# Any failure → silent exit 0. This hook is advisory and never blocks a session.
#
# Configurable via env:
#   CHAT_RECALL_BIN            — path to the chat-recall binary (default: which chat-recall)
#   CHAT_RECALL_WAKEUP_TIMEOUT — seconds before we give up (default 10)

set -uo pipefail

if ! command -v jq >/dev/null 2>&1; then exit 0; fi

# Claude Code passes the hook payload as JSON on stdin; cwd is the project dir.
INPUT="$(cat 2>/dev/null || true)"
CWD="$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)"
[[ -z "$CWD" ]] && CWD="$PWD"
PROJECT="$(basename "$CWD")"

CHAT_RECALL_BIN="${CHAT_RECALL_BIN:-$(command -v chat-recall || true)}"
if [[ -z "$CHAT_RECALL_BIN" ]] || [[ ! -x "$CHAT_RECALL_BIN" ]]; then exit 0; fi

TIMEOUT="${CHAT_RECALL_WAKEUP_TIMEOUT:-10}"
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

OUT="$(run_limited "$TIMEOUT" "$CHAT_RECALL_BIN" memory wake-up -p "$PROJECT" 2>/dev/null || true)"
[[ -z "$OUT" ]] && exit 0

{
    echo "<!-- chat-recall-wake-up -->"
    echo "--- Prior knowledge (chat-recall wake-up, project: $PROJECT) ---"
    echo "$OUT"
}

exit 0
