# Changelog

All notable changes are tracked here, newest first. Versioning follows [SemVer](https://semver.org).

## [0.7.46] — 2026-11-13

### Fixed
- **The sync walk paused before its first session, so the daemon used up to a full core and shipped nothing through the walk.** Measured on 2026-11-13 on 0.7.44: the idle daemon held 535 to 580 MB, the bound was 512 MB, and the check ran before the first session of each walk. The journal repeated `walk paused at the memory bound (used=584MB) after 1 of 15 session(s)` every 13 seconds, and the process used 73 to 98 percent of a core on the listing, the garbage collection and the cgroup reclaim of each tick. A pass now measures the memory that it adds above its starting size (`CHAT_RECALL_WATCH_GROWTH_MAX_MB`, default 256) and stops at the absolute bound (`CHAT_RECALL_WATCH_RSS_MAX_MB`, default 896, below the unit's `MemoryHigh=1G`). Each pass builds at least one session or workspace before it can pause. The code-intelligence pass uses the same budget.
- The collector returns the page cache of its cgroup every 30 s when the file pages pass 128 MB. Report 14:57:24 showed a 50 MB heap and 537 MB of rss while `memory.current` held 1.66 GB of file pages. `shouldReclaim` in `packages/cli/src/memory-guard.ts` makes the decision, and the resident tick in `packages/cli/auto-indexer/indexer.ts` runs it.
- The scan worker holds 256 MB of heap, not 768 MB. The watch unit reached 1.6 GiB of peak (`maxRss`) while the main isolate held 50 MB. A task that needs more dies on its limit, and the pool falls back to the inline path.

## [0.7.45] — 2026-11-13

### Fixed
- **One OpenCode session build held 1.5 GiB of anonymous memory for 20 s.** Measured on 2026-11-13 at 12:11: the build of one OpenCode session (a dump of its rows from a 1.09 GB SQLite file) raised anon from 473 MB to 1533 MB and back to 497 MB RSS, while the rest of the walk stayed under 512 MB. `exportRawSession` now stays inside `DEFAULT_DUMP_MAX_BYTES` (64 MiB): rows past the budget are skipped and one `truncated` line says how many, so the dump is short in a way a reader can see. `CHAT_RECALL_OPENCODE_DUMP_MAX_BYTES` overrides the budget.

## [0.7.44] — 2026-11-13

### Fixed
- **The sync walk had no memory bound, and one sync took the unit to 1.5 GiB.** Measured on 2026-11-13: a file-change sync took the cgroup from 578 MB to 1524 MB of anon in six seconds, and the cgroup peak reached 1.65 GiB. The walk now reads `usedMb()` before each session and stops at `CHAT_RECALL_WATCH_RSS_MAX_MB` (default 512) instead of letting the unit be killed; the ledger holds what shipped and the next tick continues with the unacked sessions first. The walk also calls `releaseMemory()` after each session it builds.

## [0.7.43] — 2026-11-13

### Fixed
- **The bound saw only the daemon's own pages, and the pass ran on while the unit held 1.4 GiB.** `process.memoryUsage().rss` excludes the `codeindex` child and the file pages of the workspaces the pass reads, so the pass kept starting workspaces while `memory.current` of the cgroup was 1.4 GiB. `usedMb()` now returns the larger of the daemon's rss and the cgroup's `memory.current`, and the pass pauses on that number. The pass also takes back the file pages of each finished workspace, so the peak of a pass is one workspace above the floor.

## [0.7.42] — 2026-11-13

### Fixed
- **The page cache of a pass counted in the cgroup peak, and the daemon now gives it back.** The anon bound of 0.7.41 held (the sampler never passed 520 MB of anon), and the peak still reached 1.4 GiB during the code-intelligence pass: `memory.stat` showed 775 MB of file pages, 197 MB of kernel memory and 189 MB of slab, while the `codeindex` child held 81–140 MB. The page cache is reclaimable, but the kernel counts it in `memory.current` and in the peak. `reclaimCgroup()` writes to the `memory.reclaim` file of the unit's own cgroup when a tick and a pass end, which needs no privilege, and it keeps a floor of 64 MiB of file pages. On this machine the write took the file pages from 775 MB to 361 MB.

## [0.7.41] — 2026-11-13

### Fixed
- **The daemon returns its pages when a tick ends and when the code pass pauses at the bound.** 0.7.40 bounded the pass, and the unit then stayed at 511 MB of resident anon memory after the pass paused, because V8 keeps committed pages it cannot use. `shipToServer()` now calls `releaseMemory()` in its `finally`, and the pass calls it before it pauses at the bound.

## [0.7.40] — 2026-11-13

### Fixed
- **The memory of the collector has a bound, and the pass stops at it.** The 0.7.39 cap bounded the V8 heap and the cgroup peak still reached 1.5 GiB in six minutes on a corpus of 12,219 sessions. A heap snapshot at 415 MB of resident memory held 55 MB of live objects, so no object held the memory: the pages came from churn. The code-intelligence pass now stops at `CHAT_RECALL_WATCH_RSS_MAX_MB` (512 MiB by default) and the next tick continues with the workspaces that wait, because the cursor records completions only. The daemon returns the pages of each finished workspace, and the unit starts it with `--expose-gc` for that.
- **One full listing of the sessions cost about 100 MB, and the daemon made two or three of them on every sync tick.** Three listings of 12,219 refs took the resident size from 65 MB to 294 MB, and two garbage collections left 247 MB. The field reconcile now reuses the listing the walk already made.

## [0.7.39] — 2026-11-12

### Fixed
- **The collector still peaked at 1.6 GiB, and the heap cap could not stop it.** Measured with the service's own cap: a 124 MB transcript reached 263 MB after the read, 511 MB after `buildRawContainer` and 555 MB after the gzip, while `heapUsed` never passed 25 MB — the container's strings and the buffers sit outside the V8 heap. The size ceiling is now decided on the export, before the container exists: an export above `FULL_BUILD_MAX_BYTES` (24 MB by default) takes no container copy and no shadow merge, is parsed in place, and is counted once as `oversized_session`. A backend whose `fileSize()` reports 0, such as OpenCode, reaches that ceiling check.
- **The OpenCode export copied one session four times.** `exportRawSession` read every part row into one array, joined them into one string and made a byte copy of that string: four full copies of a session, and the string half cannot fit a bounded heap. It now encodes one row at a time and concatenates the buffers once, so two copies remain and no session-sized string is built. The dump is byte-identical, and a test asserts one row per line with the session first.
- **The daemon heap bound now comes from measurement.** `WATCH_HEAP_MB = 640` in `packages/cli/src/service-installer.ts` sets `--max-old-space-size` for the systemd unit, the launchd plist and the Windows task. It replaces 1536, which let V8 grow to 1.6 GiB of churn around a live heap of 10–65 MB and sat above the `MemoryHigh=1G` of the unit. `service-installer.test.ts` asserts that every platform starts the daemon with the same bound.

## [0.7.38] — 2026-11-12

### Fixed
- **One append of a large session could reach the memory limit of an API pod, and the pod was killed.** The sync route held the whole body, the gunzip buffer, the parsed messages, the re-gzip and the JSON envelope at the same time: an append of a 32 MB archive needed about 280 MiB of transient memory on top of a ~220 MiB baseline. A body guard now mounts before the 32 MB parser. It answers 413 when the declared body is above 8 MiB, and 429 with `Retry-After` while the in-flight budget of two appends per pod is full. `CHAT_RECALL_INGEST_MAX_BODY_BYTES` and `CHAT_RECALL_INGEST_MAX_INFLIGHT` set both bounds. A slot is released once, on the first of `finish` or `close`, so a dropped connection cannot leak it.
- **A throttle no longer silences the collector.** A `429` or a `413` from a server does not count for the circuit breaker of that target, so a healthy collector retries as soon as the server recovers instead of waiting out a cooldown of up to 15 minutes. The walk still reports the failure to the caller.
- **The collector walked every session again at every start.** It held about 340 MiB before any work, and one walk of 12,224 sessions churned several hundred MiB of buffers that V8 did not return: the systemd unit peaked at 1.6 GiB against its 2 GiB cap and the OOM killer stopped it 15 times in one day. One walk now carries at most 2000 sessions (`CHAT_RECALL_SYNC_WALK_MAX`), and the sessions the ledger has not acknowledged come first, so a large corpus moves forward in bounded steps. A restart walks only the recent window while the last successful walk is younger than six hours; the stamp is kept per target in `walk-state.json` in the data folder.

## [0.7.37] — 2026-11-10

### Fixed
- **On macOS the channel record keeps the start time of the process and finds the grandparent.** Both came only from Linux's `/proc`. The record that tells the MCP server which session it belongs to now carries the start time that `ps` reports, so a reused pid cannot name another session. Windows has no equivalent and keeps the record without a start time.
- **The tool list tells a client every argument a tool accepts.** The input schema of each tool was written by hand beside the zod schema that parses the call, and the two had drifted: `recall_message_send` did not list `interrupt`, `kind` or `topic`, and `recall_context`, `recall_user_prompts`, `recall_decision_record` and `recall_decisions` accepted arguments that no client could see (`include_turns`, `turns_limit`, `with_markers`, `scope`, `workspace`). The schema of 66 tools is now made from the zod schema (`inputSchemaOf`), so there is one source. Four parameters that had a description only in the hand-written schema got it in zod.
- Arguments that no handler read are no longer listed: `provider` on `recall_index`, `recall_memory_search` and `recall_search`, `skip_ranking` on `recall_search`, and `scope` on `recall_recent`, `recall_memory_search` and `recall_search`. A call that still passes them works as before.

## [0.7.36] — 2026-11-10

0.7.32 to 0.7.35 were tagged and never published to npm: their install step needed a token for private packages. This release carries their changes.

### Changed
- **The package holds no code of a private kit.** 0.7.32 bundled `@munhq/mcp-kit` into the CLI. The kit is now loaded at run time when the machine has it installed, and the build fails when kit code reaches a bundle (`assertNoKitCode`, `packages/cli/scripts/kit-guard.mjs`).
- **A machine without the kit logs in and works.** `chat-recall login` runs the device flow of the repository and keeps the token in a file that only you can read. `chat-recall init` registers the relay in the AI tools. Install `@munhq/mcp-kit` beside the CLI to get the keyring and sealkeep storage and the kit's registration for each tool. `CHAT_RECALL_NO_KIT=1` behaves as a machine without the kit.
- The engine opens its Postgres pool with `pg`, with no kit.
- GitHub CI and the release install and build the CLI and engine only (`npm run build:public`), with no token. The server tests run in the job `server-tests`, which needs the repository secret `PACKAGES_READ_TOKEN`.

## [0.7.35] — 2026-11-10

### Added
- **A message says what it is.** `recall_message_send` takes `kind` (`ask`, `blocked`, `report`, `handoff` or `fyi`) and `topic` (the task or issue, such as `owner/repo#42`). A reply joins the thread of the message it answers, keeps its topic, and closes an open `ask` or `blocked`. `recall_session_status` shows "waiting for an answer from …" and "owes an answer to …" for each session, and the message lines of one session show kind, topic, answer state and thread.
- **Sessions report their project.** The message hook sends the repository of the session's folder (`owner/repo`, from `.desk/config.json` or the `origin` remote). A session that starts with no name gets `<repository>-<start of its id>`.
- **A message names where its sender works.** The delivery shows the tool, project and folder of the sender, and says when the sender works in another project. A send by name or by the start of an id to a session of another project is refused; the full session id or the folder reaches it.

### Changed
- `recall_session_status` lists the sessions in one block for each project, and leaves out a session whose terminal closed more than two hours ago. `include_ended` shows it.

## [0.7.34] — 2026-11-08

### Fixed
- `chat-recall init` leaves Claude Code out of its own writer when the kit registered `chat-recall-mcp` at user scope. Before this, `~/.mcp.json` held a second entry and `claude mcp list` warned that the server is defined in two scopes.

## [0.7.33] — 2026-11-08

### Changed
- **The device token goes to the OS keyring, else to a file only you can read.** The message hook runs at every turn and the daemon at every start, and `sealkeep run` takes about a second, so sealkeep is an opt-in: `CHAT_RECALL_SECRET_STORE=sealkeep`. A token that 0.7.32 put in sealkeep keeps working.

### Fixed
- **`chat-recall login` on a machine that is already connected finishes the setup.** It moves a token from `credentials.json` to the store once, and registers `chat-recall-mcp` in the installed AI tools.

## [0.7.32] — 2026-11-08

### Added
- **One command connects every AI tool.** `chat-recall login` signs you in with the device login of `@munhq/mcp-kit`, keeps the device token, and registers `chat-recall-mcp` in each installed AI tool (Claude Code, Codex, OpenCode, Pi, Hermes, Gemini CLI, Cursor) with the `addMcpServer` function of the kit. `chat-recall init` registers it the same way, and keeps its own writer for Antigravity and for the `alwaysAllow` list. `login --skip-mcp` leaves the AI tools alone.
- **The device token has a safe place.** The kit keeps it in sealkeep when sealkeep is installed, else in the OS keyring, else in `~/.chat-recall/tokens/` (mode 0600). `credentials.json` holds the server and a pointer, and no token. A process that needs a token in sealkeep starts itself again once under `sealkeep run`: the CLI, the MCP server, the watch daemon and the message hook. If sealkeep does not give the token, the process runs with no token and names the reason.
- `CHAT_RECALL_SECRET_STORE=file` keeps the token in the file only. `CHAT_RECALL_MCP_REGISTRATION=own` stops the login and `init` from running the programs of the AI tools.

### Changed
- The kit is bundled into the CLI at build time. The npm package has no new dependency.
- The server image builds from the private `@munhq` packages as normal dependencies. The landing builds and publishes `ghcr.io/munhq/chat-recall`, and `docker-compose.yml` has no `build:` section. The server stops at boot when `@munhq/mcp-kit` is missing, so the redirect guard and the refresh guard are always on.
- The relay sets the heap limit of the daemon itself, because the kit writes the entry with no environment.

### Removed
- `packages/server/src/auth/mcp-redirects.ts` and the ambient types of `@munhq/mcp-kit`.

## [0.7.31] — 2026-11-03

### Removed
- **The save hook.** `Stop` and `PreCompact` no longer run `chat_recall_save_hook.sh`, and its script is no longer installed. The hook scanned every transcript before its 30-second throttle, so each Stop took 29 to 48 seconds on a machine with 15,183 transcripts. Its redirect also left an empty file whenever `jq` failed, so the saved facts were lost (#7, #8).
- `getMemoryDir()`, the helper that only the save hook read, and the migration of the legacy `~/.claude/chat-recall-memory` folder.

### Fixed
- `chat-recall install-hooks` and the MCP server start remove the entries of the save hook from `settings.json` and `hooks.json` in every profile. Every other hook stays.
- Every command hook that `install-hooks` registers in `settings.json` has a `timeout` of 60 seconds, the Claude Code default for a command hook, so the bound is written into the file.
- The test suite sets `XDG_CONFIG_HOME` to a temporary folder in each test process, so a test run no longer writes the OpenCode config of the developer.

## [0.7.30] — 2026-11-03

### Fixed
- **The OpenCode TUI plugin loads.** `chat-recall install-hooks` adds the plugin entry to the `plugin` list of OpenCode's `tui.jsonc` (or `tui.json` when only that file exists). OpenCode loads a TUI plugin only from that list, so a new TUI did not register its folder before this release. The file is edited in place: its comments and other entries stay, and an entry that is already listed is not added twice.
- `--no-messages` and `--uninstall` remove only our entry. The plugin files stay until `--uninstall`.
- `chat-recall doctor` reports whether the entry is listed.

## [0.7.29] — 2026-11-03

### Added
- **A message can go to a folder.** `recall_message_send` takes the folder of a session as its recipient. `expect_cwd` refuses the send when the recipient is in another folder. An OpenCode TUI with no session yet gets the message as its first prompt. The send result names the folder and the process kind of each recipient.
- **A channel delivers messages into an idle Claude Code session.** A session that starts with `--dangerously-load-development-channels server:chat-recall` takes its messages from the channel, and no waiter can time out. Other sessions keep the waiter. Setting `CHAT_RECALL_CHANNEL=1` or `=0` overrides the flag.
- **A message can interrupt the turn of its recipient.** `recall_message_send` takes `interrupt: true`. The OpenCode plugin stops the turn in progress, then sends the message as a prompt. Other runtimes receive it at their next opportunity.

### Fixed
- **A message reaches a session that has been idle for more than ten minutes.** Claude Code ends an `asyncRewake` hook at its timeout, which is 600 seconds by default, and nothing starts another waiter while the session idles. The waiter now runs for one day. The MCP server replaces an older waiter when it starts, also when the installed version has not changed.
- **An OpenCode watcher survives a turn and restarts when it exits.** The plugin keeps the watcher of a session for the life of the session, and restarts a watcher that exits, with a backoff. A plugin reload starts the watchers of the sessions that are already open.
- **A watcher runs in the folder of its session.** One `opencode serve` serves several folders, so the folder of the plugin instance is not the folder of the session.

## [0.7.28] — 2026-11-02

Not published to npm. Its changes are in 0.7.29.

### Fixed
- **A message reaches an idle OpenCode session after its watcher died.** The plugin started one long-poll per session and stopped it at every prompt. A watcher that exited for any other reason left the session without one until its next turn. The watcher now starts with the prompt hook, and a turn does not stop it. The hook runs with `--supervised` and reports why it stopped: 75 when the session ended, 76 when another watcher holds the session, 77 when the session cannot be watched.
- **pi:** the same restart rule, and the watcher is no longer stopped for a prompt.

### Added
- **`recall_message_send` takes `interrupt: true`.** An urgent message stops what the recipient is doing before it reads the message. The flag travels in the body, so a server that has not been upgraded still delivers it. The OpenCode plugin calls `session.interrupt`, then starts the turn. Claude Code, Codex, Antigravity, Cursor and pi deliver the message at their next opportunity.

## [0.7.27] — 2026-11-01

Not published to npm. Its changes are in 0.7.29.

### Added
- **A Claude Code session can take its messages from a channel, with no waiter to time out.** A channel is an MCP server that declares `capabilities.experimental["claude/channel"]`. It sends `notifications/claude/channel`, and the client takes a turn with the text, as if the user had typed it. The server long-polls the same `/wait` endpoint with the same lease, and acknowledges a batch only after the client took it.
- **Opt-in by the command line.** A session started with `--channels server:chat-recall` or `--dangerously-load-development-channels server:chat-recall` uses the channel. A session started without the flag keeps the waiter. A channel session runs its MCP server in its own process, not in the shared daemon, because only that process can see the flag and its parent.
- **The waiter stands down while a channel delivers.** The channel writes a marker for its session every 30 seconds. A waiter that finds the marker missing or stale takes delivery back.

## [0.7.26] — 2026-11-01

### Fixed
- **A message reaches a session that has been idle for more than ten minutes.** Claude Code ends an `asyncRewake` hook at its timeout, which is 600 seconds by default. Nothing starts another waiter while the session idles, so a message waited until the user typed. The waiter entry now sets a one-day timeout. The waiter still ends with the session, because it watches the session's own process, and with the first message, which is the exit that wakes the session.
- **A profile that already has the waiter is repaired when the MCP server starts.** The repair tests the timeout of the waiter entry, not only the installed version, so a profile written by 0.7.25 gets the new waiter.

## [0.7.25] — 2026-10-30

### Fixed
- **An OpenCode session that was open before the plugin loaded gets messages
  too.** The plugin started a waiter only for a session it had seen start, and
  OpenCode reloads a plugin when its file changes, as an update does. A session
  that was running then never woke for a message.
- **OpenCode prompts stay as typed.** The plugin appended the session id to the
  first prompt of a session, so it showed in the user's own message, and after a
  plugin reload it was appended again. The id now goes into the system context of
  each model call, where the agent reads it and the user does not see it.

## [0.7.24] — 2026-10-30

### Fixed
- **OpenCode 2.x sessions sync again.** OpenCode 2.x writes sessions to
  `session_v2` and their turns to `session_message`, and chat-recall read only the
  1.x tables, so no session after the upgrade reached the server: on one machine
  127 of 411 sessions. Every reader now sees the 2.x store through views with the
  1.x names; a session in both stores is read once.
- **An idle OpenCode or pi session acts on a message.** Before, a message waited
  until the user typed. The plugin and the extension now wait for messages when
  a run ends, and start a turn with them.
- `recall_recent` and the sessions skill point to `recall_session_status` for a
  running session: an agent looked for a live OpenCode session in the synced
  list, where it was missing.

## [0.7.23] — 2026-10-30

### Fixed
- **The decision guard runs in opencode 2.x.** opencode 2.x refused the guard
  plugin with "Plugin must export a default definition with an id and an effect
  or setup function", so no tool call was checked. The plugin is a default
  export with `setup` (2.x) and `server` (1.x).
- 0.7.22 did not reach npm: its release run stopped at a test that imported the
  private `@munhq/mcp-kit`, which the public CI cannot install. That test now
  runs its kit checks only where the kit is installed. 0.7.23 carries every
  change of 0.7.22.

## [0.7.22] — 2026-10-30

### Added
- **Messages between sessions in Codex, Antigravity, Cursor, opencode and pi.**
  The installer registers the message hook in each installed tool, so its
  sessions report themselves and get waiting messages at the next prompt
  (Cursor: as a follow-up when the agent stops). Before, a message to an
  Antigravity session answered "No session matches". `chat-recall doctor` shows
  the hook of each tool, and `install-hooks --uninstall` removes it.

### Changed
- **better-auth 1.7 and the fleet auth kits.** The server runs better-auth 1.7
  with `@better-auth/mcp`, `@better-auth/oauth-provider` and `@better-auth/cimd`.
  MCP access tokens are JWTs for the `/mcp` resource, checked against
  `/api/auth/jwks`. The hosted image takes its auth and MCP settings from the
  private `@munhq/auth` and `@munhq/mcp-kit`; a self-host build uses the same
  settings from the server itself.
- **A consent step for MCP connectors.** After sign-in, `/consent` names the
  assistant and asks to allow or deny it.
- **Passwords need 12 characters** at sign-up and at a password change.
  Existing passwords keep working.

### Fixed
- **The decision guard runs in Antigravity.** It was registered in
  `~/.gemini/antigravity-cli/hooks.json`, which Antigravity CLI does not read: a
  probe hook there never ran, and the same probe in `~/.gemini/config/hooks.json`
  ran at every event. The installer writes it there now and removes the old entry.
- Connectors that connected before this release stay connected. At boot the
  server copies the 1.6 OAuth clients and their live refresh tokens into the 1.7
  tables, and `/api/auth/mcp/*` still answers on the 1.7 endpoints.

## [0.7.21] — 2026-10-29

### Added
- **Messages between sessions.** Four MCP tools: `recall_message_send`,
  `recall_inbox`, `recall_session_status` and `recall_session_register`. A
  message body is redacted before it leaves the machine. A waiter hook
  (`message-hook.js --wait`, `asyncRewake`) long-polls the server and wakes an
  idle session when a message arrives.
- **Child sessions.** `recall_session_spawn` starts a child as `claude --bg` in
  the folder and profile of the parent, and registers its parent, name and task.
- The `chat-recall-sessions` skill: start children, send and answer messages,
  and check on the session states.

### Fixed
- **Hooks never ran.** Claude Code reads hooks from `settings.json`, and earlier
  versions wrote them to `<profile>/hooks.json`. `init` now writes every hook to
  the `settings.json` of each profile, and the MCP server repairs a profile that
  misses them at start. `install-hooks --uninstall` keeps them out.
- **The indexer service was the first cgroup that systemd-oomd killed:** 13
  kills in six hours on one machine. The unit sets
  `ManagedOOMPreference=avoid`. Run `chat-recall service install` again to
  write the new unit.

## [0.7.20] — 2026-10-27

### Added
- **Pi sessions.** chat-recall reads the JSONL transcripts Pi writes under
  `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<id>.jsonl` and syncs them with
  the other tools. Ids are `pi_<id>~<project hash>`, and `pi --session <id>`
  resumes one. Messages keep their tool calls and results, `!` shell commands,
  and the compaction and branch summaries a compacted session folded away. Pi's
  prompt templates (`<agent dir>/prompts`) and skills (`<agent dir>/skills`)
  sync too, and the chat-recall MCP server is registered in `mcp.json`.
  `CHAT_RECALL_PI_HOME` overrides the agent dir; Pi's own
  `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` are honoured.

## [0.7.19] — 2026-10-06

### Added
- **Hermes Agent sessions.** chat-recall reads the chats Hermes keeps in
  `~/.hermes/state.db` (`%LOCALAPPDATA%\hermes` on Windows) and syncs them
  with the other tools. Ids are `hermes_<id>`, and `hermes --resume <id>`
  resumes one. A named profile under `~/.hermes/profiles/` is a home of its
  own and syncs once you approve it. `CHAT_RECALL_HERMES_HOME` overrides the
  path.

### Fixed
- **A large session in two Claude homes stopped syncing.** A session resumed
  under a second profile has one file in each home. When the two were over
  24 MB together, every sync sent an empty first chunk, and the server stayed
  hours behind. The sync now reads the two files joined end to end.
- **A re-sync wiped the session's summary and its name.** Every full sync
  cleared the stored summary, and the server wrote it again each time. The
  stored summary and name now stay.
- **The compaction summary counted as a prompt.** Claude Code writes the
  summary it makes at compaction as a user record. It is no longer the first
  prompt of a session, and the summary worker no longer sends it to the model
  as your request.

## [0.7.18] — 2026-10-03

### Fixed
- **A session that took appends kept an old raw archive.** An append sends
  only the new messages, and nothing sent the session in full again. Now a
  session that took appends gets one full sync once it has been unchanged for
  2 hours.
- **Large sessions kept an old raw archive.** An archive over 8 MB gzipped
  was dropped, and a session over 24 MB never built one. Such an archive now
  goes to object storage in 8 MB parts, written as a stream so memory holds
  one line at a time, and redacted the same way as before.
- **A session lost chat-recall when its daemon stopped.** The relay now
  reconnects, and a call that was running gets an error that says to call
  again. A daemon leaves by itself after an upgrade, so sessions use the new
  code.
- **The first chunk of a large session could replace a fuller stored copy.**
  The server now builds the new copy beside the stored one in every such case.

### Added
- `POST /api/sync/raw-upload/start` and `/complete`: a raw archive uploaded
  in parts straight to object storage through presigned URLs. A server
  without object storage answers 501, and the client keeps sending archives
  inline.

## [0.7.17] — 2026-10-02

### Fixed
- **The first chunk of a large session failed with HTTP 500 on 0.7.16.** The
  server wrote the new copy to a row that the database's row-level security
  hides, and refused the write: `new row violates row-level security policy
  "author_visibility" for table "content_cache"`. The new copy now lives in
  the session's own row until it replaces the stored copy.
- **A shadow that the old merge shortened stayed short.** When the file had
  not changed, the sync reused the stored shadow without merging again, so the
  0.7.14 merge fix never reached it. Each shadow now records the merge version
  that wrote it, and an older one is merged again.

## [0.7.16] — 2026-10-02

### Fixed
- **`verify --repair` never re-sent a stranded session.** It cleared the
  ledger cursors and exited before the delayed ledger write ran, so nothing
  reached the file. On one machine it reported 23 cursors cleared and the file
  held all 23. The 0.7.15 entry blamed the running daemon for this; that was
  wrong. The edit is now on disk before the command exits. The same applied to
  the ledger edits of `chat-recall delete` and of sync tombstones.
- **Messages added by an append had the wrong line numbers.** The server
  numbered an appended tail as one line per message, so a message on line
  3655 of the file was stored as line 3118. The client now sends the line
  count before the tail, and each message keeps its line in the file.
- **A large session with missing messages could not be repaired.** A session
  too large to build at once ships in chunks, and the server refused its first
  chunk as smaller than the stored copy, so the gaps stayed. The server now
  builds the new copy beside the stored one and replaces it when the last
  chunk arrives, if the new copy holds at least as many messages.

## [0.7.15] — 2026-10-02

### Fixed
- **Processes that share the sync ledger overwrote each other's rows.** Each
  chat-recall process loaded the ledger once and later wrote its whole copy
  back. A write now changes only the rows that process changed, and a process
  reads rows that another process changed.

## [0.7.14] — 2026-10-02

### Fixed
- **Line numbers moved after an archive merge.** When the local copy of a
  session and the file on disk differed, the merge dropped every repeated
  `mode`, `ai-title` and `last-prompt` line and collapsed identical lines. On
  one session that removed 509 lines before a prompt, and the prompt moved
  from line 3047 to line 2538. `recall_show` then reported lines the file does
  not have, and an `expand_line` could point to the wrong message. The merge
  now keeps each line where it was.
- **A half-written line made a session look rewritten.** A snapshot taken
  while Claude Code was writing a line held the first part of that line. The
  next merge took it for lost history. The merge now ignores such a line when
  the file holds it whole.

## [0.7.13] — 2026-10-02

### Fixed
- **`recall_user_prompts` returned the oldest prompts.** It said "newest
  first", but it kept the first `limit` prompts in line order. On a session
  with 80 prompts, `limit: 30` missed the latest 12. It now lists the newest
  first, also across sessions.
- **Prompts were cut at 240 characters.** Each prompt now prints whole up to
  2000 characters. A longer one prints its start, its end and the
  `recall_show` `expand_line` call that returns all of it.
- **Prompts over 1200 characters lost their end.** The CLI built the synced
  prompt list from text cut for the conversation view. It now syncs each
  prompt whole, and the server restores the whole text for rows an older CLI
  already synced.

### Added
- `recall_user_prompts` takes `query`: it returns only the prompts that
  contain that text, so "did I say X?" is one call.

## [0.7.12] — 2026-09-30

### Fixed
- **Sessions synced before 0.7.10 kept the wrong prompts.** A client sends a
  session again only when its file changes, so a finished session kept the
  prompt list the old reader made. On one machine, 692 of 10 280 sessions
  counted harness text as your prompts or missed a prompt you typed while the
  agent worked. The server now rebuilds these sessions from its own archive
  of each transcript, with no client action. `chat-recall index --force` is
  not needed.
- **Some secrets reached the server without redaction.** The sync redacted
  the raw JSONL text of a transcript, where a quote is `\"` and a newline is
  `\n`. So `API_KEY=\"value\"` and a key at the start of a line did not match
  their rules. On one machine a secret went out in clear text from 582 lines
  in 203 sessions. The sync now redacts the text that each string holds.
  Update, and rotate any credential you pasted into a session before this
  release.
- **The redactor could break a transcript line, and the server dropped it.**
  A match that took the backslash of an escaped quote, or ran across a JSON
  quote, left a line that did not parse. On one machine that hid 211 records
  in 75 sessions, 44 of them prompts. The redactor now keeps JSON valid, and
  the server repairs the lines already in its archives and restores the
  records.
- **Command output and messages from other sessions counted as your
  prompts.** Claude Code writes the output of a `!` or slash command, a
  cross-session message and the `/loop` sentinel with no author field. They
  are harness text now. The command you typed and an interrupt stay prompts.

## [0.7.11] — 2026-09-30

### Fixed
- **An update could hang the watch daemon for 90 seconds.** When two
  processes updated at the same time, the daemon ran a blocking
  `systemctl --user restart` from inside the service that was stopping it.
  systemd killed it after 90 seconds, and the next start counted a crash.
  The restart now uses `--no-block`. The daemon installs nothing after its
  shutdown begins, and one process at a time installs an update.

## [0.7.10] — 2026-09-30

### Fixed
- **`recall_user_prompts` counted harness text as your prompts.** In one
  session, 20 of 45 "prompts" were task notifications, Stop-hook feedback,
  subagent hand-backs and subagent task prompts, and hook feedback was marked
  "frustrated". The collector now reads who wrote each record from the fields
  Claude Code sets. The first prompt, the summary and the correction detector
  skip harness text too. Run `chat-recall index --force` once to correct the
  sessions you already synced.
- **A prompt typed while the agent worked was missing from `recall_show`.**
  Claude Code writes it as a `queued_command` attachment, and the transcript
  parser did not read that record. It does now.
- **`around_line` returned a window that ended before the line.** The window
  now centres on the message nearest to the line. When `expand_line` finds no
  message, the reply names the nearest real lines.
- **`recall_summary`, `recall_context` and `recall_show` said "Session not
  found" for the raw id an OpenCode session shows.** They now accept it.
- **Every sync walk was called a first sync.** A walk of 3 changed sessions
  put "first sync in progress … Older work may not be searchable yet" on MCP
  answers. That line now shows only during a first sync.
- **A server rollout could fail a sync with a deadlock.** Each boot ran the
  full schema DDL while the old pods still took syncs. The server now records
  the hash of the schema it applied, and it runs no DDL when the hash matches.

### Added
- **`recall_show query`.** It returns the messages that contain a text, with
  the line of each match.
- **A warning when sync is behind.** `recall_show` says when this machine's
  transcript has messages that are newer than the server's newest message.
- **Instructions in the MCP handshake.** They tell a model how to reach a
  message in a past session, also when it does not load the skill.

## [0.7.9] — 2026-09-28

### Fixed
- **A clean restart counted as a crash.** One boot and two restarts for an
  upgrade put "chat-recall is not syncing: it restarted 3 times in the last
  hour" over a sync that was current. The collector now counts a start only
  when the process before it did not exit cleanly, and the warning says
  "crashed".

## [0.7.8] — 2026-09-28

### Fixed
- **A session resumed under a second Claude profile stayed on the server as
  its first copy.** The collector watched only the primary home, listed each
  copy as its own session, and kept a session index that did not see a copy
  made after it was built. One session showed 521 of its 778 messages for ten
  hours. The collector now watches every Claude home, lists a session once
  with its newest mtime, and rechecks its index every second.
- **`recall_show` dropped file contents and every tool result.** It now prints
  Write and Edit bodies and each result under its call. A body over 2000
  characters shows its first and last 100 characters; `expand_line` returns
  that message whole. `chat-recall show` prints tool calls too, and `--line`
  shows one message whole.

## [0.7.7] — 2026-09-27

### Fixed
- **`recall_show` cut every message at 1500 characters.** An agent that read a
  past session got the start of a long answer and no way to fetch the rest.
  Messages, commands and tool inputs now come back whole. `chat-recall show`
  prints each message whole too.

## [0.7.6] — 2026-09-25

### Fixed
- **A changed toolkit inventory rewrote all of the device's presence rows.**
  One new skill or MCP server wrote about 400 rows on one machine. Only the
  rows that change are written now.

## [0.7.5] — 2026-09-24

### Fixed
- **An update during a server rollout failed its checksum.** The sync
  response named the new version, and the download came from a server that
  still had the old one. The update now asks for the version by name
  (`/install/chat-recall-<version>.tgz`). A server that does not have it yet
  says so, and the next sync tries again.
- **An MCP-only machine kept syncing with old code after an update.** Without
  the watch service, nothing restarted the MCP daemon, and one daemon synced
  with a 19-day-old version while the new one sat on disk. The daemon now
  runs each background sync with the installed CLI when that is newer, and
  your open sessions keep their tools.

## [0.7.4] — 2026-09-24

### Fixed
- **A pull installed MCP servers that cannot run on this machine.** It checked
  only that the command exists here, and a server started through `npx`,
  `uvx` or `docker` passes that check on any platform. An Xcode server
  registered on a Mac was installed into five tools on a Linux PC, where one
  copy started with every session. Each MCP registration now records the
  platform of the device it came from, and a pull installs a server only where
  a device of the same platform registered it. To install one anyway, name it:
  `chat-recall toolkit pull --mcp <names>`.
- **Every plugin in the Codex catalog was reported as installed.** chat-recall
  read `~/.codex/.tmp/plugins/`, which is Codex's copy of its plugin catalog,
  so the skills and MCP servers of plugins nobody installed were uploaded as
  yours and pulled onto your other devices. It now reads only the plugins in
  `~/.codex/plugins/cache/`, the ones Codex installed.
- **A skill or MCP server you removed came back.** The account kept every
  toolkit item a device had ever uploaded. Each device now sends the list of
  skills, MCP servers, commands, agents and plugins it has, and an item leaves
  the account when no device has it any more. An item another device still
  has stays. On the machine where this was measured, the first sync removed
  832 items that only that machine had ever reported.

## [0.7.3] — 2026-09-24

### Fixed (server)
- **A failed sync could leave a session unreadable.** The ingest deleted a
  deleted session's archive from object storage while its transaction was
  still open. If a later step failed, the rollback restored the row and the
  object was already gone, so every read of that session returned
  `ObjectNotFound`. Objects are now deleted after the transaction commits.
- **A failed rewrite of an archive left new bytes under the old row.** Every
  version of a session's archive used one object key, so the upload replaced
  the stored bytes before the row was committed. Each version now gets its own
  key (`raw/<tenant>/<session>.<16 hex>.gz`), and the key it replaces is
  deleted after commit. Archives stored before this release keep their key and
  still read.
- **Outcome badges, knowledge-graph facts and tool titles survived a failed
  sync.** They were written on separate connections that committed at once.
  They now go in the sync's own transaction. A sync that set the tool title of
  a session it was also rewriting waited on its own lock and failed with
  `55P03 canceling statement due to lock timeout`; that request now returns
  200.
- **A triple repeated inside one sync failed the whole knowledge-graph
  insert.** It is now written once.
- **The secret alert fired for findings that a failed sync rolled back.** It
  now runs after the sync commits.

## [0.7.2] — 2026-09-24

### Fixed
- **The collector was OOM-killed every 4 to 5 minutes.** codeindex 0.5 made
  `codeindex --mcp` a relay onto a shared daemon. The collector closes stdin
  after it sends its calls, so the relay exited before any reply arrived. Every
  code scan failed with "codeindex returned no files", and each daemon it had
  started stayed inside the collector's systemd unit. Eleven of them held about
  1 GB. The collector now runs codeindex with `CODEINDEX_NO_DAEMON=1`, and on
  the machine where this was measured it scanned 31 of 31 workspaces with no
  restart.
- **Each full sync walk read about 1 GB of transcripts.** A full walk runs at
  startup and every 15 minutes. It listed every session with a first-prompt
  preview (467 MB for 10,350 Claude sessions, 423 MB for 236 OpenCode
  sessions), and then it discarded the previews. The walk now lists sessions
  without previews and reads 0 MB to do it. The collector's startup peak went
  from 1,024 MB to 600 MB.
- **A code scan pass rescanned every workspace.** A workspace whose git HEAD
  and changed files match its last completed scan is now skipped. An unchanged
  workspace is still sent again after 7 days.
- **OpenCode previews could show a later prompt** from the same session. On a
  database where every part has the same timestamp, the preview now comes from
  the first user message. The query also stopped loading whole messages into
  memory: one first message held 107 MB of diffs.
- **Parsing a transcript ran `realpath` once per record** to find its project.
  A 10,000-record session made 10,001 `lstat` calls on the same path. Each
  path is now resolved once.

### Fixed (server)
- **Deleting a session kept its raw archive, derived data and outcome.** The
  purge removed the metadata row first. Row-level security then hid the other
  three tables from the member, so their deletes matched nothing and reported
  no error.
- **Self-heal brought deleted sessions back.** It rebuilt a missing session
  from any archive it found and never checked the tombstone. It now skips a
  deleted session, and each pass removes whatever an earlier delete left
  behind, including the archive in object storage.
- **Sync returned HTTP 500 for a batch containing a session with no author**
  (`author_write_update` on `memory_metadata`). An append now records the
  writer as the author of such a row. One bad row used to fail all 50 sessions
  in its batch.

## [0.6.8] — 2026-09-14

Everything here came from opening the app on a phone and looking at it. Every
one of these passed the structural checks first.

### Fixed
- **Conversations was unusable on a phone.** The Sessions / Notes toggle is a
  direct flex child of the view row, so it sat as a 156px column beside the
  list on a 390px screen: 40% of the viewport for one control, the list crushed
  into what was left, "Notes &" cut mid-word, "By project" clipped off the
  edge, the counter broken across three lines and every row wrapped to three.
- **The top bar clipped the account avatar on every view.** The plan chip and
  the sync chip take about 200px of the 390 available, so the only control that
  opens the account menu sat past the right edge. Both leave the phone bar; the
  plan is on the Account page and the sync time in the sidebar footer.
- **Account's tab row ended in "Da"** with nothing to say it scrolls. It does
  scroll, but the scrollbar is hidden and the cut was flush, so Data read as a
  clipped label rather than a tab one swipe away.
- **A view this deployment does not have sent you to Conversations** without
  saying so. `?view=settings` answered with a list of conversations, identical
  to `?view=search` down to the character count. Each gated view now names
  where its content actually went.

### Accessibility
- **Nothing was a `<main>`.** A screen-reader user had no way to skip the rail.
- **Eight of eleven views had no `<h1>`,** and Overview had two, so moving by
  heading could not tell you which page had loaded. Every view has exactly one
  now, worded the way the rail words it.
- **Hundreds of controls were under the 24px target size** WCAG 2.5.8 asks for
  — 935 of 957 on the Security list alone, where the per-finding actions render
  15 to 20 pixels tall. Icon buttons drew their ink and their hit area at the
  same number, so the mobile menu and the banner dismiss were small on every
  view. The paint is unchanged; only the target grew.
- **The project tree's expand control had no accessible name** and read the
  same whether the folder was open or shut.

## [0.6.7] — 2026-09-14

### Fixed
- **`?view=memory` rendered nothing.** Memory Hub was dissolved into the Notes
  & memory facet of Conversations, and no branch draws that view any more. An
  old bookmark was mapped to Conversations on load and then set straight back
  by a mount effect that re-read the URL, so the app settled on a view nothing
  renders and the screen stayed blank. Both readers map it now.
- **The install page bounced you to the dashboard after seven seconds.**
  `?view=connect` polls sync status to notice the first data arriving, then
  leaves — but it asked whether any session had ever synced, which is true for
  every account that has used the product. It takes a baseline now and leaves
  only when new data actually arrives from the machine being connected.

## [0.6.6] — 2026-09-14

### Added
- **The board moves itself.** A prompt that names a card id (`t_…`) claims that
  card and links your session to it; a commit message that names one closes it,
  carrying the shas and the files as the evidence the board asks for. Both
  halves install from `chat-recall init`, on macOS, Linux and Windows — they run
  the CLI directly, so they need no shell script and no POSIX shell. `doctor`
  reports the pair per profile.

  Until now nothing in the product ever set `in_progress` or `done`. Every
  reference to them was a status enum, a glyph, or prose telling the agent to
  call `recall_task_update` by hand — and that call is the step that gets
  skipped whenever the work itself goes well.

### Changed
- **Transactional mail moved to `@munhq/mailkit` and a copy pack.** This
  repository is public, and eleven messages lived in it as string literals:
  their subjects, bodies, send schedule and the reasoning behind each one. The
  renderer and the words are both out of here now. Mail is a hosted-service
  feature, so the package is an optional dependency and a self-host build omits
  it entirely — the server then logs that it has no mailer and runs on.

### Fixed
- **`install-hooks` registered one hook per event and dropped the rest.** It
  read the first match, so a second hook on `UserPromptSubmit` or `SessionEnd`
  vanished without a word.
- **`doctor` reported hooks as healthy when half of them were missing**, because
  it asked whether an event carried any chat-recall command at all.
- **The contact form left a request hanging** when the build carried no mailer.

## [0.6.5] — 2026-09-12

### Added
- **A decision register, and `recall_decisions` to read it.** One value per area
  (auth, database, payments, deploy, pricing, licensing…) with the cascade
  already resolved — a project decision beats an account-wide one, and a
  personal preference fills a gap without ever overruling a team. It returns
  what each value replaced, when, and the session behind it, plus the areas
  nobody has decided. The agent is meant to read it before choosing a library,
  not after.
- **An area on `recall_decision_record`.** It is the key a reversal supersedes
  on: recording a new `auth` decision now closes the previous one and leaves
  every other area alone.
- **Confirm or discard the guesses in your history.** The indexer's extracted
  decisions are offered as candidates with the area pre-filled; either judgement
  retires the guess so the queue can empty.

### Changed
- **The Knowledge lens leads with decisions**, with the entity graph one click
  away. The graph answers how facts connect, which is rarely the question
  someone arrives with.
- **Decisions the extractor GUESSED dropped below the wake-up gate** (0.8 →
  0.6). A regex cannot tell a decision from a sentence naming two tools, and the
  wake-up bundle has a small fixed budget. They stay in the graph and are
  offered as candidates instead of arriving as fact.

### Fixed
- **Recording a decision superseded nothing.** `subject → decided → object` was
  written with a free-text subject, so "auth", "authentication" and "auth setup"
  were three separate facts and a later decision closed none of them. Both
  values stayed live forever. The graph showed it: `decided` had one subject
  with more than one live value, while the extractor's `chose` had fifty — one
  of them carrying 227.

## [0.6.4] — 2026-09-11

### Fixed
- **The start limiter was written into the wrong section, so it did nothing.**
  systemd reads `StartLimitIntervalSec` from `[Unit]` and ignores it under
  `[Service]`, silently. 0.6.2 and 0.6.3 put it in `[Service]`: the unit file
  said the limiter was off and `systemctl show` reported the 10s default, so a
  crash loop could still end in permanent abandonment — the exact failure the
  setting exists to prevent, with a line in the file claiming otherwise.
- **A daemon run from a source checkout took over the installed service.** The
  startup refresh rewrote the unit using the running build's own path, so
  running one out of a working tree repointed `ExecStart` at it. It now
  refreshes only the unit that already names this build, leaving which binary
  the service runs to the installer.

## [0.6.3] — 2026-09-11

### Fixed
- **0.6.2 never reached npm.** The heartbeat read `process._getActiveHandles`,
  which is undocumented and absent from `@types/node`. `tsc -b` accepts it and
  the daemon's own stricter config does not, so the build failed at
  `tsc -p tsconfig.daemon.json` — after the tag, during publish. The handle
  count now goes through a narrow cast and reports 0 where the runtime does not
  expose it.

## [0.6.2] — 2026-09-11

### Fixed
- **The collector held one file watcher per transcript, and transcripts are
  never deleted.** chokidar takes a watch descriptor for every file a glob
  matches, so the sessions watcher grew with a user's whole history. Measured
  over CDP on a running daemon with 13,929 transcripts: 17,046 watcher handles,
  900 MB of heap, 2.1 GB RSS. systemd-oomd killed it 23 times in 48 hours. A
  finished transcript never changes, so watchers now cover a 14-day window —
  135 files there rather than 13,929 — and the same machine measured 4,255
  handles and 109 MB of heap. Sessions outside the window still sync: the
  15-minute heartbeat does a full ledger walk. `CHAT_RECALL_WATCH_WINDOW_DAYS`
  overrides it.
- **systemd stopped restarting the collector, permanently and silently.** After
  53 restarts it answered "Start request repeated too quickly" and left the unit
  dead — twelve hours with nothing collected and nothing said. The unit now
  disables the start limiter and carries a memory cap, so a crash is a restart
  rather than an abandonment.
- **An upgrade could not fix the unit it shipped with.** The service definition
  was written only by `chat-recall watch --install-service`, so every
  supervision fix reached only machines installed after it. The daemon now
  compares the installed definition with the one this version renders and
  rewrites it on startup.
- **Writing collector health erased the fields it did not name.**
  `telemetryEligible` (what carries reporting eligibility across a restart) and
  `starts` (the restart history a crash loop is read from) were dropped on every
  write, and the daemon writes that file every few seconds during a walk.
- **Purging a session cost two round trips**, and the retention sweeps call it
  once per session. `DELETE ... RETURNING` is one.

### Added
- **A collector heartbeat.** Liveness was inferred from the absence of sync
  events, which needs a six-hour window to allow for a closed laptop, and cannot
  see a machine that never completed a walk at all. The collector now beats
  every five minutes whether or not it had work, carrying rss, heap and open
  handle count — the numbers that diagnosed the leak above, which previously
  existed only on the machine that had it. `CHAT_RECALL_HEARTBEAT_SECS`
  overrides the interval.
- **The raw session archive can live in object storage.**
  `RAW_ARCHIVE_S3_BUCKET` and friends move the gzipped transcript out of the
  `raw_sessions.gz` column. On the hosted database that column was 1232 MB of
  3564 MB, every byte of it TOAST, read only when someone opens one session.
  Both shapes coexist, so turning it on needs no migration, and
  `scripts/backfill-raw-to-object-store.ts` moves what is already there.
  Authorization does not move with the bytes: the key is reachable only through
  a `raw_sessions` row, which is behind the tenant and author policies.
- **Fleet health metrics.** `chatrecall_client_failures_24h`,
  `chatrecall_collectors_active` and `chatrecall_collectors_stale` on the
  server's `/metrics`. The client failures they report had been arriving and
  going unread.

### Changed
- **Search puts the tenant inside the index condition.** `gin(tsv)` matched
  every tenant's postings and filtered afterwards, so one tenant's search read
  every tenant's matching rows. Measured across 50 tenants and 1.25M chunks: a
  common two-term query went from 253 ms and 297,185 discarded rows to 36.6 ms
  and none. The trigram index for the typo fallback got the same treatment.

## [0.6.1] — 2026-09-03

### Added
- **Two skills, so security and the task board are reachable by name.** Six
  skills shipped and all of them were recall-shaped; the four security tools and
  the five task tools were reachable only through the hub, whose description
  leads with "recall past AI-coding work" — the wrong scent for "did I paste an
  API key". `chat-recall-security` owns the scan-rotate-dismiss loop and says not
  to mark a finding `rotated` on the user's behalf. `chat-recall-tasks` owns the
  board and states the evidence the server actually enforces: `in_progress` is
  refused without a linked session id, `done` without a diff or commits.
  62 tools, 0 named in no skill; the 12 still hub-only are index and maintenance
  plumbing, which is the hub's job.

### Fixed
- **`recall_recommendation_apply` and `recall_recommendation_dismiss` were in no
  focused skill.** `chat-recall-project` already carried `recall_recommendations`,
  so it could find what to fix and neither apply nor dismiss it.
- **OpenID Connect: the discovery document advertised an algorithm we never sign
  with.** better-auth publishes `id_token_signing_alg_values_supported: ["RS256"]`
  while `/mcp/token` signs the id_token with an HMAC key generated per request
  and discarded. Nothing could verify that token, and a client fetching
  `jwks_uri` for the RSA key found an empty set. It now advertises HS256, the
  algorithm actually used — which also makes the empty JWK Set correct rather
  than a wart, since a symmetric algorithm has no public half to publish.

### Changed
- **Every published description named only the memory.** Memory is 12 of the 62
  tools; the secret scanner and the code findings are most of the rest. The
  registry line, the Glama listing, both npm packages, both plugin marketplace
  manifests and the MCP server's own description now name all three.

## [0.5.32] — 2026-09-01

### Fixed

- **A repo could be filed under two different projects at once, and per-session
  worktrees under neither.** Claude Code flattens a project path into a directory
  name by replacing `/` with `-`, and a `.` or `-` inside a real directory name
  survives as `-` too — so three characters arrive as one and the name alone
  cannot say which. `chat-recall` and `chat/recall` encode identically: the real
  path resolved to its git id while the fiction became
  `path:/Users/me/code/chat/recall`, splitting one project's history in half.
  Worse for dot-directories: a per-session worktree's leading dot was flattened,
  the path did not exist, git could not be consulted, and its sessions landed
  under a standalone `path:` project instead of the repo they belong to.

  Two defects produced this. Eight non-session sources (plans, hooks, CLAUDE.md,
  subagents, slash-commands, agent-memory, live-scan, vault) used the cheap
  structural decoder — which is why the fictional projects showed decisions and a
  tech stack but zero sessions, since the session parser treats the JSONL `cwd`
  as ground truth. And the session parser carried a second, hand-rolled prober
  that tried `-`, `_` and `.` as join separators but never as a prefix, leaving
  dot-directories unreachable.

  There is now one probing decoder: it lists the real children at each level,
  encodes each the way the tool would, and takes the longest match. Probing can
  only improve an answer, never invent one — a Windows-encoded name, a path from
  another device, or a deleted repo all fall back to the structural decode.
  Measured against a real store, 62 sessions moved out of fictional projects into
  the git ids they belong to, and no bucket regressed.

### Added

- **`chat-recall delete` takes many sessions, not one.** Deletion was per-session,
  which is right for "forget that conversation" and useless against a tool that
  fabricates sessions — a misfiring model probe wrote 476 one-line transcripts
  into a single project, 94% of its indexed history. `delete` now accepts a list,
  `--stdin`, or a `--project`/`--match`/`--tool` selector, with `--dry-run` and a
  confirmation. It ships tombstones through `POST /api/sync`, the same path the
  collector uses when a transcript disappears locally, so bulk deletion is not a
  second implementation of "remove everywhere" that has to stay in agreement with
  the first.

  The selector walks every page: rows are mtime-ordered, so stopping at page 0 is
  how a delete reports "0 matched" on a project with hundreds. `--match` is exact,
  not substring. Confirmation is required only for a set the caller did not
  enumerate — `delete <id>` still deletes immediately, because naming a session
  is the confirmation and scripts have always relied on it.

- **`chat-recall restore` undoes a delete.** A tombstone is why deletion sticks,
  and nothing could lift one. Permanent-by-default is defensible while deletion is
  one session at a time; it stops being defensible once a single call can remove
  hundreds, which is a trapdoor rather than a control. `GET /api/data/tombstones`
  lists what was deleted — restore is impossible without it, since a purged
  session leaves nothing else to find it by — and `POST /api/data/restore` lifts
  tombstones for named ids. It is id-scoped on purpose: a restore-everything would
  re-open every deletion made for privacy. It never claims the content is back,
  only that the refusal is gone; the transcript still has to exist somewhere and
  be re-shipped with `index --force`.

## [0.5.31] — 2026-09-01

### Fixed

- **The fleet panel accused a LAN box of shipping transcripts in cleartext.** A
  device reported 652 `insecure_transport` failures in a week and the panel
  rendered them as "refusing to sync to a server over plain HTTP — nothing from
  this device is reaching it". Nothing of the kind had happened: the target was a
  box on a private address over `http://`, which the transport gate allows by
  design, and the gate had never fired. The failure class came from a substring
  test on the error message, and the 402 handler deliberately prints the server's
  own sentence instead of the HTTP line while appending the `upgradeUrl` from the
  response body — so `402` was gone from the message and `https://` was in it.
  651 monthly-quota pauses were filed as a TLS problem. The class now travels on
  the error, set where the status was read; only the transport gate's own wording
  still counts as a transport refusal, and the 5xx test moved above it.
- **A paused sync meter had no warning of its own.** The panel had a sentence for
  three failure classes, so the same device's 270 billing refusals — the one
  condition a human could act on — produced nothing, while its only visible
  warning described a problem it did not have. Billing is now a warning, and any
  class without a sentence of its own is listed rather than dropped.
- **Every quota-paused batch was retried four times before failing.** The
  rewritten 402 message also defeated the retry gate, which asked `/HTTP 4\d\d/`
  whether a failure was fatal. A standing condition — billing, auth, an unsafe
  transport — now stops the loop by class, not by wording.
- **The most common timeout was filed as `other`.** `AbortSignal.timeout`
  produces "The operation was aborted due to timeout", which matches neither
  `timed out` nor `etimedout`. One machine logged 441 of them against
  `/api/capabilities` alone.
- **`chat-recall doctor` reported a dead sync target as healthy.** A walk pushes
  to every target in sequence and succeeds when any one accepts data. The daemon
  recorded that single verdict against every target it knew about, so a walk
  where the hosted service took four sessions and a LAN box refused the
  connection wrote `lastOkAt = now, failures = 0` for both, and `doctor` printed
  "Synced 0m ago" for a box that had not accepted a byte in days. The walk now
  reports per target and the daemon marks each from its own verdict.
- **"Stopped trying a sync target 823 times" was one target, switched off.** A
  tripped breaker re-opens on every attempt until a success clears it, so
  counting open verdicts measured how long the box stayed off — 96 a day — rather
  than how often anything broke. Only the failure that crosses the threshold is
  now a trip; the rest are still reported, carrying the consecutive-failure
  streak, which is where the severity actually lives. The warning also names the
  streak, and says the target is on your own network when every trip was against
  a private address.
- **"38 sessions too large to archive" was one session.** The
  `oversized_session` event repeats on every walk for as long as a transcript
  stays over the ceiling, and the count was a count of events. It was one 117MB
  OpenCode transcript, reported 38 times. The event now carries a non-reversible
  per-session mark so the count means sessions; rows from an older collector fall
  back to size and tool.
- **Nothing said that a device was six releases behind.** One had
  `CHAT_RECALL_AUTO_UPDATE=0` in its systemd unit, and every layer stayed quiet
  by design: the daemon suppresses "disabled" because it would print every six
  hours forever, and the only telemetry is sent after an update is attempted, so
  a plan that never runs never reports. The panel now warns when a device's CLI
  is behind the release its server ships, compared numerically because `0.5.9`
  sorts above `0.5.30` as text. The collector reports a standing refusal to
  self-update once per process, with both versions named.

## [0.5.30] — 2026-08-31

### Fixed

- **The auto-updater filled /tmp and never emptied it.** `executeAutoUpdate`
  downloaded the release tarball, wrote it into a fresh `mkdtemp` directory, and
  removed that directory on no exit path — not on success, not on either
  failure return. Because the updater runs on every sync, the directories
  accumulate for as long as the collector does. One machine was carrying 5,889
  of them holding 5.1 GB. npm has copied what it needs by the time `install()`
  returns, so the staging directory is now deleted on every path below the
  `mkdtemp`.
- **Upgrading does not give that disk back, so the updater also sweeps.** A
  machine that already ran an older version keeps its backlog, and only code
  that runs often can clear it. The sweep runs on every sync rather than inside
  `executeAutoUpdate`, which is reached only when an update is due — the
  machines with a backlog are precisely the ones already up to date. It removes
  only directories named `cr-update-` plus `mkdtemp`'s six characters, holding
  nothing but `chat-recall.tgz`, and older than an hour, so a concurrent
  update's live directory is never pulled out from under it. Rooted at
  `tmpdir()`, the same call the leak used, so it follows `TMPDIR` on macOS
  (`/var/folders/…/T`) and `%TEMP%` on Windows instead of assuming `/tmp`.

## [0.5.21] — 2026-08-27

### Fixed

- **`init --server https://chatrecall.dev` could fail with "No OIDC issuer
  configured".** The login asks /api/capabilities which sign-in flow to run, and
  that was one 8-second attempt inside `catch {}`. A slow or blocked probe left
  the provider unknown, execution fell through to the OIDC branch, and the user
  was told to pass `--issuer <url>` or set CHAT_RECALL_OIDC_ISSUER — for a hosted
  service that has never had an OIDC issuer, with no hint that a request had
  failed. Seen on a clean macOS install. The probe now retries three times with a
  longer timeout, keeps the failure reason and prints it, and when it still
  cannot be read assumes the better-auth device flow that the hosted service and
  every AUTH_PROVIDER=better-auth self-host run. A wrong guess produces a
  specific error; refusing to try helped nobody. `--issuer` and Keycloak servers
  are unaffected.
- **The MCP now identifies itself** — title, description, websiteUrl and icons in
  serverInfo, which clients show when asking a user whether to trust a server,
  and which every directory previously had to scrape or invent.


## [0.5.20] — 2026-08-27

### Fixed

- **Every tool parameter now carries a description.** Seven tools had arguments
  with none at all, and they were not cosmetic: `importance` on
  recall_decision_record decides whether a fact ever reaches a future session's
  wake-up bundle (only 4 and 5 do), and `direction` on recall_kg_query silently
  decides whether you get facts where the entity is subject or object. An agent
  guessing at those writes memory that either shouts or vanishes.
- **`resources/list` and `prompts/list` answer with an empty list** instead of
  JSON-RPC -32601. This server has no resources or prompts and says so in its
  capabilities, but clients probe anyway, so every directory scan recorded two
  failures against a server that was working correctly.
- **The Smithery badge and Glama maintainer named a personal account.** The badge
  ships on npm, so the package page showed a personal handle for a commercial
  product; everything else already said munhq.


## [0.5.19] — 2026-08-27

### Fixed

- **A long-lived process reinstalled the CLI and restarted the daemon forever.**
  `ownVersion` is read once, at module import, so any process alive since before
  a release keeps reporting the old number while the package on disk has already
  been replaced. It then asks the server, is told a newer version exists,
  installs a version that is ALREADY INSTALLED, restarts the watch service — and
  nothing about the running process changes, so it does it again on the next
  tick. Observed on a real machine: seven MCP servers reinstalling the CLI and
  bouncing the daemon every 2-3 seconds, indefinitely, with `node_modules`
  rewritten each time. Silent, too — the daemon still syncs between bounces, so
  only CPU and disk churn give it away. Any user who leaves an editor open across
  a release hits this. `runAutoUpdate` now re-reads the manifest at decision time
  and lets the DISK win: once the installed bytes satisfy the server the answer is
  "already current", however stale the process asking. A genuine update still
  proceeds, and a disk ahead of the server is never downgraded.
- **Hosted users were told about the server's collector.** The collector-health
  banner ("chat-recall is not syncing… run `chat-recall doctor`") is prepended to
  every tool answer and was not gated on multi-tenant mode, so over the remote
  /mcp endpoint it read the SERVER's health file — reporting a collector the user
  does not own and cannot fix, and prepending our operational state to every
  tenant's output. Both that banner and the first-sync progress line are now
  local-only.

### Added

- **`PUT /api/tenants/:slug/entitlement`** — set a plan without Stripe, admin-key
  only. Every entitlement previously came from the Stripe webhook or the one-shot
  7-day trial, so a demo or reviewer workspace was always on a seven-day clock and
  went dark mid-review. A null period end means live indefinitely.
- **`DELETE /api/accounts/:email`** — delete a person, not just a workspace.
  `deleteTenant` left the identity behind: it could sign in, got a fresh workspace,
  and could never sign up again. It refuses while the account still owns a tenant,
  and names them.


## [0.5.18] — 2026-08-26

### Fixed

- **An email signup was never asked to confirm, so it never got a trial.**
  Signing up with an address created an account and walked straight into the app
  with the address unverified — nothing asked for a code. `verifyEmailWithOtp`
  and `resendVerificationEmail` existed with no UI behind them while the server
  mailed codes nobody could enter. `ensureTrial` says "No trial until an address
  is confirmed", so those accounts worked and had nothing: no trial, and paid
  features answering 402 for a reason the user was never told. Social sign-in was
  never affected — the provider vouches for the address — which is why the copy
  looked correct while being false for most signups. Sign-up now goes to a
  6-digit code screen with a resend, and there is no way past it into the app.
- **The sign-in message stopped promising a trial it could not grant.** Social
  starts on the spot; email starts once the code is confirmed.


## [0.5.17] — 2026-08-26

### Fixed

- **A new user could not use this product at all.** Every published install —
  `server.json`, `smithery.yaml`, `plugin/.mcp.json`, the README badges — is
  `npx -y -p chat-recall chat-recall-mcp`, which runs the MCP from a transient
  cache and puts NOTHING on PATH. So all 27 offered tools answered "not logged
  in. Run `chat-recall login <server-url>`", naming a command the user did not
  have. One instruction, and it was `command not found`. The MCP now starts the
  sign-in itself — it is the only part of the product actually running — and
  returns a device link and code for the assistant to show. A fresh install
  primes it at startup so the FIRST tool call carries the link. Approving runs
  the full `init`: skills into every detected AI tool, MCP registered with each,
  the background sync service started, and existing sessions synced. The link is
  in the response and not only in a browser, because an MCP can run over ssh or
  in a container where nothing can open; a browser is opened as a convenience.
- **`recall_smart_resume` required the one thing a resume cannot have.**
  "Continue where we left off" routes to this tool, and `session_id` was
  mandatory, so a bare call died with a schema error. It now defaults to the
  newest session, resolved through the same endpoint `recall_recent` uses.
- **The device-approval page was off-brand and dead-ended.** The first screen a
  new user sees was the only page ignoring the design system: 15 hardcoded hex
  values, a blue accent against our warm brand, and no light mode. It also said
  "you can close this tab" to someone whose trial had just started, and told MCP
  users to "go back to your terminal" when there is none. It now uses the tokens,
  says the trial is live, and offers the dashboard.
- **A merge to main did not mean deployed.** The deploy repo discovered commits
  on a `*/15` cron that GitHub deprioritises under load — four consecutive slots
  skipped in one afternoon. A push now notifies it directly, with the poll kept
  as the safety net.

### Added

- **Client ID Metadata Documents (CIMD).** A `client_id` that is an https URL is
  now resolved by fetching it, so a registry can connect without registering —
  which is how Smithery authenticates, and therefore why it could not connect at
  all. Guarded as an SSRF surface must be: https only, post-DNS address checks
  against private ranges over both families, no redirects followed, size and time
  caps, and the document must name itself.
- **The JWKS both discovery documents advertise.** `/api/auth/mcp/jwks` 404'd
  while being published in the metadata. It serves an empty key set, which is the
  true answer — the access tokens are opaque, so no signing key exists.


### Fixed

- **A read replica going away 500'd reads the primary could serve.** `PgStore`
  validated the replica once, at startup, and degraded to the primary if it was
  unreachable — but a replica does not only fail at startup. A CloudNativePG
  failover took ours away mid-life and `/api/conversations/recent` answered 500
  while the primary was healthy, because the metadata caches open the RO pool
  directly and had no such guard. The fallback now belongs to the QUERY, in one
  function: an unavailable replica (FATAL/PANIC, class 08, 57P0x, or a dead
  socket) retries on the primary, a wrong query does not retry at all, and the
  degraded-read warning is rate limited so a dead replica cannot flood the log.

### Added

- **Two MCP tools that NARROW what we hold, and a rule that keeps them one-way.**
  `recall_forget` deletes one conversation from the server permanently (the
  user's own transcript is untouched); `recall_exclude_path` stops a path syncing
  here and on the account. Both are the answer to something said mid-conversation
  — "forget that", "stop syncing this repo" — which is why they belong in the
  agent and not only in a dashboard.

  The safety is directional: an agent may narrow what is stored and never widen
  it. There is deliberately no tool that removes an exclusion, widens the
  allowlist or lengthens a retention window. Both are annotated destructive, both
  require `confirm: true` (annotations are advisory — a host may ignore them, so
  the only host-independent brake is an argument the model must pass on purpose),
  and both are kept OUT of the `alwaysAllow` list `init` writes, which is what
  actually makes the host prompt. `NEVER_AUTO_ALLOW` names them and
  mcp-tool-registry.test.ts pins the rule in both directions.

- **Delete one conversation from the dashboard.** The endpoint had existed since
  the CLI's `chat-recall delete`, with no way to reach it from the UI — so
  removing a single conversation meant a terminal, or deleting the whole project,
  which is what people did instead.

- **A retention window you set yourself**, with the warning it needs. `GET`/`POST
  /api/data/retention` ({days}), a `chat-recall retention` command, and a
  dashboard panel; swept server-side beside the existing purges. The only answer to "how
  long do you keep my sessions?" was "while your workspace exists", and a window
  is the one privacy control a user cannot implement for themselves. 0 (the
  default for every existing workspace) keeps everything, so shipping this
  deletes nothing until somebody asks. A value below the 7-day floor is REFUSED
  rather than clamped — silently turning a typed 1 into 7 tells the user nothing.
  Ungated, beside export and delete: a control over your own data does not sit
  behind a plan. No tombstones, unlike a manual delete, so widening the window
  and running `sync --full` re-ships what the new window admits.

  Because it deletes on a TIMER, the person arming it is not present when it
  acts — so nothing arms until the cost is shown and acknowledged. `GET
  ?days=N` prices a candidate window without setting it; a change that would
  delete sessions we hold is refused with 409 plus the count until the caller
  sends `acknowledge: true`; the CLI makes you retype the count; the dashboard
  shows a warning and a checkbox naming the number. A window that deletes
  nothing asks for nothing — a ceremony on the harmless case teaches people to
  click through the one that matters. And the warning says the part that is easy
  to leave out: re-syncing recovers a session ONLY while its transcript still
  exists on a machine you have. For a laptop you no longer own, history a tool
  rotated, or files you deleted, our copy is the only copy.

- **`init` says what would leave the machine BEFORE it uploads.** It used to run
  the first sync and report afterwards — "Synced 412 session(s)" — so the one
  irreversible decision in setup was made for the user and described in the past
  tense, while the exclusions that govern it are only useful beforehand. Step 6
  now prints the session count, the tools, the top projects by name, and how many
  sessions carry no project path at all (a tool that files transcripts under a
  hash rather than per directory leaves nothing for a path rule to match, and
  `exclude tool` is the control that covers those). An interactive run can answer `n` and set rules first; with
  no TTY, or with `--yes`, the summary still prints and the sync proceeds, so no
  script hangs. The preview calls the SAME predicates the sync gate calls, so it
  cannot drift into a reassurance the upload does not honour.

- **The security page now answers where the data lives and what we do not do with
  it.** EU-only hosting (OVHcloud, Gravelines), no third-party AI APIs, ungated
  export and deletion, and "we do not train on your sessions" — which existed
  only in the legal pages and, for the training question, in the *pricing* FAQ.
  It also documents the **Vault**: a client-side-encrypted backup (Argon2id key
  derivation, XChaCha20-Poly1305, the server holds ciphertext and cannot decrypt)
  that was implemented and advertised nowhere, stated together with what it does
  not cover — the searchable index, which must reach Postgres as text for search
  to work.

- **An end-to-end gate for the privacy controls** (`scripts/exclusion-e2e.mjs`,
  wired into the compose workflow). It boots the real server, drives the real
  CLI, and asserts what a user actually cares about — the row never reached
  Postgres — for `exclude project`, `exclude tool`, `sync-only`, rule removal,
  `delete <session>`, `POST /api/data/delete`, and the read-back through MCP.
  23 checks. Every one of those paths previously had unit tests of the pure
  predicate only, which is how the bug below survived.

- **A ceiling on open auto-filed cards (50).** The per-run cap bounded a burst,
  not a total: every ingest triggers a run, so 10-at-a-time kept going until the
  whole backlog was cards. Moving one account's floor from high to medium made
  1,070 items eligible, and a thousand-card board is the same unreadable board
  duplicates produced, reached by volume. Filing now stops at the ceiling and
  resumes as cards close; closing, re-pointing and de-duplicating are never
  blocked, and the panel says "Board full" rather than promising work it will not
  do.

### Fixed

- **The server-side sync rules failed OPEN.** `fetchTenantSyncConfig` returned an
  empty rule set on any non-2xx or network error, so a five-second blip made
  every dashboard exclusion silently not apply for that sync — and the sync then
  uploaded the projects those rules exist to hold back, with the rules still
  showing as applied in the dashboard. Now: a 404 still means empty (an older
  self-hosted server has no such endpoint, and that IS the answer); any other
  failure reuses the last successfully fetched set, persisted to disk so a fresh
  CLI process has it; and with nothing ever fetched, the sync REFUSES rather than
  uploading under rules it cannot see. Refusing is recoverable — re-run it —
  while an upload is not.

- **The scope preview could report "nothing would upload" on a full machine.**
  `summariseSyncScope()` reads the tool-backend registry, which is populated by a
  bootstrapper that only runs once `core/backends/index.js` has been imported —
  so with no other module pulling it in first, the preview returned zeros. For a
  privacy preview, under-reporting is the one failure that must be impossible; it
  now takes that dependency itself.

- **`chat-recall exclude project ~/code/chat-recall` did not exclude
  chat-recall.** Claude Code names a project folder after its path with every
  separator replaced by `-`, and that encoding cannot be inverted: the sync gate
  received `/home/user/code/chat/recall` while the rule stored the hyphenated
  path the user typed, so the substring test was false and the project kept
  uploading. Silently — the rule sat in `exclude list` looking applied. Any
  project whose directory name contains `-` or `_` was affected, which is most of
  them; `sync-only` failed the same way, in the safe direction (it shipped
  nothing). One matcher now collapses `-`, `_` and `/` on both sides
  (`project-path-match.ts`), and every comparison tries the raw form first, so a
  rule that matched before still matches and the change can only ever withhold
  more. Applied to the sync gate, the selective-sync allowlist, and the
  index-time allow/deny lists.

- **The auto-file panel counted only half of what it files.** It read
  `code_actions` alone while the filer reads findings too, so asked what a lower
  priority floor would pick up it answered 316 when the true number was 1,070 — a
  floor was chosen on that answer. It counts both sources now, exactly and
  uncapped.

- **Four cards for one finding.** The finding id gave every EMISSION its own
  ordinal, so a collector that reported the same finding four times — byte
  identical in every column — produced four ids and four cards for
  `memory-index.ts:53`. 387 of 8,290 stored findings were duplicates of that kind.
  The ordinal counts distinct LINES now, and the title joined the key so the 918
  findings that carry no line stop depending on the analyzer's emit order to stay
  apart. A finding's triage verdict and age, and every card pointing at it, now
  survive the id change that this implies.
- **One problem filed twice, once from each source.** A roll-up action summarises
  findings the same run also emitted, and both were fileable: `_callWithFeeRetry
  ×30` beside `_callWithFeeRetry copy-pasted 30× (10 lines each)`. The collector
  stamps which findings each roll-up covers — it is the only place that knows —
  and a member is suppressed only when its roll-up is itself being filed, so a
  summary below the policy floor can never silence a critical. Cards already
  duplicated on the board are collapsed, and the run reports how many.

### Added

- **A person can dismiss a recommendation, not only an agent.** 0.5.16 gave the
  assistant `recall_recommendation_dismiss` and left the dashboard with no such
  button — a capability the human did not have. The card now carries "Not for this
  repo", which asks for the reason the server requires, and a "Show dismissed"
  list with "Put it back".
- `docs/ENVIRONMENT.md` documents billing: every `STRIPE_*` variable and
  `BILLING_PLANS`. The file had zero mentions of Stripe, including the two vars
  0.5.16 added. `STRIPE_AUTOMATIC_TAX` carries the warning that matters — enabling
  it before Stripe Tax reports `status: active` fails every checkout on the
  account.

### Fixed

- **A dismissal was one-way.** The listing suppressed dismissed recommendations at
  build time, exactly like applied ones, so the card vanished from the only screen
  that could offer to bring it back and the recorded reason was written to a store
  nothing read. Dismissed ones are now returned apart from the live list, with
  their reason and author, which is what makes an agent's dismissal reviewable.
- **The auto-file panel under-reported its own work.** A run that re-pointed twenty
  cards onto renamed findings said "Filed 0, closed 0" — indistinguishable from a
  dead switch, which is the one thing that panel exists to disprove. The run now
  reports all five counters (filed, closed, reopened, re-linked, repaired), and
  `autoTasksStatus` reads back the three it had been discarding, so the count
  survives a reload instead of living only in a toast.

## [0.5.16] — 2026-08-25

### Added

- The assistant can ACT on recommendations, not only read them. Three tools,
  taking the surface to 58:
  - `recall_recommendation_apply` — add a recommendation's rule to the repo's
    CLAUDE.md, or set the label it asks for. The apply route already enqueued a
    sync intent for the machine holding the repo, so the execution path was always
    agent-driven; only the decision was stuck behind a dashboard button.
  - `recall_recommendation_dismiss` — say no for one project, with a reason. The
    reason is required: these tools are reachable by an agent, so a dismissal is a
    machine changing how future sessions treat someone's codebase, and an
    unexplained one cannot be reviewed. `undo: true` restores it.
  - `recall_project_label` — mark a repo poc / production / engineering, the
    guardrail every later session reads.
- The wake-up bundle carries a project's top three recommendations, so a session
  starting in a repo is told what would make it better before anyone asks.
  Project-scoped and capped: unscoped it would be every project's advice at once,
  at the moment a session is trying to orient.

### Fixed

- `recall_recommendations` never emitted the recommendation `id`, which would have
  left the two new tools with no way to name their target.
- Dismissals live in `kv_store`, not a new table: one fact per id, already
  tenant-scoped and RLS-walled, and a table would have needed a migration to carry
  something that small.

## [0.5.15] — 2026-08-25

### Added

- **A remote MCP endpoint: `POST /mcp`, Streamable HTTP with OAuth 2.1.** A client
  that cannot run the CLI — claude.ai, ChatGPT, a browser IDE, anything in an MCP
  directory — can now connect to `https://chatrecall.dev/mcp` and get the same
  tool table the local stdio server serves. Dynamic client registration, PKCE
  S256, refresh tokens, and both RFC 8414/9728 discovery documents at the origin
  root. An MCP identity IS the account identity: the OAuth grant resolves to the
  same `user` row the dashboard and the CLI device flow use.
- `server.json` declares the endpoint under `remotes`, which is what makes a
  directory list chat-recall as hosted rather than stdio-only.
- `OPERATOR_TENANTS` / `OPERATOR_PLAN`: an allowlist of tenant slugs that are
  always entitled. It grants a plan, never the operator role.

### Changed

- **A lapsed account is refused, not served stale history.** Reads used to pass
  through, so an account whose trial had ended kept answering searches out of the
  corpus it held the day it lapsed, with a banner carrying the caveat. A caveat
  only works on an agent that reads caveats. Every value surface now answers 402
  `no_plan`. Nothing is deleted — `/api/data` export and delete lost their gate
  rather than gaining one, because taking your history with you must never
  require paying again, and neither must erasing it.
- The 55-tool surface moved to `packages/engine/src/mcp/`, so the stdio server and
  the remote endpoint serve one definition and cannot drift into two products.

### Fixed

- The remote endpoint authenticated the caller and then answered 401 on every
  tool call: it passed the OAuth access token as the loopback credential, and
  that is not a session token. `initialize` and `tools/list` touch no API, so
  every manual check passed. There is now an end-to-end script that calls a tool.
- `recall_code_index` was reachable by name on the remote endpoint, where it
  would have run the analyzer over the SERVER's filesystem. Local-only tools now
  refuse in the dispatch, not just in the listing.
- `POST /mcp` had no rate limit; `GET /mcp/` returned JSON over the documentation
  page that `README.md` links and npm ships.
- `smithery.yaml` launched `npx -y chat-recall-mcp`, which is E404 —
  `chat-recall-mcp` is a bin inside `chat-recall`, not a package.
- `plugin/.claude-plugin/plugin.json` sat eight releases behind; `version:sync`
  now stamps it too.
- A brand-new account was told its "subscription has lapsed". Every connector
  signup starts before the trial is granted, so that was the first sentence a new
  user read, and it hid the one action that fixes it.

## [0.5.14] — 2026-08-25

### Fixed

- 0.5.13 published its image but not its npm package: `server.json` carries the
  version too, the registry publishes what it says, and a parity test asserts the
  two match — but the bump was a manual step nobody could see. So the sequence was
  bump the CLI, tag, push, the image ships, and only then does the release fail on
  a version field. `npm run version:sync` now copies the CLI's version into
  `server.json`, so the number has one source and the step is visible.

## [0.5.13] — 2026-08-25

### Fixed

- A machine-closed card now reopens when its finding comes back. The sweep only
  ever closed: `done` sat in the closed set so the card was skipped for ever, and
  the filing loop matches an open finding to a card by id, so it filed nothing
  either. The finding became invisible — the board said done, the code still had
  the problem, and no surface showed it. Eight cards on one board were in exactly
  that state. It is the expected shape now that a finding's id is derived from its
  content: a finding that returns returns as itself.
- Only machine-closed cards reopen. A card carrying the session that did the work
  records a finished episode, so a returning finding gets a new card rather than
  resurrecting someone's completed one; `rejected` stays the human's verdict; and
  a person's own card is never touched.

## [0.5.12] — 2026-08-25

### Fixed

- The auto-filer's findings read was `limit: 500` across every project, and the
  close sweep treated that one page as the complete set of open findings. With
  8,096 findings and 500 slots, everything past the cap looks deleted — so a card
  pointing at it closes itself as fixed, which is the bug this service had just
  been repaired for, reintroduced by a LIMIT. It was harmless only by accident:
  the ordering is severity-first and just 31 findings were critical-or-high, so
  every fileable one fell inside the page. It would have become live the moment
  the policy floor moved from 1 to 2.
- Reads are now bounded by intent instead of by a page size: per-severity queries
  for what the floor admits, and a new `codeFindingsByIds` for the exact findings
  the existing cards name. A card's finding is judged absent only when a
  by-id lookup says so.

## [0.5.11] — 2026-08-24

### Fixed

- A card older than `linked_finding_identity` now acquires one. It matches by id,
  so the filing loop's early `continue` skipped it on every run and it never
  gained an identity — meaning the first time its id shifted it would close
  itself as fixed, which is exactly what the column exists to prevent. The cards
  left after migration 0009 are precisely these, so without the backfill they
  stayed vulnerable indefinitely.

## [0.5.10] — 2026-08-24

### Fixed

- The 0.5.9 rollout could not start. Migration 0009's entry in `migrate.mjs`
  lacked the `./migrations/` prefix, and entries resolve against
  `import.meta.url` — which is `migrate.mjs` itself, not the migrations directory
  — so the initContainer opened `/app/migrate/0009_….sql`, got ENOENT and died.
  Kubernetes kept the previous pods serving, so there was no outage, but the new
  ReplicaSet sat in `Init:CrashLoopBackOff` and the repair never ran. The removed
  0001–0008 files all carried the prefix; this one dropped it because `FILES` had
  been empty and nothing exercised the path.
- Migration 0009 is now verified against a throwaway Postgres rather than
  reasoned about: seven fixtures covering every branch, of which only the two
  phantoms are deleted — a completion with a session, a human rejection, an open
  card, a card whose finding still exists and a human-created card all survive,
  the orphaned comment goes and the real one stays. Re-running removes 0, and on
  a database with no tables it reports and returns.

## [0.5.9] — 2026-08-24

### Fixed

- A finding's id moving is no longer read as the problem being fixed. An
  auto-filed card closed itself whenever its finding id left the open set, and an
  id shift was indistinguishable from a fix by that test. On one board 93 of 97
  cards closed that way — none with a session attached — while all 313 findings
  were still open, and duplicates piled up: six cards for one title. Cards now
  store the finding's identity as well as its id; a card whose identity still
  matches an open finding is re-pointed rather than closed, and only a card with
  no match closes, naming the id that vanished.
- A finding survives an edit above it. `codeFindingId` hashed the line number,
  the most volatile part of a finding, and `replaceCodeFindings` carries `status`
  and `first_seen_at` forward by id — so adding an import at the top of a file
  discarded every triage verdict in it. Identity is now content plus an ordinal
  among identical siblings, ordered by line: stable under edits elsewhere,
  distinct per occurrence.
- A recommendation you already applied stops asking. Applying a rule does not
  change the findings that motivated it, so the card regenerated forever. The
  applied state already existed in the sync-intent log and nothing read it.
- Migration 0009 removes the phantom auto-closed cards. Its predicate requires
  all of created_by='auto-tasks', done, no linked session, and an orphaned
  finding id, so a real completion and a human rejection are both untouched.

### Added

- Critical findings can reach the task board. `runAutoTasks` read `code_actions`
  and nothing else, and findings carry a severity string where an action carries
  a numeric pri — so a finding was never filtered out, it was never looked at. On
  one account that left 34 criticals permanently unable to become a task while a
  pri-2 "God module" filed one. `priOfSeverity` maps severity onto the floor the
  policy already speaks, and both sources share one fileable path.

## [0.5.8] — 2026-08-24

### Fixed

- The image build failed on 0.5.7, so the release published to npm but no image
  and no deployment followed it. The CLI's new `prepack` copies the root README
  into `packages/cli`, and `docker/Dockerfile.server` runs `npm pack` inside the
  image to produce the tarball the server hands out at
  `/install/chat-recall.tgz`. `*.md` in `.dockerignore` kept the README out of
  the build context, so the copy threw ENOENT. Fixed by shipping the file rather
  than softening the copy: weakening `prepack` would have restored the original
  defect — a publish with no readme at all — and the served tarball should carry
  the same readme the registry does.

## [0.5.7] — 2026-08-24

### Fixed

- The npm page was blank. `npmjs.com/package/chat-recall` rendered
  `ERROR: No README data found!` — nothing at all on the surface a CLI is found
  through. `files` listed `README.md` and no such file existed, because npm reads
  a README only from the package directory it publishes, never from a monorepo
  root. A `prepack` script copies the root README in, gitignored so the two
  cannot drift.
- The npm description contradicted the product model, calling this "local-first"
  with an "optional" server sync when there is no local store and no offline
  mode, and it named four AI tools of six. `keywords` was empty while the GitHub
  repository already carried sixteen usable topics.
- Every URL that does not exist answered **200** with the app shell, canonical
  pointing at `/app` — a path `robots.txt` disallows. Google classes that as a
  soft 404: dead addresses enter the crawl set, crawl budget goes on URLs that
  are not real, and the styled 404 page already being built could never be
  reached. Unknown paths now serve it with status 404 and
  `X-Robots-Tag: noindex`. The allowlist is exhaustive because the client has no
  path router — navigational state lives in query params — so `/`, `/app` and
  `/device` are the only paths the app owns.

### Added

- The trial-ending email. The pricing page says, twice, "We email you before the
  trial ends", and nothing sent it: the live webhook was not subscribed to
  `customer.subscription.trial_will_end`, no case handled it, and no such mail
  existed. A trial lapsed in silence and the customer learned it when sync
  stopped. The handler notifies only — three days out the customer is still
  trialing and still entitled, so writing an entitlement there could only
  downgrade someone mid-trial.
- A product guard on the Stripe webhook, for selling more than one product from
  one account. Stripe fans an event out to every enabled endpoint and does not
  route by product, so another product's subscription events arrive here, and
  two products on one identity provider produce colliding tenant ids. Two
  layers: `metadata.product` is decisive, and an untagged event whose price sits
  outside our catalogue is rejected without the other product's cooperation. A
  missing tag is accepted, because every existing subscription predates the tag
  and failing closed would stop renewals for customers who already pay.
- `STRIPE_AUTOMATIC_TAX`, off by default. Enabling Stripe Tax while every live
  price carries `tax_behavior: unspecified` and the account default is unset
  would reject every checkout on the account, so this is a switch rather than a
  constant.

### Note

- `invoice.payment_failed` is deliberately not handled. Stripe owns dunning: its
  Smart Retries choose better retry times than we can, and its own mail carries a
  hosted card-update link, so our copy could only restate that worse and arrive
  as a second email about one event.

## [0.5.6] — 2026-08-22

### Added

- `init` now registers the MCP server in EVERY AI tool it detects, not just
  Claude Code: `~/.codex/config.toml`, `~/.gemini/settings.json`,
  `~/.config/opencode/opencode.json` and `~/.cursor/mcp.json` alongside
  `~/.mcp.json`. It detected five tools and configured one, so a Codex user
  installed cross-tool memory and found no recall tools inside Codex — the
  promise failed at the only step the user cannot see. Each client is written in
  its own format; the Codex TOML is spliced, so hand-written tables and comments
  survive. `doctor` prints one line per tool, and re-running repairs a stale
  entry instead of duplicating it.
- Every tool now carries MCP annotations (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `title`). Without them a host cannot tell `recall_search`
  from `recall_kg_invalidate`, so all 53 tools looked like potential writers and
  every call needed a prompt. 14 tools declare that they write; 5 that they
  overwrite.
- A root `.claude-plugin/marketplace.json`, so
  `/plugin marketplace add munhq/chat-recall` works. The plugin payload — six
  skills plus the bundled MCP server — already existed with no manifest to
  install it from.
- `CHAT_RECALL_SERVER` + `CHAT_RECALL_TOKEN` authenticate with no credentials
  file, and `Dockerfile.mcp` builds the MCP server as a container. A sandbox
  cannot run `chat-recall login`, so both directory registries that build and
  run a server got "run chat-recall login first" from every tool call.

### Changed

- A lapsed trial is now DORMANT rather than a windowed free plan: new sessions
  stop syncing, and everything already synced stays fully searchable. The
  previous shape cut the wrong axis — a seven-day search window demonstrates
  only what `claude --continue` already does for free, and it bit the heaviest
  users first. Pausing ingest strands nothing: the transcripts live on the
  user's own disk, so `chat-recall sync --full` restores the gap on subscribing.
  The meters moved to the no-card trial, the only unpaid plan that still
  ingests.
- Trial reminder emails are keyed 3 / 1 / 0 days remaining. At 7 / 2 / 0 — the
  thresholds for a 14-day trial — the halfway nudge fired on signup day, because
  the trial has been 7 days in production.

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
