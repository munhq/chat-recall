/**
 * ToolBackend registry — single source of truth for every AI tool the
 * system supports (Claude Code, Gemini CLI, OpenCode, Codex).
 *
 * Anything that depends on tool identity (path roots, ID prefixes, message
 * shape, session-listing semantics) lives behind a `ToolBackend` and is
 * accessed through this registry. Adding a fifth tool means dropping in a
 * new ToolBackend implementation — zero edits anywhere else.
 *
 * Path roots are env-overridable so installs can be relocated:
 *   CHAT_RECALL_CLAUDE_HOME    → ~/.claude
 *   CHAT_RECALL_GEMINI_HOME    → ~/.gemini
 *   CHAT_RECALL_OPENCODE_DB    → ~/.local/share/opencode/opencode.db
 *   CHAT_RECALL_CODEX_HOME     → ~/.codex
 */

import type { AiTool, SessionEdit, EditOp } from './live-session-scan.js';
import type { ExtractedTurns } from './session-turns.js';
import type { SessionDiffResult } from './session-replay.js';
import type { SessionOutcome } from './session-outcome.js';
import type { SessionCommitsResult } from './session-git.js';

export type { AiTool };

// ── Canonical event shape (Phase 10 generic engine) ──────────────────
// Every AI tool stores transcripts in a different on-disk format, but the
// downstream operations (turn extraction, edit scanning, replay) only need
// the same conceptual events: user message, assistant text, tool call,
// tool result. Each backend's `readEvents()` parses its native format and
// emits this canonical shape; the shared engine in `generic-engine.ts`
// runs against `CanonicalEvent[]` and works for every tool unchanged.

export type CanonicalEventKind = 'user' | 'assistant_text' | 'tool_use' | 'tool_result' | 'summary';

export interface CanonicalEvent {
  kind: CanonicalEventKind;
  /** Epoch ms; falls back to file mtime when the event has no timestamp. */
  ts: number;
  /** Original ISO timestamp from the source, if present. */
  tsIso?: string;
  /** 1-based line number (jsonl/json formats); 0 for sqlite-backed tools. */
  line: number;

  // user / assistant_text
  text?: string;

  // tool_use
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;

  // tool_result
  resultBody?: string;
  resultIsError?: boolean;
  resultExitCode?: number;
  /** Bytes of the raw result body before any truncation. */
  resultBytes?: number;
  /** Optional shell-command string for `Bash`-style tool calls — used for command timelines. */
  command?: string;
}

/**
 * Diff data extractable from a single tool input.
 *
 * Two shapes:
 *   - Single-file (Claude Edit/Write, Gemini replace/write_file, OpenCode
 *     edit/write): one before/after pair, paired with whatever file path
 *     the tool input itself carries (extractFilePaths picks it up).
 *   - Multi-file (Codex apply_patch): a single tool_use carries a unified
 *     patch covering many files; the file paths come from the patch
 *     sections themselves, not the tool input. Backends that emit this
 *     shape return the per-file pairs directly.
 */
export type EditDelta = SingleFileEditDelta | MultiFileEditDelta;

export interface SingleFileEditDelta {
  before: string | null;
  after: string | null;
}

export interface MultiFileEditDelta {
  perFile: Array<{ file: string; before: string | null; after: string | null }>;
}

/** Type guard for the multi-file shape. */
export function isMultiFileDelta(d: EditDelta | null | undefined): d is MultiFileEditDelta {
  return !!d && 'perFile' in d;
}

/** Options for `ToolBackend.collectRecentEdits`. */
export interface CollectRecentEditsOpts {
  /** Earliest mtime to include (epoch ms). */
  sinceMs: number;
  /** Optional project-path substring filter (case-insensitive). */
  projectFilter?: string;
  /** Cap on sessions inspected per tool. */
  limitSessions?: number;
}

