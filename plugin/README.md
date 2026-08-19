# chat-recall — Claude Code plugin

Installs the **chat-recall Agent Skills** and wires the **chat-recall MCP server**
in one step, so any agent knows when and how to use `recall_*` to resume prior
sessions, search past work, recall decisions, and read project intelligence.

> This plugin is the **Claude Code** distribution channel. To light up your other
> AI tools (Gemini, Codex, OpenCode, Antigravity) too, install the CLI and run
> `chat-recall init` — it drops the same skills into every tool's skills dir.

## Install

```
/plugin marketplace add munhq/chat-recall
/plugin install chat-recall
```

That configures the `chat-recall` MCP server (via `npx -p chat-recall
chat-recall-mcp`) and enables the bundled skills. You still need to be logged in
to a chat-recall server — run `npx chat-recall login <server-url>` (or
`chat-recall init`).

## What's bundled

| Skill | Fires when you… |
| --- | --- |
| `chat-recall` (hub) | "continue", "did we decide", "remember when", "what do you know about this project" |
| `chat-recall-resume` | resume / pick up prior work |
| `chat-recall-find` | "remember when / have we done X / find my notes" |
| `chat-recall-memory` | "remember this / did we decide / what do you know" |
| `chat-recall-project` | "state of this project / catch me up" |
| `chat-recall-changes` | "what did I change / did it ship" |

## Source of truth

The `skills/` here are copied from the CLI package (`packages/cli/skills/`) by
`scripts/build-plugin.mjs` — do not edit them here; edit the source and re-run
the sync so the plugin and the `chat-recall init` drop-in never diverge.
