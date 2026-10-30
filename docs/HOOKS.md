# Hooks

`chat-recall init` and `chat-recall install-hooks` install these hooks. The MCP
server installs missing hooks when it starts. A tool whose folder is not on the
machine gets nothing.

## Claude Code

Registered in `settings.json` of each Claude profile (`~/.claude` and each
`~/.claude-*` with a `projects` folder).

| Event | Hook | What it does | Opt out |
|---|---|---|---|
| `SessionStart` (`startup`, `clear`) | wake-up | Adds the wake-up bundle of the project | `--no-wakeup` |
| `UserPromptSubmit` | resume hint | Searches for similar past sessions and adds a note when one exists | `--no-resume-hint` |
| `Stop` | save | Saves topics, decisions and tools to `~/.chat-recall/memory/` | — |
| `PreCompact` | save | Saves before Claude Code compacts the context | — |
| `SessionEnd` | escalate | Adds the session's decisions and outcome to the knowledge graph, in the background | `--no-escalate` |
| `PreToolUse` (shell, edit, write) | decision guard | Checks the call against the decision register | `--no-guard` |
| `UserPromptSubmit`, `SessionEnd` | task board | Claims a board card when a prompt names its id, and closes it at the end of the session | `--no-task-board` |
| `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd` | messages | Reports the session, delivers waiting messages | `--no-messages` |
| `SessionStart`, `UserPromptSubmit`, `Stop` (background) | message waiter | Waits for a message and wakes the session, also when it is idle | `--no-messages` |

On Windows, the five shell hooks (save, resume hint, escalate, wake-up and
guard) are not installed, because Claude Code runs hooks through `cmd.exe`. The
task board and message hooks install on every platform.

## Other AI tools

| Tool | File | Message hook | Decision guard |
|---|---|---|---|
| Codex | `~/.codex/hooks.json` | `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd` | `PreToolUse` |
| Antigravity | `~/.gemini/config/hooks.json` | `SessionStart`, `PreInvocation` (first call of a turn), `Stop` | `PreToolUse` |
| Cursor | `~/.cursor/hooks.json` | `sessionStart`, `beforeSubmitPrompt`, `stop`, `sessionEnd` | `beforeShellExecution`, `afterFileEdit` |
| OpenCode | `~/.config/opencode/plugins/` | plugin `chat-recall-messages.js`, with a waiter that wakes an idle session | plugin `chat-recall-guard.js` |
| pi | `~/.pi/agent/extensions/` | extension `chat-recall-messages.js`, with a waiter that wakes an idle session | — |

The other tools run the hooks through scripts in `~/.chat-recall/hooks/`. On
Windows, these scripts are not installed.

Codex runs a new hook only after you approve it with `/hooks` in Codex.

When each tool delivers a message is in
[Run sessions that work together](./SESSIONS.md).

## Commands

| Command | Effect |
|---|---|
| `chat-recall install-hooks` | Install or repair all hooks |
| `chat-recall install-hooks --no-<hook>` | Install all hooks except the named ones |
| `chat-recall install-hooks --uninstall` | Remove every chat-recall hook; the MCP server then leaves them out |
| `chat-recall doctor` | Show the hooks of each tool and profile |

Each install replaces only chat-recall's own entries. Hooks of other programs
in the same files stay.

## Environment variables

| Variable | Effect |
|---|---|
| `CHAT_RECALL_MESSAGE_HOOK=0` | Turns the message hook off |
| `CHAT_RECALL_MESSAGE_HOOK_DEBUG=1` | Writes the reason for each silent exit of the message hook to stderr |
| `CHAT_RECALL_GUARD=0` | Turns the decision guard off |
| `CHAT_RECALL_GUARD_ENFORCE=1` | Makes the decision guard block instead of warn |
| `CHAT_RECALL_WAKEUP_TIMEOUT` | Seconds before the wake-up hook gives up (default 10) |
