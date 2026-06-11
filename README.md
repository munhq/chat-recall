# chat-recall

> Search, browse, and resume past AI coding sessions across Claude Code, Gemini CLI, and OpenCode — and let the agent search its own history via MCP.

`chat-recall` indexes the JSONL/JSON/SQLite transcripts your AI tools already write to disk, gives you a web UI to browse them, and exposes them to Claude Code through **42 MCP tools** so the agent can recall its own past work without you copy-pasting context. Local-first by default, no account, no upload.

## Four things it actually does

1. **Cross-tool unified memory.** One index, one search, one UI for Claude Code (`~/.claude/projects/`), Gemini CLI (`~/.gemini/tmp/`), and OpenCode (`~/.local/share/opencode/`). Sessions, plans, tasks, CLAUDE.md, paste cache, command history, and agent diaries all share a single pluggable `MemorySource` interface.
2. **The agent recalls itself.** 42 MCP tools so Claude Code can `recall_smart_resume`, `recall_similar_sessions`, `recall_files_touched`, `recall_subagent_search`, `recall_redundant_files`, etc., instead of you describing what happened last time. It can also write decisions back via `recall_decision_record` and stash small state via `recall_set` / `recall_get`.
3. **Warns before redoing work.** A `UserPromptSubmit` hook fires on every prompt you type, runs a quick search for similar past sessions, and injects a brief "you've worked on this before in session X" notice into the agent's context. Pair with the bundled **codeindex** companion (see below) to also warn when the new code you're about to write looks like code that already exists.
4. **Temporal knowledge graph.** Decisions and tool/library mentions become entity-relationship triples with `valid_from`/`valid_to` windows, so you (and the agent) can ask "what did we decide about X in March, and is it still true?".

## Quickstart (no API keys, no Ollama)

```bash
git clone <repo-url>
cd chat-recall
./install.sh                  # builds the monorepo, links the `chat-recall` binary, runs init
chat-recall search "auth bug" # try it
```

That works right now. **No Ollama, no Gemini key, no Claude key.** SQLite FTS5 is the default search backend; vector search and summaries are upgrades, not requirements. `chat-recall init` also registers the MCP server in `~/.mcp.json` automatically.

### Optional: vector search

```bash
ollama pull nomic-embed-text
chat-recall index --force     # this time chunks are embedded into LanceDB
```

…or set `EMBEDDING_PROVIDER=gemini` with `GEMINI_API_KEY` if you'd rather use a hosted embedder. Without either, search falls back to FTS5 — same results surface, slightly less semantic.

### Optional: web dashboard (server-side, separate from the local binary)

The React dashboard belongs to the server product (SaaS or self-host docker
compose) — the local binary itself has no UI. For dashboard development:

```bash
npm run web:install                 # install web deps
npm run web:dev                     # API on :5000, UI on :5173
```

### Self-host the server (docker compose)

One container, SQLite storage in a named volume — see the quick start at the
top of `docker-compose.yml` (set `ADMIN_KEY`, mint a device token, then
`chat-recall login <url> --token <ct_…>` from each machine).

Bring-your-own-Postgres is supported by the engine (it's how the hosted SaaS
runs): point the container at it with `CHAT_RECALL_STORAGE=postgres` and
`DATABASE_URL=postgres://…` — needs Postgres 16+; install the `pgvector`
extension only if you want server-side semantic vectors (everything degrades
to FTS without it). The compose deliberately doesn't ship a Postgres service.

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

There's a separate MCP server called **codeindex** (Zig binary, ~56 MB) by [@munhq](https://github.com/munhq/codeindex) that gives the agent code-level lookup. The two compose:

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

## MCP tools (42)

**Search & retrieve** — `recall_search`, `recall_memory_search`, `recall_recent`, `recall_show`, `recall_context`, `recall_summary`, `recall_suggest_resume`, `recall_smart_resume`, `recall_project_context`, `recall_weekly_digest`, `recall_analytics_summary`, `recall_wake_up`.

**Pattern detection** (the launch-headline tools) — `recall_similar_sessions` (vector cluster of past work matching a query), `recall_redundant_files` (warn when a new filename overlaps prior work), `recall_session_files` (what files did session X actually touch), `recall_files_touched` (which sessions edited `auth.rs`).

**Subagents & filters** — `recall_subagent_search` (search inside hidden Explore/aside/compact transcripts), `recall_user_prompts` (only what the human typed, banner-stripped).

**Knowledge graph** — `recall_kg_query`, `recall_kg_add`, `recall_kg_invalidate`, `recall_kg_timeline`, `recall_kg_stats`. Plus `recall_decision_record` to write a decision as both a triple and a diary entry in one call.

**KV state** — `recall_set`, `recall_get`, `recall_kv_list`. Small persistent values keyed by namespaced strings: "current PR url", "branch I'm working on", user prefs.

