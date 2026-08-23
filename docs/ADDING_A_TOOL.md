# Adding a new AI tool to chat-recall

chat-recall supports six AI coding tools today: Claude Code, Gemini CLI,
OpenCode, Codex, Antigravity and Cursor. All the per-tool knowledge lives behind
a single `ToolBackend` interface, and the heavy lifting (turn extraction,
file-edit scanning, diff replay) runs through a generic engine that operates on
canonical events.

**Read §6 before you estimate the work.** This guide used to claim "no edits
anywhere else". That was wrong and cost real time: the Antigravity commit
touched 13 files, and Cursor touched around 40. The backend file is the
interesting part, but roughly 30 enumerations elsewhere list the tools by hand,
and most of them DROP an unlisted tool silently rather than failing.

Realistic effort: **~1 day.** The format adapter is a few hours; §6 is the rest.

---

## 1. Decide the basics

Before writing code, fix three things:

| Decision                  | Example                                  |
|---------------------------|------------------------------------------|
| Tool id (lowercase)       | `'aider'`                                |
| ID prefix (with `_`)      | `'aider_'`                               |
| Env var for the home dir  | `CHAT_RECALL_AIDER_HOME`                 |
| Default home dir          | `~/.aider`                               |

The id prefix makes session ids globally unique across tools (Claude has
no prefix; everything else has one). The env var lets users relocate
their installs without editing code.

Add the tool id to `AiTool` in `packages/engine/src/core/live-session-scan.ts`:

```typescript
export type AiTool = 'claude' | 'gemini' | 'opencode' | 'codex' | 'agy' | 'cursor' | 'aider';
```

This is the FIRST edit outside your backend file, not the only one. See §6.

> Paths in the older parts of this guide say `src/core/…`. The repo is a
> monorepo now: read those as `packages/engine/src/core/…`.

---

## 2. Implement `ToolBackend`

Create `src/core/backends/aider.ts`. The interface is in
`src/core/tool-backend.ts`. Use one of the four existing backends as a
reference — `gemini.ts` and `codex.ts` are the closest analogues for
JSONL-style storage; `opencode.ts` shows the SQLite-backed shape.

