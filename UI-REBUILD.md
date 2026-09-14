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

- Run `npx tsc -b` after every task. It must stay clean.
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

- [ ] **B1** `Decisions` rail item at position two, account scope by default,
      with the same `All projects | <project>` control A2 introduces.
      `Sidebar.tsx`, `App.tsx`
- [ ] **B2** The plate titled `Decisions and stack` renders no decisions. Render
      `<Decisions project={canonicalId} embedded />` in it.
      `ProjectWorkspace.tsx:304, :312`
- [ ] **B3** Knowledge-graph facts become writable from the UI. `POST /api/kg/add`
      and `/invalidate` exist and only MCP calls them, so an agent can retract a
      wrong fact and the user cannot. `KnowledgeGraph.tsx`

## C — The project Overview becomes one question

**A2 left the two scopes not quite aligned.** All-projects is now
`Overview · Do next · Code · Activity`; a project is
`Overview · Code · Conversations · Activity · Knowledge`. C4a closes the gap.

- [ ] **C4a** `Do next` becomes a project lens of its own, so both scopes name
      the same views. Falls out of C1–C3 — once the other three sections leave
      Overview, what remains IS Do next.


Three of its four sections ship with a link to the tab that owns them, which
makes them a table of contents rather than a screen.

- [ ] **C1** `Structure` leaves Overview; Code lens owns it.
- [ ] **C2** `Decisions and stack` leaves Overview; Knowledge lens owns it.
      (Supersedes B2 — B2 is the stopgap if C lands later.)
- [ ] **C3** `Jump back in` leaves Overview; Conversations lens owns it.
- [ ] **C4** `0 imports` and `189 imports` print on one screen from two data
      shapes. `ProjectWorkspace.tsx:213`

## D — Dissolutions

Each moves a component between screens, so each needs its own verification pass.

- [ ] **D1** Memory Hub: graph becomes a toggle under Decisions; MemoryExplorer
      becomes a source filter inside Conversations. Rail item removed.
- [ ] **D2** Team: member activity → Overview; share control → Settings; the
      Tasks tab is deleted, it rendered the same component as the rail item.
      Rail item removed.
- [ ] **D3** System health: a status chip in the rail footer, driven by the
      stale-sync alert CommandCenter already imports. `?view=health` survives.
- [ ] **D4** `Analytics & Insights` leaves Overview for Account as `Usage`.
      Touches the entitlement gate — verify a free tenant sees no dead door.

## E — Density

- [ ] **E1** Toolkit's three stacked controls become one grouped set: `Skills`
      (skills, commands, subagents) and `Connections` (MCPs, hooks, plugins).
- [ ] **E2** Security `Custom rules` leaves the tab row; it is configuration
      wearing the shape of four data views.
- [ ] **E3** The sidebar's source pills and project tree change nothing on
      health, team, tasks and security. Pass the sidebar the current view and
      render a filter only where it does something.
- [ ] **E4** `Decisions.tsx` breaks the 12px annotation floor at 8 sites
      (11px and 10.5px): lines 171, 175, 195, 231, 240, 272, 302, 375.
- [ ] **E5** Dead `--cr-radius-md` references resolve to `0px` and read as
      square by accident. `SyncRules.tsx:86,99,233`, `ConnectMachine.tsx:190,204,262`,
      `ConversationViewer.tsx:1593`

## F — Verification

- [ ] **F1** `npx tsc -b` clean.
- [ ] **F2** Vitest suites green.
- [ ] **F3** Playwright e2e green (18 specs, 77 tests).
- [ ] **F4** Screenshot every changed screen in both themes, theme forced via
      `localStorage`.
- [ ] **F5** `node ~/.claude/skills/impeccable/scripts/detect.mjs --json <files>`
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
| 2026-09-14 | A2 | All-projects tabs are now `Overview · Do next · Code · Activity`, and the heading is `All projects` — it was `Projects & Activity`, which folded a tab into the title. |

## Not in scope, still open

- `recall_smart_resume` rewrite is uncommitted on this branch
  (`resume-digest.ts`, its test, `tools.ts`). It is unrelated to the UI.
- Production: 421 OOM crashes in 14 days, still happening. Task
  `t_73f0aed74703924a96`.
- `packages/engine/package.json` has an uncommitted `@aws-sdk/client-s3`
  dependency that nothing imports and `object-store.ts` documents refusing.
