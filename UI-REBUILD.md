# UI rebuild — information architecture

Branch: `ui/ia-rebuild`. Nothing reaches `main` until the user has seen it;
a push to `main` deploys to real users through Keel.

The audit that produced this list: 14 screens, 9 rail items, 54 tab
destinations. Every change below is frontend only. No endpoint changes, no
migrations.

## The two findings this exists to fix

1. **Nine words each mean two or three things** depending on depth. `Overview`
   is the rail item, a project lens and a Code-lens tab. `Tasks` is a rail item,
   a Team tab and a Memory source. A reader cannot build a map of a product
   whose words change meaning as they go deeper.
2. **The decision register has no route.** It governs every project, the server
   answers account scope when the caller omits `project`, and the only way to
   reach it is Projects → pick a project → Knowledge.

## Conventions

- **`npx tsc -b` from the repo root does NOT type-check the client.** The
  client is checked by its own `tsc` in its build script, so a broken component
  passes the root build. Verify with:
  `cd packages/server/client && npx tsc --noEmit -p tsconfig.json`
  Run BOTH after every task. And never read the exit code through a pipe —
  `npx tsc -b | head` reports head's status, not tsc's.
- The app runs at `http://127.0.0.1:5174`; the API at `http://127.0.0.1:5000`.
- **Force the theme** with `localStorage.setItem('cr-theme', 'light'|'dark')`.
  The app ignores `prefers-color-scheme`, so a context `colorScheme` option
  alone gives two identical captures and a false pass.
- Tick a box the moment a task lands, and write what changed beside it. This
  file is the memory between sessions.

---

## A — Vocabulary

Label and routing work. No component moves.

- [x] **A1** Code-lens `Overview` → `Summary`. Removes the third meaning of
      Overview. `CodeExplorer.tsx`
- [x] **A2** All-projects tab set (`Active Repositories · Findings · Global
      Activity · System Code Map`) is replaced by the five lenses plus an
      `All projects | <project>` scope control. `ProjectsDashboard.tsx`,
      `ProjectWorkspace.tsx`, `App.tsx`
- [x] **A3** Rail item `Toolkit` → `Skills & tools`. `Sidebar.tsx`
- [x] **A4** Memory source labels: `Pastebin` → `Pasted text`, `Notes` →
      `Instruction files`. `MemoryExplorer.tsx`
- [x] **A5** Memory source `Tasks` deleted — the rail item owns that word.
      `MemoryExplorer.tsx`

## B — The register gets a route

- [x] **B1** `Decisions` rail item at position two, account scope by default,
      with the same `All projects | <project>` control A2 introduces.
      `Sidebar.tsx`, `App.tsx`
- [x] **B2** The plate titled `Decisions and stack` renders no decisions. Render
      `<Decisions project={canonicalId} embedded />` in it.
      `ProjectWorkspace.tsx:304, :312`
- [x] **B3** Knowledge-graph facts become writable from the UI. `POST /api/kg/add`
      and `/invalidate` exist and only MCP calls them, so an agent can retract a
      wrong fact and the user cannot. `KnowledgeGraph.tsx`

## C — The project Overview becomes one question

**A2 left the two scopes not quite aligned.** All-projects is now
`Overview · Do next · Code · Activity`; a project is
`Overview · Code · Conversations · Activity · Knowledge`. C4a closes the gap.

- [x] **C4a** `Do next` becomes a project lens of its own, so both scopes name
      the same views. Falls out of C1–C3 — once the other three sections leave
      Overview, what remains IS Do next.


Three of its four sections ship with a link to the tab that owns them, which
makes them a table of contents rather than a screen.

- [x] **C1** `Structure` leaves Overview; Code lens owns it.
- [x] **C2** `Decisions and stack` leaves Overview; Knowledge lens owns it.
      (Supersedes B2 — B2 is the stopgap if C lands later.)
- [x] **C3** `Jump back in` leaves Overview; Conversations lens owns it.
- [x] **C4** `0 imports` and `189 imports` print on one screen from two data
      shapes. `ProjectWorkspace.tsx:213`

## D — Dissolutions

Each moves a component between screens, so each needs its own verification pass.

- [x] **D1** Memory Hub: graph becomes a toggle under Decisions; MemoryExplorer
      becomes a source filter inside Conversations. Rail item removed.
- [x] **D2** Team: member activity → Overview; share control → Settings; the
      Tasks tab is deleted, it rendered the same component as the rail item.
      Rail item removed.
