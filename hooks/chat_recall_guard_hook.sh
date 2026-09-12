#!/usr/bin/env bash
# chat-recall decision guard — fires before a tool call runs.
#
# Reads the harness's pre-execution payload on stdin, asks the decision register
# whether this call reaches for something already ruled out, and prints the
# answer in that harness's own dialect. Registered as:
#
#   Claude Code   PreToolUse            settings.json hooks
#   Codex         PreToolUse            hooks.json / [hooks] in config.toml
#   Antigravity   PreToolUse            .agents/hooks.json
#   Cursor        beforeShellExecution  .cursor/hooks.json
#
# OpenCode uses a TypeScript plugin rather than a script; `chat-recall guard`
# is the same entry point there.
#
# ── Silence is the correct failure mode ─────────────────────────────────────
#
# Every failure path exits 0 with no output, and this file never blocks. A guard
# that errors is a guard that stops work it was never asked to judge, and the
# first time it does that somebody removes it — after which it protects nothing.
# The binary itself is written the same way.
#
# Env:
#   CHAT_RECALL_BIN            path to the binary (default: from PATH)
#   CHAT_RECALL_GUARD_HARNESS  claude | codex | agy | cursor | opencode
#   CHAT_RECALL_GUARD=0        turn the guard off entirely
#   CHAT_RECALL_GUARD_ENFORCE=1  block instead of warning (opt in; see below)

set -uo pipefail

# Off by request. Checked first so disabling costs nothing.
if [[ "${CHAT_RECALL_GUARD:-1}" == "0" ]]; then exit 0; fi

# stdin is the payload. Read it even when we are about to bail, or the harness
# can see a broken pipe on a hook that was only meant to be quiet.
INPUT="$(cat 2>/dev/null || true)"
[[ -z "$INPUT" ]] && exit 0

BIN="${CHAT_RECALL_BIN:-$(command -v chat-recall 2>/dev/null || true)}"
if [[ -z "$BIN" ]] || [[ ! -x "$BIN" ]]; then exit 0; fi

HARNESS="${CHAT_RECALL_GUARD_HARNESS:-claude}"

ARGS=(guard --harness "$HARNESS")
# Enforcement is opt-in and per machine. The default is a warning on every
# harness, because a wrong block burns the user's turn while a wrong warning
# costs a line of context — and only one of those gets the guard uninstalled.
if [[ "${CHAT_RECALL_GUARD_ENFORCE:-0}" == "1" ]]; then ARGS+=(--enforce); fi

# A hard ceiling on top of the binary's own timeout. This runs in front of every
# tool call, so the worst case has to be bounded by something the harness can
# rely on rather than by a network.
printf '%s' "$INPUT" | timeout 8 "$BIN" "${ARGS[@]}" 2>/dev/null || true
exit 0
