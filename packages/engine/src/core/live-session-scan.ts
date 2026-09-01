/**
 * Live-scan helpers + a few cross-tool primitives the rest of the codebase
 * builds on:
 *
 *   - `detectTool(id)` — primitive prefix→tool mapping used everywhere.
 *   - `findSessionFile` (Claude), `findGeminiSessionFile`, `findCodexSessionFile`
 *     — file locators each backend uses to resolve a raw id.
 *   - `liveScanSessionEdits(id)` / `liveScanModifiedFiles(id)` /
 *     `liveScanRecentEdits(opts)` — registry-routed dispatchers that fan
 *     out to whichever backend owns the id (or to all backends, in the
 *     "recent" case).
 *
 * Per-tool *implementations* live in `src/core/backends/<tool>.ts` —
 * adding a fifth tool needs zero edits in this file.
 */

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { hasSubagentsDir } from '../parsers/session.js';
// Record-identity + union live in the shadow; cross-home merging must agree
// with shadow recovery on what "the same record" means, so it reuses that
// primitive rather than defining a second one.
import { mergeLineText } from '../transcript/shadow.js';
import { getBackendForId, listAvailableBackends } from './tool-backend.js';
import {
  claudeProjectDirs,
  geminiHomeDir,
  geminiTmpDirs,
  opencodeDbPath,
  opencodeDbPaths,
  codexHomeDir,
  codexSessionDirs,
  agyBrainDirs,
} from './tool-paths.js';
// Side-effect import: bootstraps the four ToolBackend implementations into
// the registry so getBackendForId works at call time. Loaded here because
// `liveScanSessionEdits` dispatches through the registry; without this,
// any caller that hasn't already imported a backend would see found:false.
// The cycle (live-session-scan → backends → live-session-scan) is safe
// under ESM because backends only USE the imports at function call time,
// not at module-init time.
import './backends/index.js';
import { resolveProjectDirName } from './project-dir-name.js';

export type AiTool = 'claude' | 'gemini' | 'opencode' | 'codex' | 'agy' | 'cursor';

// Path subdirs — defaults + env-var overrides come from `tool-paths.ts`
// so backends and this dispatcher share a single source of truth.

function lazyGeminiTmpDir(): string { return join(geminiHomeDir(), 'tmp'); }
function lazyGeminiProjectsJson(): string { return join(geminiHomeDir(), 'projects.json'); }
function lazyOpencodeDb(): string { return opencodeDbPath(); }
function lazyCodexSessionsDir(): string { return join(codexHomeDir(), 'sessions'); }

export type EditOp = 'edit' | 'write' | 'multi_edit' | 'notebook_edit' | 'read';

export interface SessionEdit {
  ts: number;          // epoch ms — falls back to file mtime when entry has no timestamp
  tsIso?: string;      // original ISO timestamp from the entry, if present
  sessionId: string;
  projectPath: string;
  file: string;
  op: EditOp;
  toolName: string;    // raw tool name from the tool's own taxonomy
  tool: AiTool;        // which AI tool produced the edit
  line: number;        // line number in transcript (claude) or 0 for stores w/o lines
  projectId?: string;  // logical project id (git:/ws:/path:…) — drives Activity's project filter + repo grouping
}

/**
 * Tool-of-origin for a session id. Routes through the registry — each
 * backend declares its `idPrefix` once, and this helper just asks
 * `getBackendForId` to do the lookup. Falls back to 'claude' for
 * anything that doesn't match a registered prefix (Claude has no
 * prefix; raw uuids land here).
 */
export function detectTool(sessionId: string): AiTool {
  return getBackendForId(sessionId)?.id ?? 'claude';
}

/**
 * Locate a Claude session's .jsonl file. Returns null when not present.
 * Kept for callers that specifically want the on-disk path; tool-aware
 * callers should use detectTool() and dispatch to the per-tool scanner.
 */