- [x] **D3** System health: a status chip in the rail footer, driven by the
      stale-sync alert CommandCenter already imports. `?view=health` survives.
- [x] **D4** `Analytics & Insights` leaves Overview for Account as `Usage`.
      Touches the entitlement gate — verify a free tenant sees no dead door.

## E — Density

- [x] **E1** Toolkit's three stacked controls become one grouped set: `Skills`
      (skills, commands, subagents) and `Connections` (MCPs, hooks, plugins).
- [x] **E2** Security `Custom rules` leaves the tab row; it is configuration
      wearing the shape of four data views.
- [x] **E3** The sidebar's source pills and project tree change nothing on
      health, team, tasks and security. Pass the sidebar the current view and
      render a filter only where it does something.
- [x] **E4** `Decisions.tsx` breaks the 12px annotation floor at 8 sites
      (11px and 10.5px): lines 171, 175, 195, 231, 240, 272, 302, 375.
- [x] **E5** Dead `--cr-radius-md` references resolve to `0px` and read as
      square by accident. `SyncRules.tsx:86,99,233`, `ConnectMachine.tsx:190,204,262`,
      `ConversationViewer.tsx:1593`

## F — Verification

- [x] **F1** `npx tsc -b` clean.
- [x] **F2** Vitest suites green.
- [x] **F3** Playwright e2e green (18 specs, 77 tests).
- [x] **F4** Screenshot every changed screen in both themes, theme forced via
      `localStorage`.
- [x] **F5** `node ~/.claude/skills/impeccable/scripts/detect.mjs --json <files>`
      clean. It needs `htmlparser2 css-select css-tree domutils` resolvable next
      to the script or it runs degraded and undercounts.

---

## Progress

