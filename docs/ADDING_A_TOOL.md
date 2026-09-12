# Adding an AI coding tool

chat-recall reads five tools today: Claude Code, Codex, OpenCode, Antigravity
and Cursor. Adding a sixth means writing one format adapter and then extending
the places that enumerate the five by name.

The shared engine in `packages/engine/src/core/generic-engine.ts` runs the same
`extractTurnsFromEvents` / `liveScanEditsFromEvents` / `replayFromEvents`
against every backend's `readEvents()` output. Turning a transcript into
`CanonicalEvent[]` is therefore the whole job; everything downstream already
works once that function does.

## 1. The id

`AiTool` in `packages/engine/src/core/live-session-scan.ts`:

```ts
export type AiTool = 'claude' | 'opencode' | 'codex' | 'agy' | 'cursor';
```

Add yours. The compiler will now point at most of the work in step 3.

Session ids carry a prefix so one id space spans every tool: `claude` uses the
empty prefix, the rest use `<id>_`. Pick a prefix nothing else starts with.

## 2. The backend

Create `packages/engine/src/core/backends/<tool>.ts`, implementing
`ToolBackend` from `../tool-backend.js`:

| Member | What it does |
|---|---|
| `id`, `idPrefix`, `displayName` | identity |
| `homeDir()`, `isAvailable()` | where this tool writes, and whether it is installed here |
| `matchesId()`, `toRawId()`, `toPrefixedId()` | id translation |
| `findSession()`, `listSessions()` | locate one session, or enumerate them |
| `readEvents()`, `fileToolMap` | the format adapter the generic engine consumes |
| `extractTurns()`, `liveScanEdits()`, `replay()`, `computeOutcome()`, `getCommits()`, `collectRecentEdits()`, `exportRawSession()` | delegate these to the generic engine |

Read `backends/codex.ts` first: it is the smallest complete adapter. Read
`backends/cursor.ts` if your tool has more than one surface — Cursor covers both
the `cursor-agent` CLI and the desktop IDE, and splits its readers into
`cursor-store.ts` and `cursor-ide.ts`.

Make the home directory overridable by an environment variable, the way the
others are: `CHAT_RECALL_<TOOL>_HOME`. `core/tool-paths.ts` holds the defaults
and the overrides so backends and the dispatcher read one source.

## 3. The enumerations

Register the backend in `packages/engine/src/core/backends/index.ts` — import
the singleton, add one `registerBackend(...)` line, and re-export it.

**That is not the end of it.** Thirty other files list the five ids by name: per-tool
skill and MCP paths, sync policy, artifact encoding, the toolkit matrix, several
server routes. A tool missing from one of them is not a compile error and not a
crash; it silently reads as "this tool has nothing", which is the failure mode
this section exists to prevent.

Find them, rather than trusting a list in a document that will rot:

```bash
for f in $(grep -rln "'cursor'" packages/*/src --include='*.ts' | grep -v '\.test\.'); do
  grep -q "'claude'" "$f" && grep -q "'codex'" "$f" && grep -q "'agy'" "$f" \
    && grep -q "'opencode'" "$f" && echo "$f"
done
```

Work through every file it prints. `npx tsc -b` catches the ones whose lists are
typed as `Record<AiTool, …>`; the rest are arrays and string comparisons that
accept a short list without complaint.

## 4. Tests

`backends/backends.test.ts` runs the contract every backend must satisfy, and
`backends/integration.test.ts` runs the generic engine against real fixture
transcripts. Add fixtures for your format to both.

Fixtures use invented paths and invented project names — `/home/user/code/example-app`,
`acme`, `owner/repo`. See the rule at the foot of `CLAUDE.md`: a path test asserts
a string transformation, so a real home directory adds no coverage and publishes
a username.

Run the suite:

```bash
npx tsc -b
npx vitest run packages/engine
```