/**
 * A SCAN SCOPE: inside it, the session-file indexes below are built once and
 * reused; outside it, every lookup reads the filesystem exactly as it always
 * did.
 *
 * Caching is opt-in on purpose. These lookups answer "where is this session
 * right now", and a cache that outlives the question is a correctness bug
 * waiting to happen — a session created a moment ago must be findable. Rather
 * than guess a TTL that is short enough to be correct and long enough to be
 * useful, the caller states the window in which the answer cannot change.
 *
 * A sync walk is exactly such a window: it snapshots its list of sessions up
 * front, so a session appearing mid-walk was never part of that walk anyway.
 *
 * Nesting is counted, so an inner scope does not drop an outer one's index.
 *
 * SIBLING, NOT DUPLICATE: `withSessionReadCache` above shares this shape with a
 * shorter lifetime on purpose — it caches one session's TEXT for one derive,
 * where this caches PATHS for a whole walk. Paths are small and stable;
 * transcript text is neither, and a walk-long cache of it is the exact
 * out-of-memory bug that history warns about.
 */
let scanScopeDepth = 0;

export async function withSessionScanScope<T>(fn: () => Promise<T>): Promise<T> {
  scanScopeDepth++;
  try {
    return await fn();
  } finally {
    if (--scanScopeDepth === 0) {
      invalidateSessionFileIndex();
      invalidateGeminiSessionIndex();
    }
  }
}

export function findSessionFile(sessionId: string): LocatedSessionFile | null {
  return sessionFileIndex().get(sessionId)?.[0] ?? null;
}

/** One physical copy of a session transcript. */
export interface LocatedSessionFile {
  path: string;
  projectDir: string;
  /** Project path is encoded by replacing slashes with dashes. */
  projectPath: string;
}

/**
 * id → every home's copy of that session, built by LISTING the project
 * directories once instead of probing them per session.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * Both lookups used to walk every configured home and call `existsSync` in
 * every project directory, PER SESSION. On the maintainer's machine that is
 * 4 homes × 211 project directories ≈ 215 syscalls per lookup, and the sync
 * walk performs two lookups per session (`spansMultipleSources` then
 * `fileSize`) for 15,724 sessions — about 6.6 MILLION syscalls per walk.
 *
 * Measured: 62.8 seconds of pure filesystem work, to discover that 2 sessions
 * had changed and 2 spanned more than one home. An intent-triggered full walk
 * fires every 25–45 s, so the daemon simply never stopped walking — that, and
 * not the secret scan, is what held a core at 100%.
 *
 * Listing instead of probing inverts the cost: ~211 readdirs total, regardless
 * of how many sessions exist. The work stops scaling with corpus size, which
 * matters because corpus size only ever grows.
 *
 * ── Freshness ────────────────────────────────────────────────────────────
 * A short TTL, plus `invalidateSessionFileIndex()` for callers that must not
 * miss a file they just created. A stale entry can only ever mean "a session
 * created in the last few seconds is not listed yet"; paths never change under
 * a session, and content reads use the path, not the index. The sync walk
 * snapshots its ref list up front anyway, so a session appearing mid-walk was
 * never part of that walk.
 */
let indexCache: Map<string, LocatedSessionFile[]> | null = null;

/** Drop the index so the next lookup rebuilds it. */
export function invalidateSessionFileIndex(): void { indexCache = null; }

function sessionFileIndex(): Map<string, LocatedSessionFile[]> {
  if (indexCache) return indexCache;
  const byId = new Map<string, LocatedSessionFile[]>();
  const seenRoots = new Set<string>();
  // Home order is preserved so the FIRST entry stays the primary home's copy —
  // findSessionFile()'s original contract, and what project grouping and
  // titles rely on.
  for (const root of claudeProjectDirs()) {
    if (seenRoots.has(root) || !existsSync(root)) continue;
    seenRoots.add(root);
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      let names: string[];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const id = name.slice(0, -'.jsonl'.length);
        const located: LocatedSessionFile = {
          path: join(dir, name),
          projectDir: entry.name,
          projectPath: resolveProjectDirName(entry.name),
        };
        const prior = byId.get(id);
        if (prior) prior.push(located); else byId.set(id, [located]);
      }
    }
  }
  if (scanScopeDepth > 0) indexCache = byId;
  return byId;
}

