# Changelog

All notable changes are tracked here, newest first. Versioning follows [SemVer](https://semver.org).

## [Unreleased]

### Added

- **A ceiling on open auto-filed cards (50).** The per-run cap bounded a burst,
  not a total: every ingest triggers a run, so 10-at-a-time kept going until the
  whole backlog was cards. Moving one account's floor from high to medium made
  1,070 items eligible, and a thousand-card board is the same unreadable board
  duplicates produced, reached by volume. Filing now stops at the ceiling and
  resumes as cards close; closing, re-pointing and de-duplicating are never
  blocked, and the panel says "Board full" rather than promising work it will not
  do.

### Fixed

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