```typescript
import type {
  ToolBackend,
  SessionLocation,
  SessionRef,
  ListSessionsOpts,
  ExtractTurnsOpts,
  LiveScanEditsResult,
  CanonicalEvent,
  EditDelta,
} from '../tool-backend.js';
import type { ExtractedTurns } from '../session-turns.js';
import type { SessionDiffResult } from '../session-replay.js';
import type { SessionOutcome } from '../session-outcome.js';
import type { SessionCommitsResult } from '../session-git.js';
import type { EditOp } from '../live-session-scan.js';

import { computeOutcomeAny } from '../session-multi-tool.js';
import { getSessionCommits } from '../session-git.js';
import {
  extractTurnsFromEvents,
  liveScanEditsFromEvents,
  replayFromEvents,
} from '../generic-engine.js';

const PREFIX = 'aider_';

export class AiderBackend implements ToolBackend {
  readonly id = 'aider' as const;
  readonly idPrefix = PREFIX;

  homeDir(): string {
    return process.env.CHAT_RECALL_AIDER_HOME || join(homedir(), '.aider');
  }

  isAvailable(): boolean {
    return existsSync(this.sessionsDir());
  }

  // ── ID handling — boilerplate, copy from any existing backend ───
  matchesId(id: string): boolean { return id.startsWith(PREFIX); }
  toRawId(id: string): string { return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id; }
  toPrefixedId(rawId: string): string { return rawId.startsWith(PREFIX) ? rawId : PREFIX + rawId; }

  // ── Storage layout — one method per directory you read ──────────
  sessionsDir(): string { return join(this.homeDir(), 'sessions'); }

  // ── Session location + listing ──────────────────────────────────
  findSession(id: string): SessionLocation | null { /* walk sessionsDir() */ }
  listSessions(opts: ListSessionsOpts = {}): SessionRef[] { /* enumerate, sort by mtime */ }

  // ── 1. Format adapter — the only format-specific code you write ─
  readEvents(rawId: string): CanonicalEvent[] {
    // Read your tool's native transcript format, walk every event,
    // emit one CanonicalEvent per logical event:
    //   - 'user' for user prompts (skip system reminders / wrappers)
    //   - 'assistant_text' for assistant text replies
    //   - 'tool_use' for tool invocations (set toolName, toolUseId, toolInput)
    //   - 'tool_result' for tool outputs (set resultBody, resultIsError)
    return [];
  }

  // ── 2. File-touching tool map ───────────────────────────────────
  readonly fileToolMap: Record<string, EditOp> = {
    // 'edit_tool': 'edit',
    // 'write_tool': 'write',
    // 'read_tool': 'read',
  };

  // ── 3. Inline-diff extractor (optional, for replay) ─────────────
  extractEditDelta(toolName: string, input: unknown): EditDelta | null {
    // Return { before, after } when the tool input carries the diff
    // (most edit tools do — input has old_string/new_string or content).
    // Return null for tools whose mutation needs a separate replay path
    // (e.g. Codex's apply_patch, which carries a multi-file unified diff).
    return null;
  }

  // ── Wire-up — every method below is identical across backends ──
  extractTurns(id: string, opts: ExtractTurnsOpts = {}): ExtractedTurns {
    const events = this.readEvents(this.toRawId(id));
    return extractTurnsFromEvents(this.toPrefixedId(id), events, opts);
  }

  liveScanEdits(id: string): LiveScanEditsResult {
    const located = this.findSession(this.toRawId(id));
    if (!located) {
      return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: this.id };
    }
    const events = this.readEvents(this.toRawId(id));
    return liveScanEditsFromEvents(events, this.fileToolMap, {
      sessionId: this.toPrefixedId(id),
      tool: this.id,
      projectPath: located.projectPath,
      projectDir: located.projectDir,
      fileMtime: located.mtime,
      found: true,
    });
  }

  replay(id: string): SessionDiffResult {
    const located = this.findSession(this.toRawId(id));
    if (!located) {
      return { sessionId: this.toPrefixedId(id), found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };
    }
    const events = this.readEvents(this.toRawId(id));
    return replayFromEvents(this.toPrefixedId(id), events, this.fileToolMap, this.extractEditDelta.bind(this), {
      projectPath: located.projectPath,
      found: true,
    });
  }

  computeOutcome(id: string, opts?: { commitBufferMinutes?: number }): SessionOutcome {
    return computeOutcomeAny(this.toPrefixedId(id), opts);
  }
  getCommits(id: string, files: string[], startMs: number, endMs: number, bufferMinutes?: number): SessionCommitsResult {
    return getSessionCommits(this.toPrefixedId(id), files, startMs, endMs, bufferMinutes);
  }
}

export const aiderBackend = new AiderBackend();
```

Most of this is boilerplate. The interesting code is `readEvents` and
`fileToolMap`.

---

## 3. Register the backend

Edit `src/core/backends/index.ts`:

```typescript
import { aiderBackend, AiderBackend } from './aider.js';

export function bootstrapBackends(): void {
  registerBackend(claudeBackend);
  registerBackend(geminiBackend);
  registerBackend(opencodeBackend);
  registerBackend(codexBackend);
  registerBackend(aiderBackend);  // ← new
}

export { aiderBackend, AiderBackend };
```

That's the only line outside your new backend file.

---

## 4. Add tests

Use `src/core/backends/integration.test.ts` as the template. Write
fixtures in your tool's native format (no mocking the engine), then
exercise:

- `readEvents` produces `'user' | 'assistant_text' | 'tool_use' | 'tool_result'` events
- `extractTurns` returns the right turn kinds in order
- `liveScanEdits` picks up your file tools and skips reads correctly
- `replay` (if `extractEditDelta` is implemented) produces a unified diff
- `findSession` resolves both raw and prefixed ids
- `listSessions` returns mtime-desc, respects projectFilter / limit / sinceMs

Run:

```bash
npm run build
npx vitest run src/core/backends/integration.test.ts
```

---

## 5. Audit — confirm nothing is hardcoded

Run the audit greps. Each should return zero hits *outside* your new
backend file:

```bash
grep -rn "'\.aider'" src/ --include="*.ts" | grep -v 'core/backends/'
grep -rn "sessionId\.replace(/\^aider_/" src/ --include="*.ts"
grep -rn "tool === 'aider'\|tool !== 'aider'" src/ --include="*.ts" | grep -v 'core/backends/'
grep -rn "\`aider_\${" src/ --include="*.ts" | grep -v 'core/backends/'
```