| Date | Task | What changed |
|---|---|---|
| 2026-09-14 | — | Branch created, this file written. |
| 2026-09-14 | A1 | Code-lens `Overview` → `Summary`. That screen has NINE tabs, not five — the earlier sweep missed template-literal labels. |
| 2026-09-14 | A3 | Rail `Toolkit` → `Skills & tools`. |
| 2026-09-14 | A4/A5 | `Pastebin` → `Pasted text`, `Notes` → `Instruction files`, Tasks tab removed. Dropping the tab also dropped task rows out of "Everything" and printed the raw key `task` in the breakdown, because both were built from the tab list. Split into `BROWSE_SOURCES` + `SOURCE_LABELS` so a source can be browsed and counted without owning a tab. |
| 2026-09-14 | B1 | `Decisions` rail item, account scope by default, project scope control, `?view=decisions` deep link. Icon is `book`; `check` already belonged to Tasks. |
| 2026-09-14 | B2 | The `Decisions and stack` plate renders the register instead of a graph. |
| 2026-09-14 | C1–C4a | Project Overview is `Do next` alone. Structure and Jump-back-in deleted rather than copied — the Code lens already has Structure and Map tabs, the Conversations lens already is the archive. The stack strip followed the decisions into the Knowledge lens. `StructureSummary` and `ProjectHistory` removed. The `0 imports` / `189 imports` contradiction went with the chip row: `map.edges` is package-level and empty here, `map.fileEdges` is the 189. |
| 2026-09-14 | D1 | Memory Hub dissolved. Graph is a toggle under Decisions; the note corpus is a `Sessions / Notes & memory` facet of Conversations. `?view=memory` redirects to Conversations so old links land on what they asked for. |
| 2026-09-14 | D2 | Team's Tasks tab removed — it rendered the same `TeamTasks` the rail item renders, so one board sat at two addresses. Team keeps activity and sharing. |
| 2026-09-14 | D3 | System health left the rail for a `SyncChip` in the rail footer, driven by `syncTone`/`syncLabel`. `?view=health` still resolves and is still never gated. |
| 2026-09-14 | D4 | Overview is one screen. The usage report is an Account tab, so the plan boundary runs between pages instead of between two tabs of one rail item. |
| 2026-09-14 | E1 | `Skills & tools` groups its six sidebar type rows into `Skills` (skills, commands, subagents) and `Connections` (MCPs, hooks, plugins). The page heading matched the old rail label and now matches the new one. The three stacked controls I flagged live inside the SyncMatrix overlay, where type, text and state are three different questions — left alone. |
| 2026-09-14 | E2 | Security's `Custom rules` left the tab row for a button beside it. It is configuration, not a fifth way to group findings. |
| 2026-09-14 | E3 | `VIEW_FILTERS` in Sidebar.tsx gates the source pills and project tree per view. They rendered on all nine and did nothing on five. |
| 2026-09-14 | E4 | `Decisions.tsx` annotation floor: 8 sites at 11px/10.5px raised to 12px. |
| 2026-09-14 | E5 | Dead `--cr-radius-md` references removed from SyncRules, ConnectMachine, ConversationViewer. |
| 2026-09-14 | e2e | Specs updated for the new IA. `sidebar-consistent.spec.ts` was rewritten: its premise — every view shows the same Source filter — was the E3 bug written down as a requirement. |
| 2026-09-14 | F3 | e2e: 31 pass, 0 fail on `app.spec.ts` + `sidebar-consistent.spec.ts`. **Playwright's chromium was never installed on this machine**, so every desktop test failed in 2ms and the run still exited 0 — the suite has not gated anything here. Installed it. Three pre-existing defects surfaced: `search-testid` `search-layout` is asserted three times and has never existed in the client (`git log -S` finds no commit adding it); `project-all` set no `aria-current` while the tool pills beside it do; and `defaults to conversations view` asserted the wrong landing view. |
| 2026-09-14 | fix | The sync chip rendered only when `/api/status/sync` answered. System health left the rail, so the chip is the only door to it — a failing endpoint removed the route. It renders always now, grey and honest when the facts are missing. |
| 2026-09-14 | B3 | `addKgFact` / `invalidateKgFact` added; every current fact gets a "Not true" button and the graph gets a subject/relation/object form. Retraction is temporal, so a retracted fact keeps its window and renders expired. 15,656 regex-mined facts had been read-only to the only party who could tell they were wrong. |
| 2026-09-14 | D2 (rest) | `ProjectSharing` extracted to Settings, member activity mounted on Overview, Team removed from the rail. `?view=team` still resolves. **The rail is seven.** |
| 2026-09-14 | E1 (rest) | The three stacked Toolkit controls are on the DEFAULT Coverage screen, not in an overlay as previously recorded — and the inline matrix's type tabs duplicated the sidebar rows. It is driven from the sidebar now. |
| 2026-09-14 | F5 | Detector: 14 changed files, 0 findings. It takes ONE target per invocation; passing several concatenates them into one unreadable path and still exits 0. |
| 2026-09-14 | F4 | 20 captures, both themes, theme forced via localStorage. Light `#F3F0E9` vs dark `#0C2843` — different grounds, so not two identical captures. 0 overflow, 0 stray radius, 0 sub-12px. The check now REFUSES to score a page that did not render: an error boundary passes every measure trivially, and three captures had been scored blank. |
| 2026-09-14 | fixes | Found only by looking: `Decisions` printed twice with two competing subtitles; a segmented control with one option; avatar initials at 11px (`size * 0.4` at the 28px default); `ProjectSharing` rendered beside Settings instead of below it. |
| 2026-09-14 | config | `playwright.config.ts` sets `PLAYWRIGHT_BROWSERS_PATH` from `XDG_DATA_HOME`/`$HOME` when unset. Playwright looks in `~/.cache/ms-playwright`; the browsers are in `~/.local/share/ms-playwright`. A project whose tests all fail to LAUNCH reports no failures and exits 0. |
| 2026-09-14 | A2 | All-projects tabs are now `Overview · Do next · Code · Activity`, and the heading is `All projects` — it was `Projects & Activity`, which folded a tab into the title. |

## Needs your call

- `e2e/tool-filter-unified.spec.ts` tests a UI that no longer exists. It drives
  `nav-activity` and `nav-dashboard`, which left `Sidebar.tsx` in commit
  fd7b2183, and asserts in-view tool-filter rows that
  `sidebar-consistent.spec.ts` asserts have count 0. It was already broken
  before this branch. Deleting it needs written approval, so it is untouched.

## Not in scope, still open

- `recall_smart_resume` rewrite is uncommitted on this branch
  (`resume-digest.ts`, its test, `tools.ts`). It is unrelated to the UI.
- Production: 421 OOM crashes in 14 days, still happening. Task
  `t_73f0aed74703924a96`.
- `packages/engine/package.json` has an uncommitted `@aws-sdk/client-s3`
  dependency that nothing imports and `object-store.ts` documents refusing.
