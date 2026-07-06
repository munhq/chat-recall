/**
 * Cache-first timeline builder for the Activity tab.
 *
 * Replaces a fresh filesystem walk (`liveScanRecentEdits`) with a query
 * over `compute_cache[kind='diff']`. The diff cache already contains
 * per-event `(ts, line, toolName, succeeded, …)` for every Edit/Write
 * tool call across all 4 AI tools — exactly what the timeline needs.
 *
 * Wins over the live scan:
 *   - O(N sessions in window × cached row size) decompression, no
 *     filesystem walk, no per-tool format-specific scanner.
 *   - Same source of truth as the per-conversation Diff tab — a row
 *     here will always agree with what you see when you open the
 *     conversation.
 *   - Only sessions whose mtime overlaps the requested window are
 *     considered; older sessions are skipped at the SQL layer.
 *
 * Falls back to the live scanner for sessions whose cache row is stale
 * (file mtime advanced past the cached row) or missing (precompute
 * hasn't reached them yet, or session is brand new).
 *
 * Uses the SAME `compute_cache` row format the precompute worker
 * writes, so this stays consistent without any new schema or migration.
 */

import { gunzipSync } from 'zlib';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createStore } from './store/index.js';
import { createMetadataCache } from './store/caches.js';
import type { SessionEdit, AiTool, EditOp } from './live-session-scan.js';
import { liveScanRecentEdits, detectTool } from './live-session-scan.js';
import { resolveProjectId } from './project-resolver.js';

/**
 * Does an edit belong to the selected project? A typed logical id
 * (`git:`/`ws:`/`path:`/`untracked:`) or privacy hash (`p_…`) is an exact
 * project_id match; a bare term (CLI/MCP) is a substring across id + path.
 * Mirrors the SQL in listSessionsModifiedSince / querySessionIndex so the
 * cached rows and the live-scanned rows filter identically.
 */
function editMatchesProjectFilter(e: SessionEdit, filter: string): boolean {
  if (filter.includes(':') || /^p_/.test(filter)) return e.projectId === filter;
  const f = filter.toLowerCase();
  return (e.projectId || '').toLowerCase().includes(f) || (e.projectPath || '').toLowerCase().includes(f);
}
import { claudeBackend } from './backends/claude.js';
import './backends/index.js'; // side-effect: registers backends

/**
 * Extract `cwd` from the first ~30 lines of a Claude transcript JSONL.
 * Claude writes a metadata-bearing line near the start that contains
 * the actual working directory the session ran in. This is the
 * authoritative project path; fall back to it for sessions that
 * memory_metadata hasn't indexed yet (the active session).
 *
 * Bounded read (~30 lines) so we don't pay for parsing a multi-MB
 * transcript just to find the project path.
 */
function readClaudeCwd(filePath: string): string | null {
  try {
    // Read just the head of the file — first 30 lines is enough.
    const head = readFileSync(filePath, 'utf-8').split('\n', 30);
    for (const line of head) {
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (typeof j.cwd === 'string' && j.cwd) return j.cwd;
      } catch { /* skip non-JSON lines */ }
    }
  } catch { /* file gone or unreadable */ }
  return null;
}

/**
 * Walk ~/.claude/projects/<encoded>/<id>.jsonl and build a (sessionId
 * → cwd) map for sessions not in memory_metadata. Used as a fallback
 * to fix the mangled project path live-scan emits for unindexed
 * (typically active) Claude sessions.
 *
 * Bounded by `sinceMs` — only stats files we'd care about, and only
 * cracks open the JSONL when the file is recent enough.
 */
function buildLiveClaudeCwdMap(sinceMs: number, alreadyKnown: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  const root = claudeBackend.projectsDir();
  if (!existsSync(root)) return out;
  try {
    for (const proj of readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const dir = join(root, proj.name);
      let files: string[];
      try { files = readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const sessionId = f.slice(0, -6);
        if (alreadyKnown.has(sessionId)) continue;
        const fp = join(dir, f);
        try {
          if (statSync(fp).mtimeMs < sinceMs) continue;
        } catch { continue; }
        const cwd = readClaudeCwd(fp);
        if (cwd) out.set(sessionId, cwd);
      }
    }
  } catch { /* permission errors etc — fall through */ }
  return out;
}

