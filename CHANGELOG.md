# Changelog

All notable changes are tracked here, newest first. Versioning follows [SemVer](https://semver.org).

## [Unreleased]

### Two ranked views over the findings you already had

`recall_claude_suggestions` and `recall_improvements` answer the two questions the
recommendation engines could already answer, but only one scope at a time.

- `recall_claude_suggestions` — every finding that becomes an agent-instruction
  change: the CLAUDE.md rules and skill installs, merged across account scope and
  every code-indexed project, most severe first, each with the exact text to add.
- `recall_improvements` — everything else, ranked most urgent first across code
  actions and recommendations at once. Pass `create_tasks: true` to open one task
  per item on the shared team board; it is off by default, so the tool reads
  unless you ask it to write.

Neither computes a recommendation. Both call the endpoints `recall_recommendations`
and `recall_code_actions` already use, then merge — so a new recommendation kind
added to the engine surfaces in them without a second copy of the ranking. They
partition on kind, so an item is in one list or the other and never both.

Unlike the `recall_code_*` family, both register without the codeindex binary:
they read findings the server already holds, and degrade to account scope when no
repo is indexed.

### Fixed

- The three Stripe return URLs fell back to a hostname the product moved off,
  which now answers 404. They derive from `PUBLIC_URL` (else the validated
  forwarded headers) when `STRIPE_*_URL` are unset, so they follow the domain
  instead of outliving it. Self-hosters who bought a licence were redirected to a
  dead host after checkout; the hosted service was unaffected, because its Helm
  chart sets all three explicitly.
- `plugin/.claude-plugin/plugin.json` advertised `MIT` after the repository was
  relicensed to Elastic License 2.0, and named the pre-rename `hotmun` org in the
  author field and the marketplace install command.
- Edited skills reached nobody. The MCP server refreshes the bundled skills into
  every local AI tool on start, but the gate compared the PACKAGE VERSION — so a
  skill edited between releases left the bundled content changed, `version()`
  unchanged, the installed marker matching, and the new text undelivered.
  Measured here: markers and bundle both read `0.5.0` while the catalog had
  changed. The gate now keys on a content hash of every bundled skill file, so
  any edit ships on the next MCP start. Markers written by an older release hold
  a bare version, which cannot match the new `<version> <hash>` stamp, so every
  existing install self-heals once.
- `plugin/skills/` is a second copy of the six shipped skills and nothing kept it
  in step with `packages/cli/skills/`, so the marketplace copy could drift from
  the installed one. They are now asserted byte-identical in CI.
- Documented Node floor was 18; the enforced floor has been 22 since `539a62a`,
  and the image and CI run 24.

## [0.5.0] — 2026-08-18

### Self-hosted team features now require a licence key

Solo self-hosting stays free and unlimited, forever — indexing, sync, search, the
MCP server, the knowledge graph, secret scanning and diaries are all included.

Collaboration is licensed: inviting a second member, shared project history, the
team task board and per-member activity need a licence key on a self-hosted
server. Email hello@munhq.com. Licences are offline Ed25519-signed keys with an
optional seat count — no licence server, so air-gapped installs work and an
outage at our end can never disable a running install.

Existing self-hosted deployments are unaffected until they upgrade. The licence
itself has not changed and remains Elastic License 2.0.

### CLI

- `chat-recall init` now connects to https://chatrecall.dev when no `--server` is
  given. Previously it printed "Not logged in. Pass --server" and connected
  nowhere, so the documented one-command install did not install anything.
  Sign-in is an OAuth device flow you must approve in a browser; nothing is read,
  indexed or uploaded before that, and declining no longer aborts the rest of
  init. `--server` still overrides, and self-hosting is signposted inline.
- `search` and `memory search` report a relative match tier — strong / good /
  weak — instead of a percentage. The old display printed `Score: 2/100` for the
  single best hit in a set, because FTS ranks and vector distances normalise into
  ranges orders of magnitude apart. The fix already existed in
  `core/score-tier.ts` and had never been wired up.

### Fixed

- Password reset was broken for every user on the hosted service. `sendResetPassword`
  appended `callbackURL` to a URL better-auth had already put one on, so every
  emailed link carried two, and the endpoint rejected the pair as an array. Reset
  links rendered raw JSON instead of a password form.

## [0.2.0] — 2026-04-27 (launch)

### MCP tools — 27 → 35

New tools, grouped:

**Pattern detection (the launch headline):**
- `recall_similar_sessions` — vector cluster of past sessions matching a query or another session, grouped by project. *"You've worked on auth in 5 projects across 8 sessions."*
- `recall_session_files` — files a session created/edited/read, grouped by extension.
- `recall_redundant_files` — filename-level redundancy alert before you create something that may already exist.
- `recall_files_touched` — already shipped earlier; promoted in the README as part of the pattern set.

**Persistent state:**
- `recall_set` / `recall_get` / `recall_kv_list` — small key/value store the agent can stash arbitrary state in (current PR url, branch, prefs). Scoped namespaces avoid collisions.

**Snapshots & wake-up:**
- `recall_analytics_summary` — same data the dashboard renders (totals, weekly delta, top projects/tools/models, sessions without pricing).
- `recall_wake_up` — high-importance classifier hits + KG snapshot in one call. Replaces a manual context dump at session start.

### Hooks
- `chat-recall install-hooks` now registers a third event: **UserPromptSubmit**. Fires on every prompt you type, runs a quick search for similar past work, and injects a "you've worked on this before" notice into the agent's context. `--no-resume-hint` to skip.
- All three hook events (`Stop`, `PreCompact`, `UserPromptSubmit`) install/uninstall idempotently and never clobber third-party entries.

### Settings page
- Old single-key `.env` editor replaced with a structured Settings dialog (`~/.claude/chat-recall/settings.json`, mode 0600).
- Two cards: **Search & embeddings** (Ollama / Gemini / OpenAI / Nvidia / OpenAI-compatible / none) and **Session summaries** (gemini-cli / claude / ollama / custom CLI / none).
- API keys are masked on the wire (`••••xxxx`); leaving the masked value untouched preserves the stored key.
- "Test connection" button per provider — probes the live endpoint without saving.
- New **Code intelligence (codeindex)** card — see below.

### Codeindex companion (auto-detected)
- `chat-recall init` detects an already-installed `codeindex` binary on PATH (or `~/.local/bin/codeindex`) and registers it as an MCP server in `~/.mcp.json` automatically.
- New CLI: `chat-recall companions {status, install, uninstall}`.
- `--with-codeindex` forces a fresh download from the GitHub release; `--skip-codeindex` opts out of detection entirely.
- Settings page has a Code intelligence card showing status, capability preview (16 codeindex tools), and Install/Uninstall buttons.

### Insights / Patterns panel (web UI)
- New **Patterns** section on the Insights tab:
  - **Repeated work** cards — clusters of similar sessions grouped by topic (auth, oauth, database, …).
  - **Hot files** leaderboard — files touched across the most sessions, with project count and recency.
  - **Redundancy alerts** — pairs of sessions in the same project with significant file overlap, flagged as likely duplicate work.

### Subagent surfacing
- `recall_subagent_search` shipped earlier; UI now renders a subagent accordion under the conversation viewer for sessions that have hidden Explore / aside / `acompact-*` subagents on disk.

### Knowledge graph
- `recall_decision_record` writes a KG triple AND a diary entry in one call. Use it instead of `recall_kg_add` when the decision has narrative context.

### Health & debugging
- `chat-recall doctor` — single-command health check across index, embedder, hooks, MCP registration, codeindex, auto-indexer.

### Analytics fixes
- Cost calculation no longer fabricates Sonnet-priced numbers for Gemini / Ollama / custom models. Returns `null` when no model in the session has known pricing; the dashboard subtitle reads "N sessions w/o pricing" instead of pretending.

### Parser fixes
- Banner stripping (`MCP issues detected. Run /mcp list for status.`) is now applied at every read boundary — list cards, search results, viewer titles, individual messages — not just at indexing time. Older cached summaries no longer leak the banner.
- Subagent transcripts (`<session-dir>/<id>/subagents/*.jsonl`) are surfaced in the conversation viewer; orphaned `agent-acompact-*` files (compacted prior history) are now visible.
- Tool-result-only user messages no longer drop empty into the viewer; results are attached to their tool_use call.

### Removed
- Dead AAAK code (`src/core/aaak.ts`, ~603 LOC) — the format produced unhelpful output ("PROJ: IS(project) | ALREADY(project) …"). The `memory wake-up` CLI now uses the real classifier hits + KG snapshot instead.

### Internal
- 42 Playwright E2E tests pass (was 36).
- Build pipeline includes `scripts/postbuild.mjs` to chmod bin entries.
- `.npmignore` excludes web/, e2e/, scripts/, .git, .env, screenshots.
- Versioned content cache (`PARSER_VERSION = 4`) so stale parses from older buggy versions are ignored on read.

## [0.1.0] — 2026-03

Initial release. 27 MCP tools, FTS5 + LanceDB search, Claude Code / Gemini CLI / OpenCode session indexing, web UI with conversations + memory + dashboard tabs, temporal knowledge graph, write-ahead log + query sanitizer.
