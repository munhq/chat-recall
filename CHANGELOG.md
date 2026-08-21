# Changelog

All notable changes are tracked here, newest first. Versioning follows [SemVer](https://semver.org).

## [Unreleased]

## [0.5.5] — 2026-08-21

### Fixed

- Prompts typed WHILE A TOOL WAS RUNNING were never indexed. Claude Code stores
  such a prompt as `{type:'queue-operation', operation:'enqueue'}` and never as a
  `user` record, and both readers only knew about `user`. Measured on one real
  session: 12 of 61 prompts, 20% — and not a random fifth, because a prompt typed
  mid-tool is an interruption or a correction. The calm approvals were kept and
  the course changes were dropped. Existing sessions re-ship on the next sync.
- A system reminder appended to a prompt discarded the WHOLE prompt. The block is
  now stripped and the words are kept.
- Every Codex session extracted ZERO user turns. Prompts were read only from
  `event_msg`/`user_message`, which current rollouts do not write; they write
  `response_item`/`message` with `role='user'`. Six real rollouts went from
  0 user turns each to 7, 3, 1, 4, 1 and 2. Codex sessions re-ship on next sync.
- Auto-filed task cards were closed and re-filed on every re-index. The finding
  id hashed the title, and titles carry counts ("copy-pasted 29×"), so one edit
  minted a new identity for the same problem. Observed in production: 10 cards
  filed and closed six minutes apart. Counts no longer feed the identity.
- Auto-filing never filed anything on the hosted service. The run read the
  findings table as the author `auto-tasks`, which owns no rows, so RLS returned
  an empty set and every run honestly reported "nothing qualified". Reads now run
  unrestricted; writes keep the author stamp.
- A tenant whose plan was recorded as a raw Stripe price id (a subscription made
  in the dashboard, or a plan change through the customer portal) was treated as
  unknown and dropped to the free tier's features and meters while paying.
- Vendored and generated files are no longer tasks. The exclusion existed and was
  applied to hotspots only, so minified bundles and generated bindings became
  "copy-pasted" cards. Build output, minified bundles and vendored trees now join
  the list.

### Added

- The auto-file severity floor is selectable: critical, high, medium or low, each
  showing how many findings it would file. It was a two-way switch that could not
  reach medium or low — 253 of 257 findings on a real tenant.
- The task board states what auto-filing did: what is waiting, per project, what
  the last run filed and closed, and a "Run now" button. Previously the switch
  set a policy and nothing visible ever happened.

## [0.5.4] — 2026-08-20

### Fixed

- A Team-only feature refused on a Solo or trial plan showed
  "Failed to load toolkit matrix:" — a colon and nothing at all, because HTTP/2
  carries no status text and the client built its message from `res.statusText`.
  The server already answered with the feature, the plan it needs and an upgrade
  link; the client discarded it. A plan boundary read as a broken product.
- The Toolkit upgrade notice rendered inside the live sync toolbar, leaving eight
  controls mounted and enabled that could only ever be refused — walked by the
  keyboard before the one working button, and pushing the notice 636px down the
  page on a phone. The caption above it still described clicking cells and a
  "Sync everything" button that was no longer there.
- Every per-seat pricing tier shared ONE seat counter, so choosing seats on Team
  silently changed Self-hosted team, and checkout could be sent a count below the
  clicked tier's own minimum. Switching between Monthly and Yearly also discarded
  the choice.
- The pricing page showed a unit price and no total. It now computes it live —
  "2 x $25" becomes "$50 / month" — and the yearly saving is derived per tier
  instead of a hardcoded "2 months free" that a price change would have made
  false.
- A self-host licence serial reached the buyer by email only, sent from a webhook
  that swallows its own failures. A bounced or misfiled message left a paying
  customer with nothing and no way to help themselves. The purchase now returns
  with the serial on screen, with the activation steps, and can re-send the email
  to the address on the subscription.
- Someone who had just paid for a self-host licence could be shown "Your
  subscription has ended": the entitlement that lifts the paywall is written by
  the same webhook that issues the serial, so during that window the paywall
  replaced the very screen they had returned for. A completed checkout now
  outranks the paywall. A 401 or a sign-in bounce also discarded the checkout id,
  which was the only route back to the serial.
- The subscription paywall centred itself in a fixed, non-scrolling box, so below
  about 900px of viewport height its heading was cut off above the top edge and
  its sign-out button sat past the bottom with no scrollbar — the one exit that
  screen provides was unreachable on a laptop.
- The conversation viewer presented a 500-message page as though it were the
  whole session: it printed "Showing 500 of 1148 messages", ended the transcript
  mid-session with no sign that 648 more followed, and derived tool counts and
  the session trace from that window without saying so.
- Paging a conversation advanced by the length of the client's array, which is
  shorter than the rows the server sent because command-noise rows are dropped
  after the fetch — so later pages repeated messages already on screen.
- A fresh Postgres database could not boot the server: `ALTER TABLE entitlements
  ADD COLUMN seats` ran about 110 lines above the `CREATE TABLE` that makes the
  table. Existing databases were unaffected, which is why only new self-host
  installs and the compose-integration job failed.

## [0.5.3] — 2026-08-20

### Fixed

- A signed-in user with no workspace was refused every API call with "no team
  yet", so the dashboard loaded empty and the client turned that message into the
  subscribe screen — which created the workspace as a side effect. The workspace
  is now provisioned on first request.
- Seats were validated when a subscription was bought and never again, and the
  count was not stored, so a cloud team could invite past what it paid for. The
  quantity is persisted and the invite path enforces it.
- The trial countdown rounded up: 13.05 days remaining displayed as "14 days
  left", so the banner looked identical on day one and day two.
- The account page offered three priced plans with seat spinners directly under
  the trial countdown. The picker now waits to be asked and opens itself when the
  trial is nearly over. The panel shows the trial's end date.


## [0.5.2] — 2026-08-20

### Changed

- The client build no longer generates marketing pages. It produced them
  unconditionally, so a self-hosted server served a hosted service's pricing and
  a sitemap pointing at a domain that was not its own. A self-host build now
  produces the dashboard alone.
- `.env.example` matches `docker-compose.yml`. It omitted `POSTGRES_PASSWORD` —
  the one variable compose refuses to start without — while declaring six it
  never reads and a `DATABASE_URL` with the wrong user and host.
- CI runs on pull requests and pushes to main. It described itself as the pull
  request gate while triggering on `workflow_dispatch` alone, so it ran on
  neither.
- The dashboard has mobile coverage again: five views at six phone widths, each
  asserting no horizontal overflow and naming the element responsible.
- The server package description and a comment in `mode.ts` still said BSL after
  the move to Elastic License 2.0.

## [0.5.0] — 2026-08-18

### Self-hosted team features now require a licence key

Solo self-hosting stays free and unlimited, forever — indexing, sync, search, the
MCP server, the knowledge graph, secret scanning and diaries are all included.

Collaboration is licensed: inviting a second member, shared project history, the
team task board and per-member activity need a licence key on a self-hosted
server. Email contact@chatrecall.dev. Licences are offline Ed25519-signed keys with an
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
