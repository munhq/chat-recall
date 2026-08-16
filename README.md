# chat-recall

> Search, browse, and resume past AI coding sessions across Claude Code, Gemini CLI, and OpenCode — and let the agent search its own history via MCP.

`chat-recall` is a **CLI** that indexes the transcripts your AI tools already write to disk, redacts secrets, and syncs them to a **chat-recall server**. The server runs **either locally with Postgres (Docker Compose) or as the hosted SaaS** — it gives you a web UI to browse everything and exposes it to Claude Code through **46 MCP tools** so the agent can recall its own past work without you copy-pasting context. There is no local store and no offline mode: the CLI always talks to a server.

## Four things it actually does

1. **Cross-tool unified memory.** One index, one search, one UI for Claude Code (`~/.claude/projects/`), Gemini CLI (`~/.gemini/tmp/`), and OpenCode (`~/.local/share/opencode/`). Sessions, plans, tasks, CLAUDE.md, paste cache, command history, and agent diaries all share a single pluggable `MemorySource` interface.
2. **The agent recalls itself.** 46 MCP tools so Claude Code can `recall_smart_resume`, `recall_similar_sessions`, `recall_files_touched`, `recall_subagent_search`, `recall_redundant_files`, etc., instead of you describing what happened last time. It can also write decisions back via `recall_decision_record` and stash small state via `recall_set` / `recall_get`.
3. **Warns before redoing work.** A `UserPromptSubmit` hook fires on every prompt you type, runs a quick search for similar past sessions, and injects a brief "you've worked on this before in session X" notice into the agent's context. Pair with the bundled **codeindex** companion (see below) to also warn when the new code you're about to write looks like code that already exists.
4. **Temporal knowledge graph.** Decisions and tool/library mentions become entity-relationship triples with `valid_from`/`valid_to` windows, so you (and the agent) can ask "what did we decide about X in March, and is it still true?".

## Quickstart

chat-recall is a **collector + server**. Stand up a server, point the collector at it, sync.

**Self-host (Docker Compose — Postgres-backed server on `:8080`):**
```bash
git clone <repo-url> && cd chat-recall
docker compose up -d                        # server + Postgres
./install.sh                                # builds the monorepo, links the `chat-recall` collector
chat-recall login http://localhost:8080     # (add --token <ct_…> if AUTH_PROVIDER isn't `none`)
chat-recall sync                            # ship your sessions
chat-recall search "auth bug"               # query the server
```

**Hosted SaaS:** skip Docker — `chat-recall login https://chat-recall.hotmun.com`, then `sync`.

No API keys required: the server's Postgres FTS is the default search backend; vector search and summaries are upgrades, not requirements. `chat-recall init` also registers the MCP server in `~/.mcp.json` automatically.

### Optional: vector search

```bash
ollama pull nomic-embed-text
chat-recall sync --full       # re-ships; the server embeds chunks into pgvector
```

…or set `EMBEDDING_PROVIDER=gemini` with `GEMINI_API_KEY` if you'd rather use a hosted embedder. Without either, search falls back to Postgres FTS — same results surface, slightly less semantic.

### Optional: web dashboard

The React dashboard is part of the **server** (SaaS or self-host docker
compose) — the CLI itself has no UI. For dashboard development:

```bash
npm run web:install                 # install web deps
npm run web:dev                     # API on :5000, UI on :5174
```

### Self-host the server (docker compose)

Two containers — the server plus a bundled **Postgres** (the compose is
Postgres-only; data bind-mounts to `${PG_DATA_DIR}`). See the quick start at
the top of `docker-compose.yml` (set `ADMIN_KEY`, mint a device token, then
`chat-recall login <url> --token <ct_…>` from each machine).