**Diary & status** — `recall_diary_write`, `recall_diary_read`, `recall_status`, `recall_memory_status`, `recall_plans`, `recall_plan_show`, `recall_tasks`, `recall_index`.

When the codeindex companion is installed, the agent *also* gets 16 code-level tools (`find_symbol`, `find_callers`, `get_imports`, `plan_change`, `get_change_impact`, `analyze`, etc.) from a separate MCP server. They compose: chat-recall finds what you've done; codeindex tells you what currently exists.

## Search architecture

Two backends, FTS5 is the default:

- **FTS5 (SQLite)** — zero external dependencies. Keyword search with BM25 ranking. Always available.
- **Vector (LanceDB)** — opt-in. 768-dim embeddings via Ollama (`nomic-embed-text`) or Gemini (`text-embedding-004`).

Both indexes are maintained in parallel when an embedder is configured. If neither is, every search tool transparently falls back to FTS5.

## Cost tracking

Cost in USD is computed from token usage when at least one model in the session has a known public price (currently Opus 4.6, Sonnet 4.5/4.6, Haiku 4.5). For models we don't have prices for (Gemini, Ollama, custom), the dashboard shows `—` instead of fabricating a number. The summary surfaces a `sessionsWithoutPricing` counter so you know how representative the totals are.

## Wake-up context

```bash
chat-recall memory wake-up
```

Builds a small bundle for an AI session: optional identity blurb, the top 10 chunks the classifier flagged as decisions/preferences/milestones at importance ≥ 4, and a snapshot of currently-valid knowledge-graph facts. No magic compression — just the highest-signal items the indexer already tags.

## Data locations

| Path | What |
|------|------|
| `~/.chat-recall/index/lancedb/` | Vector index (optional) |
| `~/.chat-recall/index/metadata.db` | SQLite metadata + FTS5 + content cache |
| `~/.chat-recall/index/knowledge_graph.db` | Temporal KG |
| `~/.chat-recall/index/wal/write_log.jsonl` | Write-ahead audit log (mode 0600, secrets redacted) |
| `~/.chat-recall/index/diary/<agent>/` | Per-agent diary entries |
| `~/.chat-recall/hooks/` | Installed save hook (after `install-hooks`) |

Wipe everything with `rm -rf ~/.chat-recall/index ~/.chat-recall/hooks` and a re-`index`.

## Privacy

By default everything stays on your machine. The only point at which session text leaves your laptop is summary generation **if you opt into the `claude` or `gemini` (API-based) summary provider** — and even then only the summary prompt + a snippet, not full transcripts. The default summary provider is `ollama` (local) or none (no summaries).

The web UI binds to localhost. There is no telemetry, no account, no upload. There is also currently no built-in sync — your index lives in `~/.chat-recall/index/`; back it up however you like.

## Architecture

```
src/
├── core/
│   ├── backends/        ToolBackend per AI tool (claude, gemini, opencode, codex)
│   ├── tool-backend.ts  Registry interface — single source of truth for tool identity
│   ├── tool-paths.ts    Env-overridable default paths for each tool
│   ├── generic-engine.ts  Shared turn extraction / edit scan / replay (canonical events)
│   └── …                Indexing, storage, embeddings, summaries, KG, classifier
├── parsers/             *-source.ts plugins per content type (sessions, plans, tasks, …)
├── cli.ts               CLI
└── mcp.ts               MCP server

web/
├── server/              Express API
└── client/              React + Vite UI

auto-indexer/            chokidar-based watcher daemon (systemd-friendly)
hooks/                   Claude Code save hook (install via `chat-recall install-hooks`)
docker/                  Dockerfiles + nginx
e2e/                     Playwright tests
```

Two extension points, both registry-driven:

- **Adding a new content type** (e.g. another file format to index) — implement `MemorySource` (`discover` → `parse` → `extractLinks`) and register it in the `SourceRegistry`.
- **Adding a new AI tool** (a fifth backend alongside Claude/Gemini/OpenCode/Codex) — implement `ToolBackend` (paths, ID handling, `readEvents`, `fileToolMap`, `extractEditDelta`) and register it in `src/core/backends/index.ts`. Walkthrough: [`docs/ADDING_A_TOOL.md`](docs/ADDING_A_TOOL.md). All paths are env-overridable via `CHAT_RECALL_{CLAUDE,GEMINI,CODEX}_HOME` / `CHAT_RECALL_OPENCODE_DB`.

## Requirements

- Node.js 18+
- Optional: Ollama (local, free) for vector search & local summaries
- Optional: Gemini or Anthropic API key for hosted embeddings/summaries
- Sessions in `~/.claude/`, `~/.gemini/`, or `~/.local/share/opencode/` (standard tool locations)

## License

MIT.