/**
 * Resolve the actual content paths for a session — handles both the legacy
 * single-file format and the new subagents/ split format.
 *
 * The main transcript ALWAYS holds the primary thread's tool calls (Edit /
 * Write / Bash on the main agent), so it must be included even when a
 * `subagents/` dir exists — the subagent files only carry the spawned
 * agents' work. Returning subagents alone silently drops every main-thread
 * edit, which empties diff / files / commits / edits-timeline for any
 * session that ever used the Agent/Task tool.
 */
/**
 * EVERY home's copy of a session, primary home first.
 *
 * `findSessionFile` returns the first match and stops, which is right when a
 * session lives in exactly one home and wrong the moment it doesn't. A session
 * resumed under a different CLAUDE_CONFIG_DIR (or mid-consolidation between
 * profiles) exists under the SAME id in two homes holding DISJOINT records —
 * measured 2026-08-02: `~/.claude` 955 messages, `~/.claude-t2` 20 messages,
 * zero shared uuids. First-match silently returned the stale primary and the
 * live half was never read, indexed or synced.
 *
 * A session is a SET OF RECORDS, not a file to pick between. Callers that need
 * content use this and merge; callers that need one canonical path (project
 * grouping, titles) can still take the first.
 */
export function findSessionFiles(sessionId: string): LocatedSessionFile[] {
  // A copy of the list: callers have always received an array they may sort or
  // splice, and the index must not be mutated underneath the next lookup.
  const hit = sessionFileIndex().get(sessionId);
  return hit ? hit.slice() : [];
}

/**
 * One logical transcript file (the main JSONL, or one subagent sidecar) and
 * every physical copy of it across homes, primary first.
 */
export interface SessionContentGroup {
  /** Stable logical name — `main` or `subagents/<file>`. */
  name: string;
  paths: string[];
}

/**
 * Content paths for a session, GROUPED by logical file across all homes.
 *
 * Same ordering as the single-home version (main first, then subagents sorted)
 * so event line numbering is unchanged for the common one-home case. Copies of
 * the same logical file are grouped together so the caller can union their
 * records instead of picking one.
 */