/** Where a session's data physically lives on disk. */
export interface SessionLocation {
  /** Absolute path to the file (or DB) holding the session. */
  path: string;
  /** Storage format. */
  format: 'jsonl' | 'json' | 'sqlite';
  /** Encoded directory name (Claude) or hash (Gemini); '' if not applicable. */
  projectDir: string;
  /** Decoded project working directory. '' if unknown. */
  projectPath: string;
  /** mtime of `path` in epoch ms. */
  mtime: number;
}

/** A session identified to the user — the shape `recall_recent` returns. */
export interface SessionRef {
  toolId: AiTool;
  /** Backend-internal id (no prefix). */
  rawId: string;
  /** Globally-unique id ('<uuid>' for Claude, '<prefix><id>' otherwise). */
  prefixedId: string;
  projectPath: string;
  projectDir: string;
  fullPath: string;
  /** Created time in ISO-8601. */
  created: string;
  /** Modified time in ISO-8601. */
  modified: string;
  /** Modified time in epoch ms. */
  mtime: number;
  firstPrompt: string;
  messageCount: number;
}

export interface ListSessionsOpts {
  /** Substring filter on project_path (case-insensitive). */
  projectFilter?: string;
  /** Hard cap on results returned (after sort by mtime desc). */
  limit?: number;
  /** Only include sessions whose mtime >= this (epoch ms). */
  sinceMs?: number;
}

export interface ExtractTurnsOpts {
  maxTurns?: number;
  assistantMax?: number;
}

/** Shape returned by `liveScanSessionEdits` — kept in sync with that helper. */
export interface LiveScanEditsResult {
  found: boolean;
  projectPath: string;
  projectDir: string;
  edits: SessionEdit[];
  fileMtime: number;
  tool: AiTool;
}

/**
 * One AI tool. Anything tool-specific in the codebase reaches through this
 * interface — there should be no `if (tool === 'gemini')` chains outside
 * backend implementations once the registry migration is complete.
 */
export interface ToolBackend {
  /** Stable tool id used everywhere. */
  readonly id: AiTool;

  /**
   * String prefix the system uses on raw ids to make them globally unique
   * across tools. Claude has '' (raw uuid is already unique). Other tools
   * use 'gemini_', 'opencode_', 'codex_'.
   */
  readonly idPrefix: string;

  /** User-facing label, e.g. shown as the assistant role in transcript views. */
  readonly displayName: string;

  /** Primary install root. Subpath helpers compose against this. */
  homeDir(): string;

  /** Whether the install or its data exists on disk. */
  isAvailable(): boolean;

  // ── ID handling ────────────────────────────────────────────────
  /** True if `id` (prefixed OR raw, when raw can be unambiguously identified) belongs to this backend. */
  matchesId(id: string): boolean;
  /** Strip the tool prefix from a prefixed id. Idempotent on raw ids. */
  toRawId(id: string): string;
  /** Add the tool prefix to a raw id. Idempotent on already-prefixed ids. */
  toPrefixedId(rawId: string): string;

  // ── Location ───────────────────────────────────────────────────
  findSession(id: string): SessionLocation | null;
  listSessions(opts?: ListSessionsOpts): SessionRef[];

  // ── Generic-engine inputs (Phase 10) ──────────────────────────
  /**
   * Parse the session's native storage format into canonical events.
   * The shared engine in `generic-engine.ts` consumes this shape, so
   * every backend looks identical from extractTurns/liveScanEdits/replay
   * down. Returns [] when the session can't be located.
   */
  readEvents(rawId: string): CanonicalEvent[];

  /** Tool-call name → normalized EditOp. Anything unmapped is non-file-touching. */
  readonly fileToolMap: Record<string, EditOp>;

  /**
   * For tools whose mutating tool_use carries the diff inline (Claude's
   * Edit/Write, Gemini's replace/write_file), extract before/after.
   * Optional — backends that pull the diff from elsewhere (Codex
   * apply_patch parses the body separately) can omit this and the
   * generic replay will fall back to event-counting only.
   */
  extractEditDelta?(toolName: string, input: unknown): EditDelta | null;

