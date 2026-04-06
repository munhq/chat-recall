# Chat-Recall

> "I fixed an auth bug with Claude last week... which session was that?"

Chat-Recall indexes all your Claude Code conversations and makes them searchable. It also tracks how much each session costs, what files were changed, and what decisions were made — so you (and Claude) can pick up where you left off without wasting context.

## What You Get

**Find any past conversation instantly.** Search by what you discussed, not when it happened. "OAuth implementation", "React hooks refactor", "that Postgres migration bug" — semantic search finds the right session even if your exact words don't match.

**See what each session cost.** Every session shows token usage, estimated cost in USD, cache savings, peak context window usage, and which models were used. Know exactly where your API budget is going.

**Give Claude memory across sessions.** The MCP server lets Claude automatically recall relevant past work. When you say "continue the auth work", Claude can find the right session, see what was done, what files changed, and what's still pending — without you having to explain.

**Browse everything in a web UI.** Sessions grouped by project, full conversation viewer, metadata panels, related items (tasks, plans, CLAUDE.md), and a unified memory explorer.

## Quick Start

### Docker (recommended)

```bash
git clone <repo-url>
cd chat-recall
cp .env.example .env
docker compose up -d
```

Open http://localhost:8080 — that's it. On first start it pulls the embedding model (~270MB) and begins indexing your sessions automatically.

### Local Install

```bash
# Prerequisites: Node.js 18+, Ollama running locally
ollama pull nomic-embed-text

npm install
npm run web:install    # Install web dependencies
npm run build          # Compile TypeScript
node dist/cli.js index # Build the search index
npm run web:dev        # Start web UI (API on :5000, UI on :5173)
```

### Add to Claude Code (MCP)

Add to `~/.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "chat-recall": {
      "command": "/path/to/chat-recall/node_modules/.bin/tsx",
      "args": ["dist/mcp.js"],
      "env": {
        "EMBEDDING_PROVIDER": "ollama"
      }
    }
  }
}
```

Now Claude can use tools like `recall_search`, `recall_context`, and `recall_suggest_resume` to find and resume past work.

## What Gets Indexed

Everything lives under `~/.claude/` — no hardcoded paths, works on any machine.

| Source | What | Why It Matters |
|--------|------|----------------|
| **Sessions** | Conversation transcripts | The core data — every message, tool call, and decision |
| **Plans** | Agent planning documents | Architecture decisions and implementation strategies |
| **Tasks** | Task lists from sessions | What was planned vs. what got done |
| **CLAUDE.md** | Project instructions | Links sessions to their project context |
| **History** | Command history | What commands were run and in which sessions |
| **Paste** | Paste cache | Large text blocks shared with Claude |

## Session Metadata

Each session is enriched with metadata extracted from the JSONL transcript:

- **Token usage** — input, output, cache reads, cache creation, peak context window
- **Estimated cost** — computed from model pricing (supports opus, sonnet, haiku)
- **Cache savings** — how much the prompt cache saved you
- **Duration** — total session time from turn_duration entries
- **Tools used** — Bash, Read, Edit, Write, Agent, etc.
- **Files modified** — from file-history-snapshot entries
- **Git branch** — what branch you were on
- **Models used** — which models handled each turn
- **Slug** — Claude's auto-generated session name

## CLI

```bash
# Search
node dist/cli.js search "OAuth implementation"
node dist/cli.js search "React hooks" --top 10 --project myproject

# Browse
node dist/cli.js recent
node dist/cli.js show <session-id>
node dist/cli.js context <session-id>    # Structured context for resuming
node dist/cli.js summary <session-id>    # AI-generated summary

# Memory system
node dist/cli.js memory search "API error handling"
node dist/cli.js memory status
node dist/cli.js plans
node dist/cli.js tasks

# Indexing
node dist/cli.js index                   # Incremental
node dist/cli.js index --force           # Full re-index
node dist/cli.js status
```

## MCP Tools

| Tool | What It Does |
|------|-------------|
| `recall_search` | Semantic search across all sessions |
| `recall_recent` | List recent sessions, optionally by project |
| `recall_context` | Session context with token budget (so Claude knows if it's safe to load) |
| `recall_summary` | AI-generated summary |
| `recall_show` | Full session content |
| `recall_suggest_resume` | Find relevant past sessions for the current task |
| `recall_memory_search` | Search across all memory types |
| `recall_memory_status` | Memory system stats |
| `recall_plans` | Browse plans |
| `recall_tasks` | Browse tasks |
| `recall_index` | Trigger re-indexing |
| `recall_status` | Index statistics |

## Configuration

### Embedding Providers

| Provider | Model | Setup |
|----------|-------|-------|
| `ollama` (default) | nomic-embed-text | Local, free, no API key |
| `gemini` | text-embedding-004 | Requires `GEMINI_API_KEY` |

### Summary Providers

| Provider | Model | Setup |
|----------|-------|-------|
| `ollama` (default) | qwen2.5:7b (configurable) | Local, free |
| `claude` | claude-3-5-haiku | Requires `ANTHROPIC_API_KEY` |
| `gemini-cli` | gemini-3-flash-preview | Requires `gemini` CLI |

### Environment Variables

See [`.env.example`](.env.example) for full docs. Key settings:

```bash
EMBEDDING_PROVIDER=ollama
SUMMARY_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_SUMMARY_MODEL=qwen2.5:7b
```

## Docker

```bash
docker compose up -d                                  # Default setup
docker compose --profile gpu up -d                    # With GPU for Ollama
docker compose up -d --scale ollama=0 --scale ollama-init=0  # Use host Ollama
```

| Service | Port | Description |
|---------|------|-------------|
| `client` | 8080 | Web UI (nginx) |
| `server` | 5000 | API server |
| `ollama` | 11434 | Embedding model |
| `indexer` | — | Auto-indexer daemon |

## Architecture

Plugin-based memory system. Each data source implements `MemorySource` (discover/parse/extractLinks) and registers with `SourceRegistry`. Adding a new source requires one file + one `.register()` call.

**Storage:** LanceDB for vector search, SQLite for metadata and relationship links.

```
src/
├── core/           # Indexing, storage, embeddings, summaries
├── parsers/        # One *-source.ts plugin per data type
├── cli.ts          # CLI
└── mcp.ts          # MCP server (12 tools)

web/
├── server/         # Express API
└── client/         # React + Vite UI

auto-indexer/       # File watcher daemon
docker/             # Dockerfiles + nginx
e2e/                # Playwright tests (21 tests)
```

## Requirements

- Node.js 18+
- Ollama (local, free) or API keys for Gemini/Claude
- ~270MB for the embedding model
- Claude Code sessions in `~/.claude/` (standard location)