export function resolveSessionContentGroups(sessionId: string): SessionContentGroup[] {
  const groups = new Map<string, string[]>();
  const add = (name: string, path: string) => {
    const list = groups.get(name);
    if (list) { if (!list.includes(path)) list.push(path); }
    else groups.set(name, [path]);
  };
  for (const located of findSessionFiles(sessionId)) {
    for (const p of resolveSessionContentPaths(located.path)) {
      // `main` for the transcript itself; sidecars keep their filename so the
      // same subagent from two homes lands in one group.
      add(p === located.path ? 'main' : `subagents/${basename(p)}`, p);
    }
  }
  // main first, then subagents in stable name order.
  const names = [...groups.keys()].sort((a, b) =>
    (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
  return names.map((name) => ({ name, paths: groups.get(name)! }));
}

/**
 * Read one group and return the UNION of its copies' records, deduped by
 * record uuid (falling back to the exact line). Reuses the transcript shadow's
 * merge so cross-home union and shadow recovery agree on record identity.
 *
 * `mtime` is the NEWEST copy's — a secondary home receiving the live writes
 * must make the session look fresh, or change detection never fires.
 *
 * NOTE, because it looks like a bug and isn't: the merged text can have FEWER
 * lines than the largest input. Message records (uuid-keyed) are always a strict
 * union, but `mergeLineText` collapses SINGLETON metadata (`mode`, `ai-title`,
 * `summary`, …) to the most recent — those describe current state, not history.
 * Verified on a real split session: primary 1082 lines / 818 uuids, secondary 83
 * lines / 61 uuids, merged 951 lines / 879 uuids — i.e. every one of the 879
 * distinct records survived and only duplicate metadata collapsed.
 *
 * A single copy is returned verbatim (no merge pass), so the one-home case is
 * byte-for-byte what it always was.
 */
/**
 * Opt-in, single-entry, explicitly-scoped read cache.
 *
 * Deriving one session's data re-reads its transcript from disk four times:
 * replaySessionAny, then computeOutcome (which reads twice internally — once
 * for extractTurns and once for replay), then extractTurnsAny. For the 36.8 MB
 * session on this developer's machine that is ~150 MB of reads per sync per
 * target, for one conversation.
 *
 * The cache is NOT ambient. It holds exactly one session's text and only while
 * a caller has opened a scope, because this file's history is an out-of-memory
 * crash: a long-lived cache of transcript text is the same shape of bug as the
 * sliced-string leak that took the daemon down. One entry, explicit lifetime,
 * cleared in a finally — so the worst case is one transcript resident during
 * the derive of that transcript, which was already true.
 *
 * The key includes mtime and byte length, so a file that changes mid-scope is
 * re-read rather than served stale.
 *
 * SIBLING, NOT DUPLICATE: `withSessionScanScope` below has the same
 * nesting-counter shape but a deliberately different lifetime. This one holds
 * one session's TEXT and is opened around that session's derive; that one holds
 * the path INDEX and is opened around a whole walk. They are not merged
 * precisely because giving transcript text a walk-long lifetime is the
 * out-of-memory bug this comment is about.
 */
let readScope: { key: string; value: { text: string; mtime: number } } | null = null;
let readScopeDepth = 0;

export function withSessionReadCache<T>(fn: () => T): T {
  readScopeDepth++;
  try {
    return fn();
  } finally {
    if (--readScopeDepth === 0) readScope = null;
  }
}

export function readSessionGroupText(group: SessionContentGroup): { text: string; mtime: number } {
  let key = '';
  if (readScopeDepth > 0) {
    // Cheap identity: paths plus each file's mtime and size. Costs one stat per
    // path, which we are about to do anyway, and catches an append mid-scope.
    const parts: string[] = [];
    for (const p of group.paths) {
      try { const st = statSync(p); parts.push(`${p}:${st.mtimeMs}:${st.size}`); }
      catch { parts.push(`${p}:missing`); }
    }
    key = parts.join('|');
    if (readScope && readScope.key === key) return readScope.value;
  }

  let text = '';
  let mtime = 0;
  for (const p of group.paths) {
    let raw: string;
    try { raw = readFileSync(p, 'utf-8'); } catch { continue; }
    try { mtime = Math.max(mtime, statSync(p).mtimeMs); } catch { /* ignore */ }
    text = text ? mergeLineText(text, raw).text : raw;
  }
  const out = { text, mtime };
  if (readScopeDepth > 0 && key) readScope = { key, value: out };
  return out;
}

export function resolveSessionContentPaths(sessionFile: string): string[] {
  if (!hasSubagentsDir(sessionFile)) return [sessionFile];
  const subDir = join(sessionFile.slice(0, -6), 'subagents');
  if (!existsSync(subDir)) return [sessionFile];
  const subPaths = readdirSync(subDir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .map(f => join(subDir, f));
  return [sessionFile, ...subPaths];
}

/**
 * Walk a session's transcript and yield every file-touching tool call.
 * Dispatches to the right per-tool implementation based on the session id
 * prefix. This is the same logic the indexer would record once a session is
 * closed — but run on demand so it works for the live session.
 */
export function liveScanSessionEdits(sessionId: string): {
  found: boolean;
  projectPath: string;
  projectDir: string;
  edits: SessionEdit[];
  fileMtime: number;
  tool: AiTool;
} {
  // Route through the registry — every backend implements liveScanEdits
  // directly, so this stays tool-agnostic. The detectTool() fallback
  // covers the brief window during module-init before backends register.
  const backend = getBackendForId(sessionId);
  if (backend) return backend.liveScanEdits(sessionId);
  const tool = detectTool(sessionId);
  return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool };
}

let geminiProjectMapCache: Map<string, string> | null = null;
function loadGeminiProjectMap(): Map<string, string> {
  if (geminiProjectMapCache) return geminiProjectMapCache;
  const map = new Map<string, string>();
  const projectsPath = lazyGeminiProjectsJson();
  if (existsSync(projectsPath)) {
    try {
      const data = JSON.parse(readFileSync(projectsPath, 'utf-8'));
      for (const path of Object.keys(data.projects || {})) {
        map.set(createHash('sha256').update(path).digest('hex'), path);
      }
    } catch { /* tolerate corrupt file */ }
  }
  geminiProjectMapCache = map;
  return map;
}

export function findGeminiSessionFile(sessionIdOrFileBase: string): GeminiLocatedFile | null {
  const idx = geminiIndex();
  // 1. Exact basename — the common case, free.
  const exact = idx.byBase.get(sessionIdOrFileBase);
  if (exact) return exact;
  // 2. Tail match. The CLI tacks a short hex tail onto the basename
  //    ("session-2026-05-06T06-37-de4e8d4c" → tail "de4e8d4c") and callers pass
  //    an id that STARTS WITH that tail. Indexed by tail, so instead of scanning
  //    every file we probe the query's own prefixes — at most ~32 map lookups.
  for (let len = Math.min(sessionIdOrFileBase.length, 64); len >= 4; len--) {
    const hit = idx.byTail.get(sessionIdOrFileBase.slice(0, len));
    if (hit) return hit;
  }
  // 3. The id stored INSIDE the file. Needed because the indexer used
  //    `content.sessionId || basename(file)`. This is the step that used to
  //    open and parse EVERY chat file in EVERY project on EVERY lookup — 5,246
  //    gemini sessions × the whole corpus, measured at 30.4 seconds per sync
  //    walk. Now each file is read at most once per index generation.
  return geminiInnerIdIndex(idx).get(sessionIdOrFileBase) ?? null;
}

export interface GeminiLocatedFile {
  path: string;
  projectDir: string;
  projectPath: string;
  format: 'json' | 'jsonl';
}

interface GeminiIndex {
  byBase: Map<string, GeminiLocatedFile>;
  byTail: Map<string, GeminiLocatedFile>;
  all: GeminiLocatedFile[];
  /** Built on first miss only — it costs one read per file. */
  byInnerId: Map<string, GeminiLocatedFile> | null;
}

let geminiCache: GeminiIndex | null = null;

/** Drop the Gemini index so the next lookup rebuilds it. */
export function invalidateGeminiSessionIndex(): void { geminiCache = null; }

function geminiIndex(): GeminiIndex {
  if (geminiCache) return geminiCache;
  const byBase = new Map<string, GeminiLocatedFile>();
  const byTail = new Map<string, GeminiLocatedFile>();
  const all: GeminiLocatedFile[] = [];
  const projMap = loadGeminiProjectMap();
  const isGeminiChat = (f: string) =>
    f.startsWith('session-') && (f.endsWith('.json') || f.endsWith('.jsonl'));
  // Homes in order, first winner kept: a session present in two profiles must
  // resolve to the primary, exactly as the sequential search did.
  for (const tmpRoot of geminiTmpDirs()) {
    if (!existsSync(tmpRoot)) continue;
    let projs;
    try { projs = readdirSync(tmpRoot, { withFileTypes: true }); } catch { continue; }
    for (const proj of projs) {
      if (!proj.isDirectory()) continue;
      const chats = join(tmpRoot, proj.name, 'chats');
      if (!existsSync(chats)) continue;
      let files: string[];
      try { files = readdirSync(chats); } catch { continue; }
      for (const f of files) {
        if (!isGeminiChat(f)) continue;
        const base = f.replace(/\.jsonl?$/, '');
        const located: GeminiLocatedFile = {
          path: join(chats, f),
          projectDir: proj.name,
          projectPath: projMap.get(proj.name) || '',
          format: f.endsWith('.jsonl') ? 'jsonl' : 'json',
        };
        all.push(located);
        if (!byBase.has(base)) byBase.set(base, located);
        const tail = base.split('-').pop() || '';
        if (tail.length >= 4 && !byTail.has(tail)) byTail.set(tail, located);
      }
    }
  }
  const built: GeminiIndex = { byBase, byTail, all, byInnerId: null };
  if (scanScopeDepth > 0) geminiCache = built;
  return built;
}

function geminiInnerIdIndex(idx: GeminiIndex): Map<string, GeminiLocatedFile> {
  if (idx.byInnerId) return idx.byInnerId;
  const byInnerId = new Map<string, GeminiLocatedFile>();
  for (const located of idx.all) {
    try {
      const innerId = readGeminiSessionIdFromFile(located.path, located.format);
      if (innerId && !byInnerId.has(innerId)) byInnerId.set(innerId, located);
    } catch { /* skip */ }
  }
  idx.byInnerId = byInnerId;
  return byInnerId;
}

/** Read only the first `bytes` of a file — session transcripts run into the
 *  hundreds of MB, so anything that just needs the head must never
 *  readFileSync the whole thing (that is what OOM-killed the watch daemon). */
export function readHeadSync(path: string, bytes = 65536): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf-8', 0, n);
  } finally { closeSync(fd); }
}