/**
 * Map a tool's raw event tool-name to the normalized `EditOp` the UI
 * understands. Each AI tool has its own taxonomy:
 *   - Claude:   Edit / Write / MultiEdit / NotebookEdit / Read
 *   - Codex:    apply_patch_(add|update|delete), shell write/edit
 *   - Gemini:   replace, write_file, …
 *   - OpenCode: edit/write rows (already normalized)
 *
 * Kept liberal — anything we can't classify falls back to 'edit' so the
 * row still shows up rather than disappearing silently.
 */
function toolNameToOp(name: string): EditOp {
  const n = name.toLowerCase();
  if (n.includes('multi') && n.includes('edit')) return 'multi_edit';
  if (n.includes('notebook')) return 'notebook_edit';
  if (n === 'write' || n === 'write_file' || n.endsWith('_write') || n === 'apply_patch_add') return 'write';
  if (n === 'read') return 'read';
  return 'edit';
}

interface CachedDiffShape {
  found: boolean;
  sessionId?: string;
  projectPath?: string;
  files: Array<{
    file: string;
    events: Array<{
      ts?: number;
      tsIso?: string;
      line?: number;
      toolName?: string;
      toolUseId?: string;
      succeeded?: boolean;
    }>;
  }>;
}

function decompressDiff(payloadGz: Buffer | null, payloadJson: string | null): CachedDiffShape | null {
  try {
    if (payloadGz) return JSON.parse(gunzipSync(payloadGz).toString('utf-8'));
    if (payloadJson) return JSON.parse(payloadJson);
  } catch { /* corrupt row */ }
  return null;
}

/**
 * Cache-first version of `liveScanRecentEdits`. Same return shape so
 * the route handler is interchangeable. Hybrid: cached rows for
 * sessions whose cache is fresh, live-scan for the rest (typically
 * just the actively-running session).
 */