  /**
   * Optional fast-path for `computeOutcome` — backends whose store
   * already has a pre-computed file/line summary on the session row
   * (OpenCode stores `summary_files`/`summary_additions`/`summary_deletions`)
   * implement this so the outcome composer can skip a full replay walk.
   * Return `null` when no pre-computed stats are available for this id.
   */
  preComputedOutcomeStats?(rawId: string): {
    filesChanged: string[];
    totalLinesAdded: number;
    totalLinesRemoved: number;
  } | null;

  /**
   * Per-tool collector for the recent-edits timeline. Each backend
   * walks its own storage with whatever optimization fits — Claude
   * scans projects + subagents folders, OpenCode batches a single SQL
   * query across all parts, Codex re-attributes subagent edits to the
   * parent rollout. Edits are filtered by `accept` per item; respect
   * `sinceMs` and `projectFilter`.
   */
  collectRecentEdits(opts: CollectRecentEditsOpts): SessionEdit[];

  // ── Per-session operations ─────────────────────────────────────
  extractTurns(id: string, opts?: ExtractTurnsOpts): ExtractedTurns;
  liveScanEdits(id: string): LiveScanEditsResult;
  replay(id: string): SessionDiffResult;
  computeOutcome(id: string, opts?: { commitBufferMinutes?: number }): SessionOutcome;
  getCommits(
    id: string,
    files: string[],
    startMs: number,
    endMs: number,
    bufferMinutes?: number,
  ): SessionCommitsResult;
}

// ── Registry ─────────────────────────────────────────────────────────

const REGISTRY = new Map<AiTool, ToolBackend>();

export function registerBackend(backend: ToolBackend): void {
  REGISTRY.set(backend.id, backend);
}

export function getBackend(id: AiTool): ToolBackend {
  const b = REGISTRY.get(id);
  if (!b) {
    throw new Error(
      `No backend registered for tool '${id}'. Make sure ./backends/index.js was imported.`,
    );
  }
  return b;
}

export function tryGetBackend(id: AiTool): ToolBackend | null {
  return REGISTRY.get(id) ?? null;
}

/**
 * Resolve the backend that owns `id`. Tries every prefixed backend first
 * (so 'gemini_<uuid>' matches the Gemini backend, not Claude), then falls
 * through to the no-prefix backend (Claude). Returns null when no backend
 * recognizes `id` — typically because the registry hasn't been bootstrapped.
 */
export function getBackendForId(id: string): ToolBackend | null {
  ensureBootstrapped();
  for (const b of REGISTRY.values()) {
    if (b.idPrefix && b.matchesId(id)) return b;
  }
  for (const b of REGISTRY.values()) {
    if (b.idPrefix === '' && b.matchesId(id)) return b;
  }
  return null;
}

// ── Lazy bootstrap ────────────────────────────────────────────────────
// Production registers all four backends via `./backends/index.js`. We
// resolve that module on first use (call-time, not import-time) to dodge
// circular-import races: `live-session-scan.ts` imports backends, which
// import `live-session-scan.ts` for helpers. Eager bootstrap during that
// chain reads `claudeBackend` etc. before they're defined.

let _bootstrapper: null | (() => void) = null;
let _bootstrapped = false;

/** Called once by ./backends/index.ts to register the deferred-bootstrap fn. */
export function _setRegistryBootstrapper(fn: () => void): void {
  _bootstrapper = fn;
}

function ensureBootstrapped(): void {
  if (_bootstrapped || REGISTRY.size > 0) return;
  if (_bootstrapper) {
    _bootstrapped = true; // set first to short-circuit reentrancy
    _bootstrapper();
  }
}

export function listAllBackends(): ToolBackend[] {
  ensureBootstrapped();
  return [...REGISTRY.values()];
}

export function listAvailableBackends(): ToolBackend[] {
  ensureBootstrapped();
  return [...REGISTRY.values()].filter((b) => b.isAvailable());
}

/** Reset state — for tests only. Production code never calls this. */
export function _resetRegistryForTests(): void {
  REGISTRY.clear();
  _bootstrapped = false;
}