The default compose already ships a `pgvector/pgvector` Postgres service, so a
plain `docker compose up` is self-contained. Bring-your-own-Postgres is also
supported (it's how the hosted SaaS runs): point the server at an external
database with `CHAT_RECALL_STORAGE=postgres` and `DATABASE_URL=postgres://…`
(Postgres 16+; the `pgvector` extension is needed only for server-side semantic
vectors — everything degrades to FTS without it).

### Keep the index live (+ optional server sync)

```bash
chat-recall watch                    # foreground daemon: watches all 4 tools, summaries, precompute
chat-recall watch --install-service  # Linux: install + start a systemd user service
```

When you're logged in to a chat-recall server (`chat-recall login <url>`), the
daemon also pushes redacted conversations incrementally after each indexing
batch — secrets are always masked client-side before anything leaves the
machine. `chat-recall sync` does the same push once, on demand.

## Hook it up to Claude Code

`chat-recall init` does this for you. Manual equivalent in `~/.mcp.json`:

```json
{
  "mcpServers": {
    "chat-recall": {
      "command": "chat-recall-mcp"
    }
  }
}
```

Then install the hooks (one command sets up auto-save, pre-compact backup, and the resume-hint that warns when you're about to redo work):

```bash
chat-recall install-hooks                # registers Stop + PreCompact + UserPromptSubmit
chat-recall install-hooks --no-resume-hint  # skip the resume warning if you don't want it
chat-recall install-hooks --uninstall     # remove all of ours, leave third-party hooks alone
```

| Hook | When it fires | What it does |
|---|---|---|
| `Stop` | After every assistant turn | Auto-saves topics, decisions, and tools to `~/.chat-recall/memory/` |
| `PreCompact` | Before Claude Code compacts context | Emergency save so nothing is lost to compaction |
| `UserPromptSubmit` | When you type a prompt | Searches past sessions; if a similar one exists, injects "you've worked on this before" into the agent's context |

## Companion: codeindex (auto-detected)

There's a separate MCP server called **codeindex** (Zig binary, ~56 MB) by [@hotmun](https://github.com/munhq/codeindex) that gives the agent code-level lookup. The two compose:

- **chat-recall** = session memory. *What have I worked on? What did we decide?*
- **codeindex** = code memory. *Where is this symbol? Who calls it? What breaks if I change it?*

Together the agent can answer "have I built this before?" *and* "does it already exist in this codebase?" before redoing work.

**How chat-recall handles it:** `chat-recall init` detects whether `codeindex` is on your PATH (or at `~/.local/bin/codeindex`). If yes, it registers it as an MCP server in `~/.mcp.json` automatically — no download, no surprise. If no, it prints a one-line hint about how to get it.

```bash
chat-recall init                       # default — detect and register if installed
chat-recall init --with-codeindex      # additionally force-download the binary
chat-recall init --skip-codeindex      # don't even check
chat-recall companions install         # download manually (after init)
chat-recall companions status          # show what was detected
chat-recall companions uninstall       # remove the binary + MCP registration
```

The codeindex release artifacts are currently in a private repo, so `--with-codeindex` only works if you have access to it. The install is optional — chat-recall works entirely without codeindex; you just don't get the code-level tools.

## What gets indexed

| Source | Origin | Notes |
|--------|--------|-------|
| **Sessions (Claude)** | `~/.claude/projects/<hash>/<uuid>.jsonl` | Full transcripts, tokens, cost, files touched, models used |
| **Sessions (Gemini CLI)** | `~/.gemini/tmp/*/chats/*.json` | Tokens and tool usage extracted where present |
| **Sessions (OpenCode)** | `~/.local/share/opencode/opencode.db` (SQLite) | Cost, tokens, todos |
| **Subagent transcripts** | `<session-dir>/<id>/subagents/*.jsonl` | Explore, aside, **and `acompact-*`** (orphaned compacted history) |
| **Plans** | `~/.claude/plans/*.md` | Agent planning docs, split by `##` |
| **Tasks** | `~/.claude/tasks/<session>/*.json` | Linked to parent session |
| **CLAUDE.md** | Auto-discovered from project hashes | Linked to sessions in same project |
| **History** | `~/.claude/history.jsonl` | Shell history, optionally tied to a session |
| **Paste** | `~/.claude/paste-cache/*.txt` | Large pasted blobs |
| **Diary** | `~/.chat-recall/index/diary/<agent>/*.json` | What the agent told its future self via `recall_diary_write` |

## MCP tools (46, plus 4 code-intelligence tools when the codeindex companion is installed)

**Search & retrieve** — `recall_search`, `recall_memory_search`, `recall_recent`, `recall_show`, `recall_context`, `recall_summary`, `recall_smart_resume`, `recall_project_context`, `recall_weekly_digest`, `recall_analytics_summary`, `recall_wake_up`.

**Pattern detection** (the launch-headline tools) — `recall_similar_sessions` (vector cluster of past work matching a query), `recall_redundant_files` (warn when a new filename overlaps prior work), `recall_session_files` (what files did session X actually touch), `recall_files_touched` (which sessions edited `auth.rs`).

**Subagents & filters** — `recall_subagent_search` (search inside hidden Explore/aside/compact transcripts), `recall_user_prompts` (only what the human typed, banner-stripped).

**Knowledge graph** — `recall_kg_query`, `recall_kg_add`, `recall_kg_invalidate`, `recall_kg_timeline`, `recall_kg_stats`. Plus `recall_decision_record` to write a decision as both a triple and a diary entry in one call.

**KV state** — `recall_set`, `recall_get` (no key = list the scope). Small persistent values keyed by namespaced strings: "current PR url", "branch I'm working on", user prefs.

**Diary & status** — `recall_diary_write`, `recall_diary_read`, `recall_status` (includes memory breakdown), `recall_index`. Plans/tasks: search via `recall_memory_search(source_types:['plan','task'])`, read via `recall_show`.

When the codeindex companion is installed, the agent *also* gets 16 code-level tools (`find_symbol`, `find_callers`, `get_imports`, `plan_change`, `get_change_impact`, `analyze`, etc.) from a separate MCP server. They compose: chat-recall finds what you've done; codeindex tells you what currently exists.

## Search architecture

Search runs **on the server**. Two backends, Postgres FTS is the default:

- **Postgres FTS** — zero extra setup. Keyword search with ranking. Always available.
- **Vector (pgvector)** — opt-in. 768-dim embeddings via Ollama (`nomic-embed-text`) or Gemini (`text-embedding-004`).

The CLI ships redacted chunks to the server, which indexes them. If no embedder is configured, every search tool transparently falls back to FTS.

## Cost tracking

Cost in USD is computed from token usage when at least one model in the session has a known public price (currently Opus 4.6, Sonnet 4.5/4.6, Haiku 4.5). For models we don't have prices for (Gemini, Ollama, custom), the dashboard shows `—` instead of fabricating a number. The summary surfaces a `sessionsWithoutPricing` counter so you know how representative the totals are.

## Wake-up context

```bash
chat-recall memory wake-up
```

Builds a small bundle for an AI session: optional identity blurb, the top 10 chunks the classifier flagged as decisions/preferences/milestones at importance ≥ 4, and a snapshot of currently-valid knowledge-graph facts. No magic compression — just the highest-signal items the indexer already tags.

## Data locations

The **CLI** keeps almost nothing locally — just what it needs to reach the server:

| Path | What |
|------|------|
| `~/.chat-recall/credentials.json` | Server target(s) + device token (mode 0600) |
| `~/.chat-recall/sync-ledger.json` | Per-server sync watermark (what's already shipped) |
| `~/.chat-recall/hooks/` | Installed save hook (after `install-hooks`) |

All indexed content — chunks, FTS, vectors, knowledge graph, secret findings, diary — lives **on the server** (Postgres for self-host and SaaS). Reset it by wiping the server's Postgres data, not anything under `~/.chat-recall`.

## Privacy

Your sessions sync to a chat-recall server — either one **you self-host** (your own box, your own Postgres) or the **SaaS**. Before anything leaves the CLI it is **redacted**: secrets are masked client-side, so the server never receives raw credentials. Self-hosting keeps all data on infrastructure you control; the SaaS is the hosted alternative.

No telemetry. Your data lives in **your** server's Postgres — back that up however you like. On the SaaS it lives in the hosted Postgres; self-host if you'd rather keep it entirely on your own infrastructure.

## Architecture

```
packages/
├── engine/src/
│   ├── core/
│   │   ├── backends/        ToolBackend per AI tool (claude, gemini, opencode, codex)
│   │   ├── tool-backend.ts  Registry interface — single source of truth for tool identity
│   │   ├── tool-paths.ts    Env-overridable default paths for each tool
│   │   ├── generic-engine.ts  Shared turn extraction / edit scan / replay (canonical events)
│   │   └── …                Indexing, storage, embeddings, summaries, KG, classifier
│   └── parsers/             *-source.ts plugins per content type (sessions, plans, tasks, …)
├── cli/
│   ├── src/cli.ts           CLI
│   ├── src/mcp.ts           MCP server
│   ├── auto-indexer/        chokidar-based watcher daemon (systemd-friendly)
│   └── hooks/               Claude Code hooks (install via `chat-recall install-hooks`)
└── server/
    ├── src/                 Express API
    ├── client/              React + Vite UI (also generates the static marketing pages)
    └── cloud/migrations/    SQL migrations

docker/                  Dockerfiles + nginx
e2e/                     Playwright tests (*.mobile.spec.ts run on phone viewports)
```

Two extension points, both registry-driven:

- **Adding a new content type** (e.g. another file format to index) — implement `MemorySource` (`discover` → `parse` → `extractLinks`) and register it in the `SourceRegistry`.
- **Adding a new AI tool** (a fifth backend alongside Claude/Gemini/OpenCode/Codex) — implement `ToolBackend` (paths, ID handling, `readEvents`, `fileToolMap`, `extractEditDelta`) and register it in `packages/engine/src/core/backends/index.ts`. Walkthrough: [`docs/ADDING_A_TOOL.md`](docs/ADDING_A_TOOL.md). All paths are env-overridable via `CHAT_RECALL_{CLAUDE,GEMINI,CODEX}_HOME` / `CHAT_RECALL_OPENCODE_DB`.

## Requirements

- Node.js 18+
- Optional: Ollama (local, free) for vector search & local summaries
- Optional: Gemini or Anthropic API key for hosted embeddings/summaries
- Sessions in `~/.claude/`, `~/.gemini/`, or `~/.local/share/opencode/` (standard tool locations)

## License

This repository is **dual-licensed by component**:

- **`packages/cli` and `packages/engine` — [MIT](packages/cli/LICENSE).** The
  collector CLI and the shared engine are permissively licensed.
- **`packages/server` — [Business Source License 1.1](packages/server/LICENSE).**
  The server is source-available (not OSI open source); see its `LICENSE` for the
  additional-use grant and the change date after which it converts to an open
  license.

See each package's `LICENSE` file for the authoritative terms.