export async function cachedRecentEdits(opts: {
  sinceMs: number;
  pattern?: string;
  projectFilter?: string;
  tools?: AiTool[];
  /**
   * Live transcript scan for sessions the cache missed. Default on (local
   * dashboard — catches the actively-running session). Server deployments
   * pass false: there are no transcripts on disk and walking the server
   * host's own ~/.claude would leak the operator's sessions into every
   * tenant's timeline.
   */
  liveFallback?: boolean;
}): Promise<SessionEdit[]> {
  const enabled = new Set<AiTool>(opts.tools ?? ['claude', 'gemini', 'opencode', 'codex']);
  const needle = opts.pattern?.toLowerCase();
  const out: SessionEdit[] = [];

  // Sessions to fall back on (cache miss / stale / mid-write).
  const fallbackIds = new Set<string>();

  const memStore = await createStore();
  const metaCache = await createMetadataCache();
  // (sessionId → real project_path). Live-scan's claude scanner builds
  // its `projectPath` by naively replacing every `-` with `/` in the
  // encoded dir name, which mangles legitimate hyphens — `chat-recall`
  // becomes `chat/recall`. memory_metadata stores the *real* cwd
  // extracted from inside the JSONL, so we use it as the source of
  // truth and overlay it onto whatever live-scan emits.
  const realProjectPaths = new Map<string, string>();
  try {
    for (const r of await memStore.listAllSessionProjectPaths()) {
      realProjectPaths.set(r.id, r.project_path);
    }
  } catch { /* ignore — overlay just won't be applied */ }

  try {
    // Find every session whose file mtime is within the window. Older
    // sessions can't have produced events newer than `sinceMs`, so we
    // skip them at the SQL layer rather than decompress and discard.
    // Push the project filter into SQL (indexed on project_id) instead of
    // substring-matching project_path in app code. The sidebar passes a
    // logical id (e.g. `git:github.com/hotmun/chat-recall`) which is NOT a
    // substring of the filesystem project_path — matching path was why a
    // git-grouped project always came back empty.
    const candidates = await memStore.listSessionsModifiedSince(opts.sinceMs, opts.projectFilter);

    for (const sess of candidates) {
      const tool = detectTool(sess.id);
      if (!enabled.has(tool)) continue;

      // Read the cached diff row. If it's stale (file mtime advanced
      // past the cached row), or missing entirely, defer to live scan.
      const row = await metaCache.getRawComputeRow(sess.id, 'diff');

      if (!row || row.mtime < sess.mtime) {
        fallbackIds.add(sess.id);
        continue;
      }

      const diff = decompressDiff(row.payload_gz, row.payload_json);
      if (!diff || !diff.files) continue;

      for (const f of diff.files) {
        if (!f.file) continue;
        if (needle && !f.file.toLowerCase().includes(needle)) continue;
        for (const e of f.events || []) {
          // Codex (and some Gemini paths) emit events without per-event
          // timestamps — `ts: 0`. We can't pretend each one happened at
          // a different moment, but dropping them entirely makes whole
          // sessions vanish from the timeline. Compromise: fall back to
          // the session file's mtime so all events from that session
          // cluster at the session's last-modified moment. That's also
          // what live-scan does in the same situation.
          let ts = Number(e.ts) || 0;
          if (!ts) ts = sess.mtime;
          if (ts < opts.sinceMs) continue;
          const toolName = e.toolName || 'Edit';
          const op = toolNameToOp(toolName);
          out.push({
            ts,
            tsIso: e.tsIso,
            sessionId: sess.id,
            projectPath: sess.project_path || diff.projectPath || '',
            projectId: sess.project_id || undefined,
            file: f.file,
            op,
            toolName,
            tool,
            line: Number(e.line) || 0,
          });
        }
      }
    }
  } finally {
    await memStore.close();
    await metaCache.close();
  }

  // Coverage gap: memory_metadata only knows about sessions the
  // memory-indexer has processed. Sessions written/touched between
  // indexer passes (notably the *currently-running* session and
  // recently-touched OpenCode/Claude transcripts) are invisible to the
  // SQL discovery above. Run a live-scan over the same window and
  // include any session the cached path missed entirely.
  //
  // For sessions present in BOTH paths, the cached events win because
  // they carry richer metadata (succeeded/applyError/toolUseId) that
  // the live-scan extractor doesn't always populate.
  //
  // Note: we deliberately do NOT pass `projectFilter` down to the
  // live-scan. Live-scan's claude path matches the filter against
  // Claude's encoded dir name (`-home-user-code-...`) which never
  // matches a real path filter (`/home/user/code/...`). We do the
  // uniform filter on the merged `SessionEdit.projectPath` below
  // (real paths are populated on every emitted edit).
  if (opts.liveFallback !== false) {
    const covered = new Set(out.map(e => e.sessionId));
    const live = liveScanRecentEdits({
      sinceMs: opts.sinceMs,
      pattern: opts.pattern,
      tools: opts.tools,
    });
    // Second-tier fallback for unindexed (typically *active*) Claude
    // sessions: read `cwd` from inside the JSONL. memory_metadata won't
    // know about them yet but the file itself does.
    const liveCwd = buildLiveClaudeCwdMap(opts.sinceMs, new Set(realProjectPaths.keys()));
    for (const e of live) {
      if (covered.has(e.sessionId)) continue;
      // Overlay real project_path: prefer memory_metadata, then JSONL
      // cwd, only fall back to live-scan's mangled value as a last
      // resort. Fixes the chat-recall → chat/recall mangling that the
      // live-scan claude decoder produces from encoded directory names.
      const real = realProjectPaths.get(e.sessionId) || liveCwd.get(e.sessionId);
      const path = real || e.projectPath;
      // Active/unindexed sessions have no stored project_id — resolve it
      // locally (git/fs exist here, this branch is local-only) so the
      // project filter below can match the same logical id the sidebar uses.
      const projectId = path ? resolveProjectId(path).id : undefined;
      out.push({ ...e, projectPath: path, projectId });
    }
  }

  // Uniform project filter over the merged set (cached rows were already
  // narrowed in SQL; live-scanned rows carry a locally-resolved projectId).
  // Matches on the logical project_id the sidebar sends — see
  // editMatchesProjectFilter.
  const filtered = opts.projectFilter
    ? out.filter(e => editMatchesProjectFilter(e, opts.projectFilter!))
    : out;

  filtered.sort((a, b) => b.ts - a.ts);
  return filtered;
}
