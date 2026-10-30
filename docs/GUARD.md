# Keep decisions with the decision guard

The decision guard runs before an agent's tool call. When the call installs or
imports something that a recorded decision ruled out, the guard tells the
agent:

```
chat-recall: this reaches for something already decided against.
- auth0 was ruled out — BetterAuth is the decision (2026-03-14) · session 8f2c1a4e
Proceed only if this is a deliberate reversal. If it is, record it:
recall_decision_record with the area, so the old decision is closed rather than contradicted.
```

## Turn it on

`chat-recall init` installs the guard in each AI tool on the machine. To install
it again, or after you added a tool:

```bash
chat-recall install-hooks
```

Codex runs a new hook only after you approve it. Open Codex and run `/hooks`
once.

To check each tool:

```bash
chat-recall doctor
```

## Record the decisions it checks

The guard checks the decision register. An agent adds to it with
`recall_decision_record`. Give each decision an `area`, for example `auth`,
`database` or `payments`, so a later decision in the same area replaces it.

To fill the register from a repository's manifests, ask the agent to run
`recall_decision_scan`. It reads `package.json`, `Cargo.toml`,
`pyproject.toml`, `requirements.txt`, `go.mod`, `Gemfile` and
`composer.json`, and shows the product that answers each area. With
`record: true`, it records those answers for the project, with the file and
line as the reason.

To see what is decided, ask the agent to run `recall_decisions`. It returns one
value per area: a project decision wins over an account decision. It also
returns the areas that nobody decided yet.

## Block instead of warn

The guard warns and lets the call continue. To make it block the call on one
machine, set:

```bash
export CHAT_RECALL_GUARD_ENFORCE=1
```

To turn the guard off on one machine, set `CHAT_RECALL_GUARD=0`. To remove it
from all tools, run `chat-recall install-hooks --no-guard`.

## What the guard sees in each tool

| Tool | Where the hook is | When it runs |
|---|---|---|
| Claude Code | `settings.json` of each profile | before a shell command or an edit |
| Codex | `~/.codex/hooks.json` | before a shell command or a patch |
| Antigravity | `~/.gemini/config/hooks.json` | before a command or a file write |
| Cursor | `~/.cursor/hooks.json` | before a shell command, and after a file edit |
| OpenCode | `~/.config/opencode/plugins/chat-recall-guard.js` | before each tool call |

Cursor reports an import in an edit after it is written, because Cursor has no
hook before an edit. OpenCode does not run plugin hooks for the tool calls of a
subagent.

The guard reacts to installs, imports and manifest edits, such as
`npm install auth0`, a new `import` line or a new name in `package.json`. It
does not react to text: "we could use Auth0" in a message passes.