/** Pull the sessionId out of either format without reading the whole file. */
function readGeminiSessionIdFromFile(path: string, format: 'json' | 'jsonl'): string | null {
  if (format === 'json') {
    try { return JSON.parse(readFileSync(path, 'utf-8'))?.sessionId ?? null; } catch { return null; }
  }
  // .jsonl — only the first line (metadata) carries sessionId.
  try {
    const head = readHeadSync(path).split('\n', 1)[0] || '';
    return JSON.parse(head)?.sessionId ?? null;
  } catch { return null; }
}

interface GeminiMessage {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: unknown;
  text?: string;
  toolCalls?: unknown[];
  thoughts?: unknown;
  model?: string;
}

/** Largest single JSONL event line the parsers will JSON.parse. Real chat
 *  messages top out in the KBs; batch/bot runs have been observed logging a
 *  349MB single line (an entire transcript embedded in one message —
 *  session-2026-05-20T16-02-faa2393f), and JSON.parse of that alone needs
 *  >1GB of heap. Lines over this budget are skipped, not parsed. */
export const MAX_EVENT_LINE_BYTES = 8 * 1024 * 1024;

/** Yield messages from either `.json` (single blob) or `.jsonl` (line per event). */
export function readGeminiMessages(path: string, format: 'json' | 'jsonl'): GeminiMessage[] {
  if (format === 'json') {
    try {
      const json = JSON.parse(readFileSync(path, 'utf-8'));
      return Array.isArray(json.messages) ? json.messages as GeminiMessage[] : [];
    } catch { return []; }
  }
  // .jsonl — first line is metadata, subsequent lines are messages or
  // mongo-style {"$set": ...} updates we skip.
  const out: GeminiMessage[] = [];
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch { return out; }
  let isFirst = true;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    if (isFirst) { isFirst = false; continue; } // metadata header
    if (line.length > MAX_EVENT_LINE_BYTES) continue; // see constant's doc — skip, don't die
    let obj: GeminiMessage;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (!obj.type) continue; // skip $set updates
    out.push(obj);
  }
  return out;
}

