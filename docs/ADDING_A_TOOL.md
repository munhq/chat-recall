# Adding a new AI tool to chat-recall

chat-recall supports four AI coding tools today: Claude Code, Gemini CLI,
OpenCode, and Codex. Adding a fifth one is contained — all the per-tool
knowledge lives behind a single `ToolBackend` interface, and most of the
heavy lifting (turn extraction, file-edit scanning, diff replay) runs
through a generic engine that operates on canonical events.

This guide walks through the full integration. Estimated effort:
**~80 lines for the format adapter + ~10 lines for the maps + 1 line
in the bootstrap.** No edits anywhere else.

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

Add the tool id to `AiTool` in `src/core/live-session-scan.ts`:

```typescript
export type AiTool = 'claude' | 'gemini' | 'opencode' | 'codex' | 'aider';
```

That's the only edit outside your new backend file.

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

## What you don't need to do

- **No edits to MCP handlers.** The handlers in `src/mcp.ts` route every
  session-id-taking tool through `getBackendForId(id)?.method(...)`.
  Your new backend is automatically discoverable.
- **No edits to the indexer / source plugins** unless your tool exposes
  surface area beyond sessions (skills, plans, hooks). Sessions alone
  are wired in via the registry.
- **No edits to the generic engine** (`src/core/generic-engine.ts`) or
  to `live-session-scan.ts` / `session-multi-tool.ts`'s dispatchers.
  Those are tool-agnostic.

---

## Reference: where each backend lives

| Backend     | File                                       | Storage format                                      |
|-------------|--------------------------------------------|-----------------------------------------------------|
| Claude      | `src/core/backends/claude.ts`              | JSONL transcript per session under `projects/<dir>/`|
| Gemini      | `src/core/backends/gemini.ts`              | JSON or JSONL under `tmp/<sha>/chats/`              |
| OpenCode    | `src/core/backends/opencode.ts`            | SQLite at `<root>/opencode.db` (`session/message/part`) |
| Codex       | `src/core/backends/codex.ts`               | JSONL rollouts under `sessions/YYYY/MM/DD/`         |
| **(yours)** | `src/core/backends/<your-tool>.ts`         | _whatever your tool uses_                           |
