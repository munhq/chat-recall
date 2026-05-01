# Security policy

Thanks for taking the time to look at chat-recall's security.

## Threat model — what chat-recall touches

- **Reads from**: `~/.claude/`, `~/.gemini/`, `~/.local/share/opencode/`, `~/.codex/` (everything your AI tools already write).
- **Writes to**: `~/.claude/chat-recall-index/`, `~/.claude/chat-recall/settings.json` (mode 0600), `~/.claude/chat-recall-memory/`, `~/.claude/plans/` (read-mostly), `~/.mcp.json` (when registering MCP servers).
- **Network**: only the embedder/summary providers you explicitly configure (Ollama, Gemini, OpenAI, NVIDIA NIM, Anthropic, OpenAI-compatible). The default install is fully local — SQLite FTS5 search with no outbound calls.
- **Secrets**: API keys live in `settings.json` (mode 0600) or environment variables. Keys are never logged and never returned in API responses; the web API masks them as `••••xxxx`.

## Reporting a vulnerability

Open a GitHub Security Advisory:
<https://github.com/darkkraft/chat-recall/security/advisories/new>

Or, if you can't use that, open a public issue clearly tagged `security:` and we'll move it private. Do **not** disclose exploit details in a public issue before the advisory is opened.

We aim to acknowledge within 72 hours and ship a patch within two weeks for confirmed high/critical issues.

## What's in scope

- Path traversal or injection in the indexer/parsers (chat transcripts are user-controlled input).
- Prompt-injection through indexed content reaching the MCP tool surface (`recall_search`, `recall_memory_search`, `recall_smart_resume`, etc.). The query sanitizer in `src/core/query-sanitizer.ts` is part of this defense — bypasses are interesting.
- Credential leaks from the web API (`/api/settings`, `/api/settings/test`).
- Anything that lets one MCP client read another user's data.
- Code execution paths via the Local CLI summary provider (`SUMMARY_CLI_CMD`) — the user opts into running a shell command, but escapes that the user didn't ask for are bugs.

## What's out of scope

- Attacks that require already-root or already-same-uid access to your machine. Chat-recall is a local-first tool; it doesn't enforce a security boundary against the user it runs as.
- Attacks against the upstream embedding/summary providers (Ollama, Gemini, OpenAI, etc.).
- Denial of service via huge transcripts. We chunk and rate-limit on a best-effort basis but the local CPU/disk is yours to manage.