// ── Codex ──────────────────────────────────────────────────────────

export function findCodexSessionFile(sessionId: string): { path: string; projectPath: string } | null {
  // Every configured Codex home, not just the primary — a session resumed under
  // a second profile lives in that profile's sessions/ tree, and searching only
  // the first would report it missing.
  for (const root of codexSessionDirs()) {
    const found = findCodexSessionFileIn(root, sessionId);
    if (found) return found;
  }
  return null;
}

function findCodexSessionFileIn(root: string, sessionId: string): { path: string; projectPath: string } | null {
  if (!existsSync(root)) return null;

  // Walk YYYY/MM/DD directories
  for (const year of readdirSync(root, { withFileTypes: true })) {
    if (!year.isDirectory()) continue;
    const yearPath = join(root, year.name);
    for (const month of readdirSync(yearPath, { withFileTypes: true })) {
      if (!month.isDirectory()) continue;
      const monthPath = join(yearPath, month.name);
      for (const day of readdirSync(monthPath, { withFileTypes: true })) {
        if (!day.isDirectory()) continue;
        const dayPath = join(monthPath, day.name);
        let files: string[];
        try { files = readdirSync(dayPath); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          // Filename ends with <uuid>.jsonl after the timestamp prefix
          if (f.includes(sessionId)) {
            return { path: join(dayPath, f), projectPath: '' };
          }
        }
      }
    }
  }

  // Fallback: brute-force recursive scan checking the first line id
  function scanDir(dir: string): { path: string; projectPath: string } | null {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const found = scanDir(join(dir, entry.name));
        if (found) return found;
      } else if (entry.name.endsWith('.jsonl')) {
        const p = join(dir, entry.name);
        try {
          const first = readFileSync(p, 'utf-8').split('\n')[0];
          if (!first) continue;
          const meta = JSON.parse(first);
          if (meta?.payload?.id === sessionId) {
            return { path: p, projectPath: meta?.payload?.cwd || '' };
          }
        } catch { /* skip */ }
      }
    }
    return null;
  }

  return scanDir(root);
}