If any return hits, you've leaked tool-specific knowledge into the
shared codebase. Move it into the backend.

---

## 6. The enumerations — the part that actually takes the time

The registry is genuinely tool-agnostic. What is not is the ~30 hand-written
tool lists scattered across the server, CLI and web client. Most are allowlists
that `continue` or `.filter()` past an unknown id, so a missed one does not
throw — the tool's data just never appears, and you find out days later.

The compiler catches only some of these. Exhaustive `switch` bodies over a
union, and `Record<Tool, …>` maps, fail the build — those are the good ones.
Explicit per-key spreads (`settings.ts`'s `mergeSources`) and `new Set([...])`
allowlists do not.

**Silent data loss if missed:**

| File | What breaks |
|---|---|
| `packages/server/src/services/sessions.ts` (`STORE_BACKED_TOOLS`) | sessions dropped from the local listing and project counts |
| `packages/server/src/routes/{sync-intents,sync-config,analytics,edits,team-artifacts}.ts` | ingest rejects the tool; filters return empty |
| `packages/engine/src/core/cached-timeline.ts` | excluded from the default timeline |
| `packages/engine/src/core/source-policy.ts` | the `<tool>.sessions` policy key is never generated |
| `packages/engine/src/core/home-approval.ts` | the home is never approved, so it never syncs |
| `packages/engine/src/core/extractor-version.ts` | sessions mis-attributed to `claude`, so a bump never re-ships them |
| `packages/server/src/routes/conversations.ts` | the prefix chain falls through to `claude` and renders with the wrong parser |

**Also needs the tool:** `settings.ts` (four coordinated edits — the interface,
the home override, the defaults, and BOTH explicit lines in `mergeSources`),
`home-discovery.ts`, `source-discovery.ts`, `tool-paths.ts`, `toolkit-sync.ts`,
`artifact-codec.ts`, `team-merge.ts`, `vault-source.ts`, `vault-client.ts`,
`packages/cli/src/{cli,mcp,verify-repair,install-skills}.ts`, and on the client
`services/tools.ts` plus a `--cr-tool-<id>` colour pair in BOTH theme blocks of
`index.css`.

`packages/server/client/src/services/tools.ts` is meant to be the client's only
edit point, and `Sidebar` / `ActivityTimeline` do derive from it — but a dozen
other components still hardcode their own union. Grep before you trust it.

**Test isolation.** Any test that exercises multi-tool discovery must set
`CHAT_RECALL_<TOOL>_HOME` for your tool too. `vault-client.test.ts` isolated
four of the six and silently walked the developer's real home for the rest.

### What you genuinely don't need to touch

- **MCP handlers.** `packages/cli/src/mcp.ts` routes every session-id-taking
  tool through `getBackendForId(id)?.method(...)`.
- **The generic engine** (`generic-engine.ts`) and the `live-session-scan.ts`
  dispatchers. Those are tool-agnostic.
- **The indexer / source plugins**, unless your tool exposes surface beyond
  sessions (skills, commands, agents, plans).

---

## Reference: where each backend lives

| Backend     | File                                       | Storage format                                      |
|-------------|--------------------------------------------|-----------------------------------------------------|
| Claude      | `src/core/backends/claude.ts`              | JSONL transcript per session under `projects/<dir>/`|
| Gemini      | `src/core/backends/gemini.ts`              | JSON or JSONL under `tmp/<sha>/chats/`              |
| OpenCode    | `src/core/backends/opencode.ts`            | SQLite at `<root>/opencode.db` (`session/message/part`) |
| Codex       | `src/core/backends/codex.ts`               | JSONL rollouts under `sessions/YYYY/MM/DD/`         |
| Antigravity | `src/core/backends/agy.ts`                 | JSONL under `brain/<id>/.system_generated/logs/`    |
| Cursor      | `src/core/backends/cursor.ts` (+ `cursor-store.ts`, `cursor-ide.ts`) | CLI: content-addressed blob store at `~/.cursor/chats/<md5>/<id>/store.db`. IDE: `~/.config/Cursor/User/globalStorage/state.vscdb` |
| **(yours)** | `src/core/backends/<your-tool>.ts`         | _whatever your tool uses_                           |

Cursor is the useful one to read if your tool has more than one surface, or if
its primary format can fail to decode: it reads `store.db` and degrades to a
lossier JSONL transcript rather than returning an empty session.