/**
 * Convenience wrapper — returns just the deduped list of files modified
 * (write/edit/multi_edit/notebook_edit). Mirrors the shape the indexer's
 * `extra_json.filesModified` would produce. Tool-aware via session id prefix.
 */
export function liveScanModifiedFiles(sessionId: string): {
  found: boolean;
  files: string[];
  reads: string[];
  edits: SessionEdit[];
  projectPath: string;
  tool: AiTool;
} {
  const scan = liveScanSessionEdits(sessionId);
  const writeOps = new Set<EditOp>(['edit', 'write', 'multi_edit', 'notebook_edit']);
  const files = new Set<string>();
  const reads = new Set<string>();
  for (const e of scan.edits) {
    if (writeOps.has(e.op)) files.add(e.file);
    else if (e.op === 'read') reads.add(e.file);
  }
  return {
    found: scan.found,
    files: [...files],
    reads: [...reads],
    edits: scan.edits,
    projectPath: scan.projectPath,
    tool: scan.tool,
  };
}

/**
 * Live-scan every session whose transcript was modified since `sinceMs`,
 * across all three AI tools (Claude / Gemini / OpenCode).
 *
 * Used by recall_edits_timeline. Heavy when called with a wide window — we
 * scan transcripts top-to-bottom — but for the typical "last 24h" window
 * it's a handful of files.
 */
export function liveScanRecentEdits(opts: {
  sinceMs: number;
  pattern?: string;
  projectFilter?: string;
  limitSessions?: number;
  tools?: AiTool[]; // default: every registered backend
}): SessionEdit[] {
  const enabled = opts.tools ? new Set(opts.tools) : null;
  const needle = opts.pattern?.toLowerCase();
  const accept = (e: SessionEdit) => {
    if (e.ts < opts.sinceMs) return false;
    if (needle && !e.file.toLowerCase().includes(needle)) return false;
    return true;
  };

  const allEdits: SessionEdit[] = [];
  for (const backend of listAvailableBackends()) {
    if (enabled && !enabled.has(backend.id)) continue;
    const backendEdits = backend.collectRecentEdits({
      sinceMs: opts.sinceMs,
      projectFilter: opts.projectFilter,
      limitSessions: opts.limitSessions,
    });
    for (const e of backendEdits) if (accept(e)) allEdits.push(e);
  }
  allEdits.sort((a, b) => b.ts - a.ts);
  return allEdits;
}
