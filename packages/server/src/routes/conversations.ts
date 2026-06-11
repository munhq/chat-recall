/**
 * Conversation routes.
 */

import express from 'express';
import { getRecentSessions, getSessionPath, getSessionPaths, getRelatedItems, getSessionMetadata, getSessionIndex, hydrateSessions } from '../services/sessions.js';
import type { SessionIndexEntry } from '../services/sessions.js';
import { getConversation, getGeminiConversation, getOpenCodeConversation, getOpenCodeSubagents, getCodexConversation, getCodexSubagents, getSubagents } from '../services/parser.js';
import type { Subagent } from '../services/parser.js';
import {
  MetadataCache,
  OutcomeCache,
  createStore,
  createMetadataCache,
  createOutcomeCache,
  SummaryGenerator,
  parseSessionFile,
  loadSettings,
  liveScanModifiedFiles,
  type SessionDiffResult,
  getSessionCommits,
  computeOutcome,
  markPrompt,
  summarizeMarkers,
  findCodexSessionFile,
  codexBackend,
  extractTurnsAny,
  replaySessionAny,
  outcomeBadge,
  quickOutcomeStatus,
  quickStatusEmoji,
  quickOutcomeFromMtime,
  detectTool,
  isFresh,
  fingerprintFile,
  type CachedOutcome,
  type CachedOutcomeStatus,
} from '../imports.js';
import type { SourceType } from '../imports.js';
import { matchesPrefix } from '../utils/paths.js';
import { buildETag, maybeSendNotModified } from '../util/cacheable.js';
import { requireLocalMode, isServerMode } from '../util/mode.js';

const router = express.Router();

// Genuinely FS/model-dependent endpoints only exist in local mode: live
// file scans, raw transcript serving, summary regeneration. Everything
// else — diff, commits, outcome (+badges), markers, turns — serves from
// the synced compute_cache / session_outcome_cache rows in server mode
// (the CLI computes them; the server never recomputes).
router.use([
  '/:id/files-live', '/:id/raw', '/:id/regenerate-summary',
], requireLocalMode);

/**
 * The per-session features below — diff replay, git commits, outcome,
 * turns, markers — read Claude's tool_use shape directly from JSONL.
 * Codex (apply_patch shell calls), Gemini (different tool format), and
 * OpenCode (SQLite + tool parts) need their own implementations and
 * aren't wired up yet, so for now we short-circuit to a graceful empty
 * payload instead of 404. The UI's tab panels render an empty state
 * naturally; the network tab stays clean.
 */
function isNonClaude(id: string): boolean {
  return id.startsWith('codex_') || id.startsWith('gemini_') || id.startsWith('opencode_');
}

function emptyDiff(id: string) {
  return { sessionId: id, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };
}

function emptyOutcome(id: string) {
  return {
    sessionId: id,
    found: true,
    status: 'unknown',
    reason: 'outcome analysis not yet implemented for this AI tool',
    startMs: 0, endMs: 0,
    decisions: [], blockers: [], claimReaction: {},
    prompts: [],
    promptMarkers: { total: 0, interrupt: 0, frustrated: 0, correction: 0, approval: 0, question: 0, directive: 0, clarification_request: 0, peakIntensity: 0 },
    commits: { sessionId: id, startMs: 0, endMs: 0, repos: [], totalCommits: 0 },
    fileCount: 0, filesChanged: [], totalLinesAdded: 0, totalLinesRemoved: 0,
  };
}

// GET /api/conversations/recent?limit=20&offset=0&project=...&tool=...&since_hours=...
//
// Single SQL query against `memory_metadata` (sorted by `idx_memory_mtime`).
// No filesystem walk, no JS sort, no in-process index cache — the page
// rows + total count both come back in <5ms even on a 10k-session install.
//
// Falls back to the legacy filesystem walk only when the index is empty
// (fresh install before the auto-indexer has populated anything).
router.get('/recent', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 20, 200));
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    // `project` is now a logical project_id (e.g. `git:github.com/me/repo`,
    // `ws:personal`). The legacy path-prefix mode has been removed; sidebar
    // and any external caller must pass the id from `/api/projects/tree`.
    const projectIdFilter = req.query.project as string | undefined;
    const toolFilter = req.query.tool as string | undefined;
    const sinceHoursRaw = req.query.since_hours as string | undefined;
    const sinceHours = sinceHoursRaw ? Number(sinceHoursRaw) : undefined;
    const sinceMs = sinceHours && Number.isFinite(sinceHours) && sinceHours > 0
      ? Date.now() - sinceHours * 3600 * 1000
      : undefined;
    // Untracked sessions (PR-bot worktrees, /tmp scratch, empty project_id)
    // are hidden from the unfiltered feed by default. Explicit
    // `project=untracked:all` or `?include_untracked=1` opts back in.
    const includeUntracked =
      req.query.include_untracked === '1' ||
      req.query.include_untracked === 'true' ||
      projectIdFilter === 'untracked:all' ||
      (typeof projectIdFilter === 'string' && projectIdFilter.startsWith('path:'));

    const store = await createStore();
    let totalAfterFilter: number;
    let pageEntries: SessionIndexEntry[];
    try {
      const { rows, total } = await store.querySessionIndex({
        limit, offset, projectIdFilter, toolFilter, sinceMs, includeUntracked,
      });

      // Empty index → fallback to filesystem walk so we don't return
      // an empty list during the first run before indexing completes.
      // Local mode only: a server deployment must never walk the server
      // host's own ~/.claude (that would leak the operator's sessions
      // into a tenant's view).
      if (total === 0 && offset === 0 && !projectIdFilter && !toolFilter && !sinceMs && !isServerMode()) {
        const walked = await getSessionIndex();
        const slice = walked.slice(0, limit);
        const sessions = await hydrateSessions(slice);
        return res.json({
          sessions,
          count: sessions.length,
          total: walked.length,
          offset: 0,
          limit,
          hasMore: walked.length > limit,
          source: 'fs-walk-fallback',
        });
      }

      totalAfterFilter = total;
      pageEntries = rows.map(r => {
        let extra: Record<string, unknown> = {};
        try { extra = r.extra_json ? JSON.parse(r.extra_json) : {}; } catch {}
        const tool = (extra.tool as SessionIndexEntry['tool']) || 'claude';
        return {
          sessionId: r.id,
          projectPath: r.project_path || '',
          mtime: r.mtime || 0,
          tool,
          filePath: r.file_path || undefined,
          preIndexedFirstPrompt: r.content_preview || undefined,
        };
      });
    } finally {
      await store.close();
    }

    // Hydrate firstPrompts only for the page rows. Most are already in
    // session_metadata cache so this is just N small SQLite reads.
    const sessions = await hydrateSessions(pageEntries);

    res.json({
      sessions,
      count: sessions.length,
      total: totalAfterFilter,
      offset,
      limit,
      hasMore: offset + sessions.length < totalAfterFilter,
    });
  } catch (error) {
    console.error('Recent sessions error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get recent sessions',
    });
  }
});

// GET /api/conversations/:id/files-live
// Live transcript scan of the session's tool_uses — works on the active
// session even though the indexer hasn't run yet.
router.get('/:id/files-live', async (req, res) => {
  try {
    const { id } = req.params;
    const live = liveScanModifiedFiles(id);
    if (!live.found) return res.status(404).json({ error: 'Session not found' });

    // Bucket by extension to mirror the MCP tool's response shape.
    const byExt: Record<string, string[]> = {};
    for (const f of live.files) {
      const ext = f.includes('.') ? f.split('.').pop()!.toLowerCase() : '(no ext)';
      (byExt[ext] = byExt[ext] || []).push(f);
    }

    res.json({
      sessionId: id,
      tool: live.tool,
      projectPath: live.projectPath,
      files: live.files,
      reads: live.reads,
      filesByExt: byExt,
      edits: live.edits.map(e => ({
        ts: e.ts,
        tsIso: e.tsIso,
        file: e.file,
        op: e.op,
        toolName: e.toolName,
        tool: e.tool,
        line: e.line,
      })),
      source: 'live',
    });
  } catch (error) {
    console.error('Files-live error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to live-scan session',
    });
  }
});

// GET /api/conversations/:id/diff
// Per-file cumulative diff replayed from Edit/Write/MultiEdit/NotebookEdit
// tool calls. Optional ?file=<absolute path> narrows to one file.
router.get('/:id/diff', async (req, res) => {
  try {
    const { id } = req.params;
    const fileFilter = (req.query.file as string | undefined)?.trim() || undefined;

    // SaaS read pattern: never block on compute. Serve fresh → stale → 202.
    const resolved = await resolveSessionForBadge(id);

    // Fresh hit
    let result: SessionDiffResult | null = null;
    if (resolved) {
      result = await heavyCacheGet<SessionDiffResult>(`diff:${id}`, resolved.mtime);
    }

    // Stale hit
    if (!result) {
      const stale = await getStaleHeavy<SessionDiffResult>(id, 'diff');
      if (stale) {
        if (resolved && stale.mtime !== resolved.mtime) {
          enqueueRefresh('diff', id, resolved.mtime);
        }
        result = stale.data;
      }
    }

    // No cache at all
    if (!result) {
      if (resolved) {
        enqueueRefresh('diff', id, resolved.mtime);
        return res.status(202).json({ sessionId: id, status: 'computing', message: 'Diff is being computed in the background.' });
      }
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!result.found) return res.status(404).json({ error: 'Session not found' });
    // ETag/Cache-Control: payload is immutable per (sessionId, mtime, fileFilter).
    if (resolved) {
      const etag = buildETag([id, 'diff', resolved.mtime, fileFilter || '']);
      if (maybeSendNotModified(req, res, etag)) return;
    }
    const files = fileFilter ? result.files.filter(f => f.file === fileFilter) : result.files;
    res.json({
      sessionId: id,
      projectPath: result.projectPath,
      totalLinesAdded: result.totalLinesAdded,
      totalLinesRemoved: result.totalLinesRemoved,
      files: files.map(f => ({
        file: f.file,
        diff: f.diff,
        linesAdded: f.linesAdded,
        linesRemoved: f.linesRemoved,
        reverted: f.reverted,
        succeededEvents: f.succeededEvents,
        failedEvents: f.failedEvents,
        initialKnown: f.initialKnown,
        events: f.events.map(e => ({
          ts: e.ts,
          tsIso: e.tsIso,
          line: e.line,
          toolName: e.toolName,
          toolUseId: e.toolUseId,
          succeeded: e.succeeded,
          toolError: e.toolError,
          applyError: e.applyError,
          editsCount: e.edits?.length,
          writeBytes: e.content?.length,
        })),
      })),
    });
  } catch (error) {
    console.error('Diff error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to compute diff' });
  }
});

// GET /api/conversations/:id/commits
// Git commits (across all detected repos) that landed during the session window.
router.get('/:id/commits', async (req, res) => {
  try {
    const { id } = req.params;
    const resolved = await resolveSessionForBadge(id);

    // Fresh hit
    if (resolved) {
      const fresh = await heavyCacheGet<unknown>(`commits:${id}`, resolved.mtime);
      if (fresh) {
        const etag = buildETag([id, 'commits', resolved.mtime]);
        if (maybeSendNotModified(req, res, etag)) return;
        return res.json(fresh);
      }
    }

    // Stale hit — return prior result, refresh in background.
    const stale = await getStaleHeavy<unknown>(id, 'commits');
    if (stale) {
      if (resolved && stale.mtime !== resolved.mtime) {
        enqueueRefresh('commits', id, resolved.mtime);
        return res.json({ ...(stale.data as object), _stale: true, _staleMtime: stale.mtime, _currentMtime: resolved.mtime });
      }
      return res.json(stale.data);
    }

    // No cache at all → enqueue + 202.
    if (resolved) {
      enqueueRefresh('commits', id, resolved.mtime);
      return res.status(202).json({ sessionId: id, status: 'computing', message: 'Commits are being computed in the background.' });
    }
    return res.status(404).json({ error: 'Session not found' });
  } catch (error) {
    console.error('Commits error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to compute commits' });
  }
});

// GET /api/conversations/:id/outcome
// Structured outcome: status, decisions, blockers, claim/reaction, markers.
// Cached by sessionId + mtime so re-opening a session's Outcome tab
// doesn't re-run extractTurns + replaySession + getSessionCommits.
router.get('/:id/outcome', async (req, res) => {
  try {
    const { id } = req.params;

    // SaaS-correct read path:
    //   1. Cache hit at current mtime → serve immediately.
    //   2. Stale row (older mtime) → serve stale + enqueue async refresh.
    //   3. No row at all → enqueue + 202 "computing" (rare; precompute
    //      worker fills these proactively for ALL sessions in background).
    // The compute path is NEVER on the request path. Reads are O(1).
    const resolved = await resolveSessionForBadge(id);

    // Step 1: fresh hit
    if (resolved) {
      const fresh = await heavyCacheGet<unknown>(`outcome:${id}`, resolved.mtime);
      if (fresh) {
        const etag = buildETag([id, 'outcome', resolved.mtime]);
        if (maybeSendNotModified(req, res, etag)) return;
        return res.json(fresh);
      }
    }

    // Step 2: stale hit (any mtime). Serve immediately, refresh async.
    // No ETag on stale responses — they're transient by definition.
    const stale = await getStaleHeavy<unknown>(id, 'outcome');
    if (stale && resolved && stale.mtime !== resolved.mtime) {
      enqueueRefresh('outcome', id, resolved.mtime);
      return res.json({ ...(stale.data as object), _stale: true, _staleMtime: stale.mtime, _currentMtime: resolved.mtime });
    }
    if (stale) {
      // No resolved info but we have stale — serve it.
      return res.json(stale.data);
    }

    // Step 3: no cache at all. Enqueue and tell the client "try again
    // shortly". 202 Accepted communicates this without polluting the
    // success path. Client should backoff-poll until it gets a 200.
    if (resolved) {
      enqueueRefresh('outcome', id, resolved.mtime);
      return res.status(202).json({
        sessionId: id,
        status: 'computing',
        message: 'Outcome is being computed in the background. Retry in a moment.',
      });
    }
    return res.status(404).json({ error: 'Session not found' });
  } catch (error) {
    console.error('Outcome error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read outcome' });
  }
});

/**
 * Two-tier cache for heavyweight per-session computations
 * (outcome, diff, commits, markers).
 *
 *   L1: in-process LRU (this map)         — sub-ms hits, lost on restart
 *   L2: SQLite `compute_cache` table       — survives restarts, ~1ms hits
 *
 * `heavyCacheGet` checks L1, then L2 (and warms L1 on L2 hit).
 * `heavyCacheSet` writes both. SQLite ceiling of 2MB per payload keeps
 * the DB from bloating on pathological diffs; oversize payloads stay
 * L1-only (caller treats this as "best effort persistence").
 *
 * mtime is the freshness invalidator — same key + different mtime → miss.
 */
const HEAVY_CACHE = new Map<string, { mtime: number; data: unknown }>();
const HEAVY_CACHE_MAX = 1000;
function parseHeavyKey(key: string): { sessionId: string; kind: string } | null {
  const idx = key.indexOf(':');
  if (idx < 0) return null;
  return { kind: key.slice(0, idx), sessionId: key.slice(idx + 1) };
}
// Singleton MetadataCache for the heavy-cache L2. Each `new
// MetadataCache()` opens a SQLite connection AND runs schema init
// (CREATE TABLE IF NOT EXISTS x N, ALTER TABLE x N) — measured at
// ~1-2s on first invocation. Reusing one instance across all heavy
// cache reads/writes drops the L2 hit cost from 1.7s to <1ms after the
// first warm-up. Critical for active sessions whose mtime moves often
// and miss L1 frequently.
let _heavyMetadataCache: MetadataCache | null = null;
function getHeavyMetadataCache(): MetadataCache {
  if (!_heavyMetadataCache) _heavyMetadataCache = new MetadataCache();
  return _heavyMetadataCache;
}

async function heavyCacheGet<T>(key: string, mtime: number): Promise<T | null> {
  // Server mode: L2 is the tenant-scoped store (synced compute_cache rows,
  // Postgres or SQLite per deployment). The in-process L1 is skipped — its
  // keys aren't tenant-qualified and a driver hit is ~1ms anyway.
  if (isServerMode()) {
    const parsed = parseHeavyKey(key);
    if (!parsed) return null;
    const cache = await createMetadataCache();
    try { return await cache.getCompute<T>(parsed.sessionId, parsed.kind, mtime); }
    finally { await cache.close(); }
  }
  const hit = HEAVY_CACHE.get(key);
  if (hit && hit.mtime === mtime) {
    HEAVY_CACHE.delete(key); HEAVY_CACHE.set(key, hit); // LRU bump
    return hit.data as T;
  }
  // L1 miss → try persistent L2.
  const parsed = parseHeavyKey(key);
  if (!parsed) return null;
  const persisted = getHeavyMetadataCache().getCompute<T>(parsed.sessionId, parsed.kind, mtime);
  if (persisted) {
    HEAVY_CACHE.set(key, { mtime, data: persisted });
    return persisted;
  }
  return null;
}
async function heavyCacheSet(key: string, mtime: number, data: unknown): Promise<void> {
  // Server mode never computes, so it never writes here — ingest writes
  // arrive through /api/sync. Guard anyway so a stray call can't poison
  // the local-SQLite cache inside a server deployment.
  if (isServerMode()) return;
  HEAVY_CACHE.set(key, { mtime, data });
  while (HEAVY_CACHE.size > HEAVY_CACHE_MAX) {
    const oldest = HEAVY_CACHE.keys().next().value;
    if (!oldest) break;
    HEAVY_CACHE.delete(oldest);
  }
  // Write-through to L2 — best effort, oversize payloads silently skipped.
  const parsed = parseHeavyKey(key);
  if (parsed) {
    try { getHeavyMetadataCache().setCompute(parsed.sessionId, parsed.kind, mtime, data); }
    catch { /* DB hiccup — L1 still serves */ }
  }
}

/**
 * Lookup the LATEST row for a session+kind regardless of its mtime. Used
 * by the SaaS-style read path: a request never blocks on compute, it
 * serves whatever cached row exists (even if stale), then asynchronously
 * triggers a refresh so the next request sees fresh data.
 */
async function getStaleHeavy<T>(sessionId: string, kind: string): Promise<{ data: T; mtime: number } | null> {
  if (isServerMode()) {
    const cache = await createMetadataCache();
    try { return await cache.getComputeStale<T>(sessionId, kind); }
    finally { await cache.close(); }
  }
  return getHeavyMetadataCache().getComputeStale<T>(sessionId, kind);
}

/**
 * Async-refresh queue: when a stale row is served, enqueue the recompute
 * so the worker handles it without blocking the response. Deduplicated
 * by (sessionId, kind) so a flood of stale-reads triggers ONE refresh.
 */
const REFRESH_PENDING = new Set<string>();
function enqueueRefresh(kind: 'outcome' | 'diff' | 'commits' | 'markers' | 'turns', sessionId: string, mtime: number): void {
  // Server mode has no FS/git to recompute from — the synced row is final
  // until the CLI pushes a fresher one.
  if (isServerMode()) return;
  const key = `${kind}:${sessionId}`;
  if (REFRESH_PENDING.has(key)) return;
  REFRESH_PENDING.add(key);
  // setImmediate so the HTTP response goes out first, then the heavy work
  // runs in the same process (no separate worker, no IPC). Errors don't
  // surface to the user — next read will see whatever the previous
  // (stale) cached row says, which is the correct fallback.
  setImmediate(() => {
    void (async () => {
      try {
        if (kind === 'outcome') {
          // computeOutcome + replaySessionAny are tool-agnostic (registry-routed).
          const out = computeOutcome(sessionId);
          if (out.found) await heavyCacheSet(`outcome:${sessionId}`, mtime, out);
        } else if (kind === 'diff') {
          const replay = replaySessionAny(sessionId);
          if (replay.found) await heavyCacheSet(`diff:${sessionId}`, mtime, replay);
        } else if (kind === 'commits') {
          let replay = await heavyCacheGet<SessionDiffResult>(`diff:${sessionId}`, mtime);
          if (!replay) {
            replay = replaySessionAny(sessionId);
            if (replay.found) await heavyCacheSet(`diff:${sessionId}`, mtime, replay);
          }
          if (replay.found) {
            const turns = extractTurnsAny(sessionId, { maxTurns: 50_000 });
            const result = getSessionCommits(
              sessionId,
              replay.files.map(f => f.file),
              turns.startMs || Date.now() - 86400_000,
              turns.endMs || Date.now(),
            );
            await heavyCacheSet(`commits:${sessionId}`, mtime, result);
          }
        } else if (kind === 'markers') {
          const turns = extractTurnsAny(sessionId, { maxTurns: 50_000 });
          if (turns.found) {
            const prompts = turns.turns
              .filter(t => t.kind === 'user' && t.text)
              .map(t => ({ line: t.line, ts: t.ts, tsIso: t.tsIso, ...markPrompt(t.text!) }));
            await heavyCacheSet(`markers:${sessionId}`, mtime, { sessionId, prompts, summary: summarizeMarkers(prompts) });
          }
        } else if (kind === 'turns') {
          const turns = extractTurnsAny(sessionId, { maxTurns: 50_000 });
          if (turns.found) await heavyCacheSet(`turns:${sessionId}`, mtime, turns);
        }
      } catch (err) {
        console.error(`Async refresh ${kind}:${sessionId.slice(0, 8)} failed:`, err);
      } finally {
        REFRESH_PENDING.delete(key);
      }
    })();
  });
}

// Single shared SQLite cache instance for outcome badges. Persistent across
// server restarts (sits in cache.db — see `src/core/paths.ts` for the
// canonical location) — once a session is classified the result lives
// forever unless the file mtime/size changes. This is what eliminates the
// "every refresh re-parses every session" pain.
let _outcomeCache: OutcomeCache | null = null;
function getOutcomeCache(): OutcomeCache {
  if (!_outcomeCache) _outcomeCache = new OutcomeCache();
  return _outcomeCache;
}

/**
 * (sessionId → filePath) map served from SQLite `memory_metadata`.
 *
 * Was: walked the filesystem via `getAllSessions()` — O(N projects × N
 * sessions), measured at ~1.9s for ~900 sessions. With a 10s TTL that
 * meant every conversation switch >10s after the previous one paid the
 * full walk again — directly responsible for the "2s loading" pain when
 * jumping between conversations.
 *
 * Now: single SQL query against the index the auto-indexer already
 * keeps fresh on every file change. <1ms cold, <1ms warm. The TTL is
 * kept (small in-process map) only to coalesce hundreds of badge calls
 * in the same render burst; it doesn't gate cold-path correctness.
 */
const SESSION_PATH_MAP_TTL_MS = 10_000;
let sessionPathCache: { map: Map<string, string>; expiresAt: number } | null = null;

async function getCachedSessionPathMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (sessionPathCache && sessionPathCache.expiresAt > now) {
    return sessionPathCache.map;
  }
  // Primary source: indexed sessions from memory_metadata. <1ms.
  const store = await createStore();
  const map = new Map<string, string>();
  try {
    for (const r of await store.listAllSessionPaths()) map.set(r.id, r.file_path);
  } finally {
    await store.close();
  }
  // Coverage fill: walk ~/.claude/projects/<encoded>/<id>.jsonl by
  // filename only (no parse) for any session id not yet in
  // memory_metadata. Active sessions and anything between indexer
  // passes show up here. Pure listdir is ~2ms for ~600 files —
  // cheaper than the 1-2s cost of the per-id `getSessionPath` fallback
  // that this avoids on subsequent requests.
  try {
    const { readdirSync } = await import('fs');
    const { join } = await import('path');
    const { claudeBackend } = await import('../imports.js');
    const root = claudeBackend.projectsDir();
    for (const proj of readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const projDir = join(root, proj.name);
      let files: string[];
      try { files = readdirSync(projDir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const id = f.slice(0, -6);
        if (!map.has(id)) map.set(id, join(projDir, f));
      }
    }
  } catch { /* projects dir absent — leave map as-is */ }
  sessionPathCache = { map, expiresAt: now + SESSION_PATH_MAP_TTL_MS };
  return map;
}

/**
 * Pre-warm caches at server startup so the FIRST user request after a
 * restart isn't the one that pays for the cold walks. Without this, the
 * /outcome (and /diff, /commits, etc.) endpoints bear the ~1.7s
 * `getAllSessions` cost on first call — visible to the user as a
 * "loading" spinner the first time they click any session.
 *
 * Called from server.ts after app.listen. Background — doesn't block
 * the listen() and tolerates failures (next user request rebuilds).
 */
export async function prewarmConversationCaches(): Promise<void> {
  try {
    const t0 = Date.now();
    await getCachedSessionPathMap();
    console.log(`  Path map warmed: ${sessionPathCache?.map.size ?? 0} sessions in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error('Path map warm-up failed:', err);
  }
  try {
    // Open the heavy-metadata cache so the very first L2 read pays
    // microseconds (DB already open) rather than 300-1500ms (open +
    // schema init). Triggers initSchema once at boot.
    const t0 = Date.now();
    getHeavyMetadataCache();
    console.log(`  Heavy metadata cache opened in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error('Heavy metadata cache warm-up failed:', err);
  }
  try {
    // Same for OutcomeCache (badge endpoint's L2 — opens on first badge
    // request otherwise).
    const t0 = Date.now();
    getOutcomeCache();
    console.log(`  Outcome cache opened in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error('Outcome cache warm-up failed:', err);
  }
}

/**
 * Map a classification status to the emoji + chip color the UI shows.
 * Centralized here so badge and batch endpoints stay in lockstep.
 */
function statusToEmoji(status: CachedOutcomeStatus): string {
  switch (status) {
    case 'shipped':     return '🚢';
    case 'abandoned':   return '🪦';
    case 'interrupted': return '⏸';
    case 'in_progress': return '🟡';
    case 'completed':   return '✓';
    default:            return '❔';
  }
}

interface BadgeResponse {
  emoji: string;
  label: CachedOutcomeStatus;
  tooltip: string;
  fileCount: number;
  commits: number;
  isFull: boolean;
  cached: boolean;
}

function cachedToResponse(c: CachedOutcome, fromCache: boolean): BadgeResponse {
  return {
    emoji: statusToEmoji(c.status),
    label: c.status,
    tooltip: c.reason,
    fileCount: c.fileCount,
    commits: c.commits,
    isFull: c.isFull,
    cached: fromCache,
  };
}

// GET /api/conversations/:id/outcome/badge
//
// Cheap status badge for list rows. Uses `quickOutcomeStatus` (mtime + tail
// scan, no JSONL parse, no replay, no git) — orders of magnitude faster
// than the full `computeOutcome` used by the /outcome view tab.
//
// Trade-off: the badge can't distinguish 'shipped' from 'abandoned' since
// both require git-log work. The four states it does report
// (in_progress / interrupted / completed / unknown) cover the at-a-glance
// scanning use case; the user clicks through to the Outcome tab for the
// full classification.
//
// Cached by sessionId + mtime so a list scroll over 200 rows costs at most
// one stat() per row after the first view.
/**
 * Resolve a session id to (filePath, mtime, size) for the classifier.
 *
 * Tool dispatch:
 *   - claude:   getSessionPath() finds the .jsonl in ~/.claude/projects.
 *   - codex:    findCodexSessionFile() finds the rollout-*.jsonl.
 *   - gemini:   no on-disk path exposed publicly; mtime via MemoryStore.
 *   - opencode: stored in SQLite, no JSONL; mtime via MemoryStore.
 *
 * Returns `null` when the session can't be located (→ 404).
 */
async function resolveSessionForBadge(id: string): Promise<
  | { kind: 'tail-scannable'; filePath: string; mtime: number; size: number; tool: string }
  | { kind: 'mtime-only'; mtime: number; size: number; tool: string }
  | null
> {
  const tool = detectTool(id);

  // Server mode: nothing to stat — the synced memory_metadata mtime is the
  // freshness key (it's the same mtime the CLI stamped on every synced
  // compute_cache row, so fresh-hits and ETags line up exactly).
  if (isServerMode()) {
    const store = await createStore();
    try {
      const item = await store.getItem(id, 'session' as SourceType);
      if (!item) return null;
      return { kind: 'mtime-only', mtime: item.mtime || 0, size: 0, tool };
    } finally {
      await store.close();
    }
  }

  const { statSync } = await import('fs');

  if (tool === 'claude') {
    // The TTL-cached map covers BOTH indexed sessions (from
    // memory_metadata) AND unindexed-on-disk sessions (from the
    // ~/.claude/projects listdir overlay). One ~2ms listdir per TTL
    // window, then microsecond Map lookups per request.
    const map = await getCachedSessionPathMap();
    const p = map.get(id);
    if (!p) return null;
    let mtime = 0, size = 0;
    try { const s = statSync(p); mtime = s.mtimeMs; size = s.size; } catch {}
    return { kind: 'tail-scannable', filePath: p, mtime, size, tool };
  }

  if (tool === 'codex') {
    const located = findCodexSessionFile(id);
    if (!located) {
      const store = await createStore();
      try {
        const item = await store.getItem(id, 'session' as SourceType);
        if (!item) return null;
        return { kind: 'mtime-only', mtime: item.mtime || 0, size: 0, tool };
      } finally {
        await store.close();
      }
    }
    let mtime = 0, size = 0;
    try { const s = statSync(located.path); mtime = s.mtimeMs; size = s.size; } catch {}
    return { kind: 'tail-scannable', filePath: located.path, mtime, size, tool };
  }

  // gemini / opencode: SQLite-indexed, no JSONL to stat — size stays 0
  // and freshness check effectively reduces to mtime equality.
  const store = await createStore();
  try {
    const item = await store.getItem(id, 'session' as SourceType);
    if (!item) return null;
    return { kind: 'mtime-only', mtime: item.mtime || 0, size: 0, tool };
  } finally {
    await store.close();
  }
}

/**
 * Cache-first classification for one session. Returns the response body
 * the badge endpoint sends. Used by both the single-id and batch endpoints
 * so they share semantics exactly.
 *
 * Validity is checked in this order (cheapest first):
 *   1. mtime + size match cached row → fast hit, return immediately.
 *   2. mtime/size moved → compute content hash (last 4KB) → if hash
 *      matches cached row, file is byte-identical (touch / restore /
 *      clock skew); just refresh mtime+size and return cached.
 *   3. Hash differs OR no cached row → run quick classifier, persist.
 */
function classifyOne(
  id: string,
  resolved: NonNullable<Awaited<ReturnType<typeof resolveSessionForBadge>>>,
): BadgeResponse {
  const cache = getOutcomeCache();
  const existing = cache.get(id);

  // Step 1: fast-path freshness check (mtime + size).
  if (isFresh(existing, resolved.mtime, resolved.size)) {
    return cachedToResponse(existing!, true);
  }

  // Step 1b: in-progress shortcut.
  // The classification for `in_progress` is trivially derivable from mtime
  // alone (file was touched within the last 2 hours). If the cached status
  // was already 'in_progress' AND the file is still within that window,
  // we don't need to fingerprint or tail-scan — just bump the cache
  // validators to the new mtime/size. This is the hot path for sessions
  // the user is actively using: every refresh they grow, but the classifier
  // would always return the same answer.
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  if (
    existing?.status === 'in_progress' &&
    Date.now() - resolved.mtime <= TWO_HOURS_MS
  ) {
    cache.put({ ...existing, fileMtime: resolved.mtime, fileSize: resolved.size });
    return cachedToResponse(existing, true);
  }

  // Step 2: hash-path freshness check — only computed when fast path
  // missed. For mtime-only tools (Gemini/OpenCode) there's no file to
  // hash; skip and treat as miss.
  let contentHash = '';
  if (resolved.kind === 'tail-scannable') {
    contentHash = fingerprintFile(resolved.filePath);
    if (existing && contentHash && existing.contentHash === contentHash) {
      // Same content — refresh validators in place, return cached classification.
      cache.put({ ...existing, fileMtime: resolved.mtime, fileSize: resolved.size, contentHash });
      return cachedToResponse(existing, true);
    }
  }

  // Step 3: real change (or no cached row). Run quick classifier and persist.
  const quick = resolved.kind === 'tail-scannable'
    ? quickOutcomeStatus(resolved.filePath, id)
    : quickOutcomeFromMtime(id, resolved.mtime);

  // Preserve rich fields from any prior is_full=1 row — a cheap re-classify
  // after the user already paid for the heavy one shouldn't blow away the
  // file counts and commit count. The Outcome tab will eventually re-run
  // the full classifier and overwrite cleanly.
  const preserveFull = existing?.isFull && existing?.fileCount;

  const record: CachedOutcome = {
    sessionId: id,
    tool: resolved.tool,
    status: quick.status,
    reason: quick.reason,
    fileMtime: resolved.mtime,
    fileSize: resolved.size,
    contentHash,
    fileCount: preserveFull ? existing!.fileCount : 0,
    linesAdded: preserveFull ? existing!.linesAdded : 0,
    linesRemoved: preserveFull ? existing!.linesRemoved : 0,
    commits: preserveFull ? existing!.commits : 0,
    isFull: false,
    classifiedAt: Date.now(),
    lastScannedOffset: resolved.size,
  };
  cache.put(record);
  return cachedToResponse(record, false);
}

router.get('/:id/outcome/badge', async (req, res) => {
  try {
    const { id } = req.params;
    // Server mode: badges come from the synced session_outcome_cache rows —
    // there's no file to stat or tail-scan.
    if (isServerMode()) {
      const cache = await createOutcomeCache();
      try {
        const row = await cache.get(id);
        if (!row) return res.status(404).json({ error: 'No synced outcome for this session' });
        return res.json(cachedToResponse(row, true));
      } finally {
        await cache.close();
      }
    }
    const resolved = await resolveSessionForBadge(id);
    if (!resolved) return res.status(404).json({ error: 'Session not found' });
    res.json(classifyOne(id, resolved));
  } catch (error) {
    console.error('Outcome badge error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to compute outcome badge' });
  }
});

/**
 * POST /api/conversations/outcome/badges
 *
 * Batch variant of /outcome/badge — takes `{ ids: string[] }` and returns
 * `{ badges: Record<id, BadgeResponse> }` in a single round-trip. This
 * exists because the per-row HTTP overhead (vite proxy + tsx + express)
 * dominates the actual classification cost: 50 sequential 600ms requests
 * = 30 seconds of dead time, even though the underlying work is < 100ms
 * total. The batch endpoint collapses that to one round-trip.
 *
 * Cache-first per id — uncached or stale ids run the quick classifier
 * concurrently and the results are persisted in a single transaction.
 * Missing/unknown ids are absent from the returned map (the client should
 * treat absence as "no badge").
 */
router.post('/outcome/badges', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: unknown) => typeof x === 'string') as string[] : [];
    if (ids.length === 0) return res.json({ badges: {} });

    // Cap to a sane limit so a malicious or buggy client can't ask us to
    // stat 100k sessions in one call.
    const MAX_BATCH = 500;
    const safeIds = ids.slice(0, MAX_BATCH);

    // Server mode: one tenant-scoped fetch over the synced rows. No file
    // stats, no quick classification — absent ids simply get no badge.
    if (isServerMode()) {
      const driverCache = await createOutcomeCache();
      try {
        const rows = await driverCache.getMany(safeIds);
        const badges: Record<string, BadgeResponse> = {};
        for (const [id, row] of rows) badges[id] = cachedToResponse(row, true);
        return res.json({ badges });
      } finally {
        await driverCache.close();
      }
    }

    // Single SQL fetch for all cached rows.
    const cache = getOutcomeCache();
    const cachedMap = cache.getMany(safeIds);

    // Use the TTL-cached path map. The first batch in a 10-second window
    // pays for the walk (~1.9s for ~600 sessions); every subsequent
    // request reuses the same map for free. Critical for the burst that
    // fires when a list of conversations renders.
    const claudePathMap = await getCachedSessionPathMap();

    // Resolve every id in parallel. For Claude ids we use the precomputed
    // map; non-Claude ids still hit findCodexSessionFile / MemoryStore
    // individually (cheap — single lookup per call).
    const { statSync } = await import('fs');
    const resolved = await Promise.all(
      safeIds.map(async id => {
        const tool = detectTool(id);
        if (tool === 'claude') {
          const p = claudePathMap.get(id);
          if (!p) return { id, r: null };
          let mtime = 0, size = 0;
          try { const s = statSync(p); mtime = s.mtimeMs; size = s.size; } catch {}
          return { id, r: { kind: 'tail-scannable' as const, filePath: p, mtime, size, tool } };
        }
        return { id, r: await resolveSessionForBadge(id) };
      }),
    );

    const badges: Record<string, BadgeResponse> = {};
    const newRecords: CachedOutcome[] = [];

    for (const { id, r } of resolved) {
      if (!r) continue;
      const existing = cachedMap.get(id) ?? null;

      // Fast freshness path (mtime + size).
      if (isFresh(existing, r.mtime, r.size)) {
        badges[id] = cachedToResponse(existing!, true);
        continue;
      }

      // In-progress shortcut: file changed but the answer is still trivially
      // 'in_progress' because mtime is within the 2h window. Avoids hashing
      // and tail-scanning every active session on every refresh.
      const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
      if (
        existing?.status === 'in_progress' &&
        Date.now() - r.mtime <= TWO_HOURS_MS
      ) {
        newRecords.push({ ...existing, fileMtime: r.mtime, fileSize: r.size });
        badges[id] = cachedToResponse(existing, true);
        continue;
      }

      // Hash-path freshness — only when fast path missed.
      let contentHash = '';
      if (r.kind === 'tail-scannable') {
        contentHash = fingerprintFile(r.filePath);
        if (existing && contentHash && existing.contentHash === contentHash) {
          newRecords.push({ ...existing, fileMtime: r.mtime, fileSize: r.size, contentHash });
          badges[id] = cachedToResponse(existing, true);
          continue;
        }
      }

      const quick = r.kind === 'tail-scannable'
        ? quickOutcomeStatus(r.filePath, id)
        : quickOutcomeFromMtime(id, r.mtime);

      const preserveFull = existing?.isFull && existing?.fileCount;
      const record: CachedOutcome = {
        sessionId: id,
        tool: r.tool,
        status: quick.status,
        reason: quick.reason,
        fileMtime: r.mtime,
        fileSize: r.size,
        contentHash,
        fileCount: preserveFull ? existing!.fileCount : 0,
        linesAdded: preserveFull ? existing!.linesAdded : 0,
        linesRemoved: preserveFull ? existing!.linesRemoved : 0,
        commits: preserveFull ? existing!.commits : 0,
        isFull: false,
        classifiedAt: Date.now(),
        lastScannedOffset: r.size,
      };
      newRecords.push(record);
      badges[id] = cachedToResponse(record, false);
    }

    if (newRecords.length > 0) cache.putMany(newRecords);
    res.json({ badges });
  } catch (error) {
    console.error('Outcome badges batch error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to compute outcome badges' });
  }
});

// GET /api/conversations/:id/turns
// Interleaved user/assistant/tool turns with bash command + tool-result snippets.
// mtime-cached. The compute cost is dominated by the JSONL parse, not by
// the limit — we cache the maxed-out result and slice client-side via the
// limit param so different limit= values share the same cached payload.
router.get('/:id/turns', async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 5000, 50_000));

    const resolved = await resolveSessionForBadge(id);
    let result = resolved
      ? await heavyCacheGet<ReturnType<typeof extractTurnsAny>>(`turns:${id}`, resolved.mtime)
      : null;
    if (!result && isServerMode()) {
      // No transcript on the server — rebuild user/assistant turns from the
      // synced per-turn chunks. Tool/bash turns aren't synced, so this is a
      // conversation-only view (same fidelity as the message list).
      const store = await createStore();
      try {
        const chunks = await store.listChunksByItem('session', id);
        if (chunks.length === 0) return res.status(404).json({ error: 'Session not found' });
        result = {
          sessionId: id,
          found: true,
          turns: chunks.map((c, i) => ({
            kind: c.chunk_type.startsWith('user') ? 'user' : 'assistant_text',
            text: c.text,
            ts: 0,
            line: i + 1,
          })) as any,
          startMs: 0,
          endMs: 0,
        };
      } finally {
        await store.close();
      }
    }
    if (!result) {
      // Cache the full extraction (50k cap) so subsequent requests with
      // any smaller limit can reuse the cached result and slice in JS.
      result = extractTurnsAny(id, { maxTurns: 50_000 });
      if (resolved && result.found) await heavyCacheSet(`turns:${id}`, resolved.mtime, result);
    }
    if (!result.found) return res.status(404).json({ error: 'Session not found' });

    // ETag/Cache-Control: payload is immutable per (sessionId, mtime, limit).
    if (resolved) {
      const etag = buildETag([id, 'turns', resolved.mtime, limit]);
      if (maybeSendNotModified(req, res, etag)) return;
    }
    // Apply the request's limit on the cached full result.
    if (result.turns.length > limit) {
      result = { ...result, turns: result.turns.slice(0, limit) };
    }
    res.json(result);
  } catch (error) {
    console.error('Turns error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to extract turns' });
  }
});

// Markers wrapped on top of the same two-tier cache as outcome/diff/commits
// — `kind: 'markers'` rows in `compute_cache`, mtime-keyed, persistent.
// The `getCachedMarkers` / `setCachedMarkers` shims keep the call sites
// readable while delegating to the shared helpers.
type MarkersPayload = { sessionId: string; prompts: unknown[]; summary: unknown };
function getCachedMarkers(id: string, mtime: number): Promise<MarkersPayload | null> {
  return heavyCacheGet<MarkersPayload>(`markers:${id}`, mtime);
}
async function setCachedMarkers(id: string, mtime: number, data: MarkersPayload): Promise<void> {
  await heavyCacheSet(`markers:${id}`, mtime, data);
}

// GET /api/conversations/:id/markers
// Marked prompts + counts (sentiment heuristic). Cached by file mtime so
// repeated list scrolls don't re-walk the same transcript.
router.get('/:id/markers', async (req, res) => {
  try {
    const { id } = req.params;

    // Resolve mtime from the badge resolver — same source-of-truth that
    // the outcome cache uses, so freshness checks match across endpoints.
    const resolved = await resolveSessionForBadge(id);
    if (resolved) {
      const cached = await getCachedMarkers(id, resolved.mtime);
      if (cached) {
        const etag = buildETag([id, 'markers', resolved.mtime]);
        if (maybeSendNotModified(req, res, etag)) return;
        return res.json(cached);
      }
    }

    // Server mode: no transcript to extract from — serve the latest synced
    // row (any mtime) or report not-yet-synced.
    if (isServerMode()) {
      const stale = await getStaleHeavy<MarkersPayload>(id, 'markers');
      if (stale) return res.json(stale.data);
      return res.status(404).json({ error: 'No synced markers for this session' });
    }

    const turns = extractTurnsAny(id, { maxTurns: 50_000 });
    if (!turns.found) return res.status(404).json({ error: 'Session not found' });
    const prompts = turns.turns
      .filter(t => t.kind === 'user' && t.text)
      .map(t => ({ line: t.line, ts: t.ts, tsIso: t.tsIso, ...markPrompt(t.text!) }));
    const payload: MarkersPayload = { sessionId: id, prompts, summary: summarizeMarkers(prompts) };

    if (resolved) await setCachedMarkers(id, resolved.mtime, payload);
    res.json(payload);
  } catch (error) {
    console.error('Markers error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to mark prompts' });
  }
});

// GET /api/conversations/:id/related
router.get('/:id/related', async (req, res) => {
  try {
    const { id } = req.params;
    const related = await getRelatedItems(id);
    res.json(related);
  } catch (error) {
    console.error('Related items error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get related items',
    });
  }
});

// GET /api/conversations/:id/metadata
router.get('/:id/metadata', async (req, res) => {
  try {
    const { id } = req.params;
    const metadata = await getSessionMetadata(id);
    if (!metadata) {
      return res.status(404).json({ error: 'Session metadata not found' });
    }
    res.json(metadata);
  } catch (error) {
    console.error('Session metadata error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get session metadata',
    });
  }
});

// POST /api/conversations/:id/regenerate-summary
//
// On-demand re-generation of an AI summary for a single session. Uses
// whatever summary provider is configured in settings (CLI/Gemini/Claude/
// Ollama). Existing cached summary (if any) is overwritten on success.
router.post('/:id/regenerate-summary', async (req, res) => {
  const { id } = req.params;
  try {
    const path = getSessionPath(id); // throws if missing
    const content = await parseSessionFile(path);

    const settings = loadSettings();
    const provider = (settings.summary?.provider as any) || (process.env.SUMMARY_PROVIDER as any) || 'cli';
    const cliCommand = settings.summary?.cliCommand || process.env.SUMMARY_CLI_CMD;
    const generator = new SummaryGenerator({ provider, cliCommand });

    const summary = await generator.generate(content);
    const cache = await createMetadataCache();
    try {
      await cache.set({
        sessionId: id,
        firstPrompt: content.firstPrompt || '',
        summary,
        summarySource: provider === 'gemini-cli' ? 'gemini' : (provider as any),
        mtime: Date.now(),
        indexedAt: Date.now(),
      });
      await cache.clearSummaryError(id);
    } finally {
      await cache.close();
    }

    res.json({ sessionId: id, summary, summarySource: provider });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Surface quota errors with a 429 so the UI can render a clear message
    const status = /QUOTA_EXHAUSTED|429|exhausted your capacity|rate.?limit/i.test(msg) ? 429 : 500;
    console.error(`regenerate-summary ${id}:`, msg.slice(0, 300));
    res.status(status).json({ error: msg.slice(0, 500) });
  }
});

// GET /api/conversations/:id
//
// Pagination: `?offset=N&limit=M` slices the cached `messages` array
// before sending. `limit=0` (or absent + no offset) = legacy behavior:
// return the full array. SaaS-grade defaults send a bounded window so a
// single click on a multi-MB session doesn't ship 5 MB of JSON.
//
// Response shape:
//   { sessionId, messages, subagents, count, total, offset, hasMore }
// `count` is the number returned in this response, `total` is the
// session's full message count. `hasMore` flags pagination state.
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const limitRaw = req.query.limit !== undefined ? parseInt(req.query.limit as string) : NaN;
    // limit=0 is an explicit "no slice"; otherwise default to 500. The
    // 500 ceiling covers the vast majority of sessions in one round-trip
    // while keeping the worst-case (>5MB Claude session) bounded.
    const limit = Number.isFinite(limitRaw) ? Math.max(0, limitRaw) : 500;

    const store = await createStore();
    try {
      // 1. Detect tool type and file path
      const item = await store.getItem(id, 'session' as SourceType);
      let tool = 'claude';
      let filePath = '';
      let mtime = 0;

      if (item) {
        const extra = JSON.parse(item.extra_json || '{}');
        tool = extra.tool || 'claude';
        filePath = item.file_path;
        mtime = item.mtime;
      } else if (id.startsWith('codex_')) {
        // Codex sessions surfaced from a live filesystem scan aren't always
        // in memory_metadata yet — locate the rollout file on disk so we
        // can still render the conversation.
        tool = 'codex';
      } else if (id.startsWith('gemini_')) {
        tool = 'gemini';
      } else if (id.startsWith('opencode_')) {
        tool = 'opencode';
      }

      if (tool === 'claude' && !filePath) {
        try {
          filePath = getSessionPath(id);
          const { statSync } = await import('fs');
          mtime = statSync(filePath).mtimeMs;
        } catch {}
      } else if (tool === 'codex' && !filePath) {
        // Stripped id matches the rollout filename body: <timestamp>-<uuid>.
        const located = findCodexSessionFile(codexBackend.toRawId(id));
        if (located) {
          filePath = located.path;
          try {
            const { statSync } = await import('fs');
            mtime = statSync(filePath).mtimeMs;
          } catch {}
        }
      }

      // 2. Try Cache
      // PARSER_VERSION: bump when parser output shape changes so stale cache
      // entries from older buggy parsers are ignored instead of served.
      const PARSER_VERSION = 5;
      if (mtime > 0) {
        const cached = await store.getCachedContent(id, 'session', mtime);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed && parsed.v === PARSER_VERSION && Array.isArray(parsed.messages)) {
              const etag = buildETag([id, 'messages', mtime, PARSER_VERSION, offset, limit]);
              if (maybeSendNotModified(req, res, etag)) return;
              const total = parsed.messages.length;
              const slice = limit === 0 ? parsed.messages : parsed.messages.slice(offset, offset + limit);
              return res.json({
                sessionId: id,
                messages: slice,
                subagents: parsed.subagents ?? [],
                count: slice.length,
                total,
                offset,
                hasMore: limit !== 0 && offset + slice.length < total,
                fromCache: true,
              });
            }
          } catch {
            // fall through and reparse
          }
        }
      }

      // 2b. Server mode: there is no JSONL on disk and the full-conversation
      // JSON is deliberately never synced — rebuild the message list from
      // the synced per-turn chunks (`<id>:sync:<i>`, role encoded in
      // chunk_type). Long turns were split into ~2KB chunks at ingest, so
      // boundaries are approximate; content and order are exact.
      if (isServerMode()) {
        const chunks = await store.listChunksByItem('session', id);
        if (chunks.length === 0) {
          return res.status(404).json({ error: 'Session not synced' });
        }
        const messages = chunks.map((c, i) => ({
          line: i + 1,
          role: c.chunk_type.startsWith('user') ? 'user' : 'assistant',
          content: c.text,
        }));
        const etag = buildETag([id, 'messages-chunks', mtime, messages.length, offset, limit]);
        if (maybeSendNotModified(req, res, etag)) return;
        const total = messages.length;
        const slice = limit === 0 ? messages : messages.slice(offset, offset + limit);
        return res.json({
          sessionId: id,
          messages: slice,
          subagents: [],
          count: slice.length,
          total,
          offset,
          hasMore: limit !== 0 && offset + slice.length < total,
          fromCache: true,
          rebuiltFromChunks: true,
        });
      }

      // 3. Parse and cache
      let messages;
      let subagents: Subagent[] = [];
      if (tool === 'gemini') {
        if (!filePath) throw new Error('Session path not found');
        messages = await getGeminiConversation(filePath);
      } else if (tool === 'opencode') {
        messages = await getOpenCodeConversation(id);
        subagents = await getOpenCodeSubagents(id);
      } else if (tool === 'codex') {
        if (!filePath) throw new Error('Session path not found');
        messages = await getCodexConversation(filePath);
        subagents = await getCodexSubagents(filePath);
      } else {
        // Claude
        if (!filePath) throw new Error('Session not found');
        messages = await getConversation(filePath);
        subagents = await getSubagents(filePath);
      }

      // Store in cache (versioned envelope — see PARSER_VERSION above)
      if (mtime > 0 && messages.length > 0) {
        await store.setCachedContent(id, 'session', mtime, JSON.stringify({ v: PARSER_VERSION, messages, subagents }));
      }

      // ETag for the freshly-parsed branch too. Same key shape as the
      // cache-hit branch above so a client that just parsed will hit
      // 304 on the next reload.
      if (mtime > 0) {
        const etag = buildETag([id, 'messages', mtime, PARSER_VERSION, offset, limit]);
        if (maybeSendNotModified(req, res, etag)) return;
      }
      const total = messages.length;
      const slice = limit === 0 ? messages : messages.slice(offset, offset + limit);
      res.json({
        sessionId: id,
        messages: slice,
        subagents,
        count: slice.length,
        total,
        offset,
        hasMore: limit !== 0 && offset + slice.length < total,
      });
    } finally {
      await store.close();
    }
  } catch (error) {
    console.error('Conversation error:', error);

    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get conversation',
    });
  }
});

// GET /api/conversations/:id/raw
router.get('/:id/raw', async (req, res) => {
  try {
    const { id } = req.params;

    // Codex — JSONL stream from ~/.codex/sessions/YYYY/MM/DD/.
    if (id.startsWith('codex_')) {
      const located = findCodexSessionFile(codexBackend.toRawId(id));
      if (!located) return res.status(404).json({ error: 'Session not found' });
      const { readFileSync } = await import('fs');
      const lines: any[] = [];
      for (const line of readFileSync(located.path, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try { lines.push(JSON.parse(line)); } catch { /* skip */ }
      }
      return res.json({ sessionId: id, tool: 'codex', lines, count: lines.length });
    }

    // OpenCode — SQLite-backed; surface session row + its parts as the
    // canonical raw representation.
    if (id.startsWith('opencode_')) {
      const { opencodeBackend } = await import('../imports.js');
      const ocId = opencodeBackend.toRawId(id);
      const Database = (await import('better-sqlite3')).default;
      const path = opencodeBackend.dbPath();
      try {
        const db = new Database(path, { readonly: true, fileMustExist: true });
        try {
          const session = db.prepare('SELECT * FROM session WHERE id = ?').get(ocId) as any;
          if (!session) return res.status(404).json({ error: 'Session not found' });
          const parts = db.prepare('SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC').all(ocId) as any[];
          const lines = parts.map(p => {
            let data: any;
            try { data = JSON.parse(p.data); } catch { data = p.data; }
            return { id: p.id, message_id: p.message_id, time_created: p.time_created, data };
          });
          return res.json({ sessionId: id, tool: 'opencode', session, lines, count: lines.length });
        } finally { db.close(); }
      } catch (e) {
        console.error('OpenCode raw error:', e);
        return res.status(404).json({ error: e instanceof Error ? e.message : 'OpenCode database not found' });
      }
    }

    // Gemini — single JSON file under ~/.gemini/tmp/<hash>/chats/.
    if (id.startsWith('gemini_')) {
      const store = await createStore();
      let filePath = '';
      try {
        const item = await store.getItem(id, 'session' as SourceType);
        if (item) filePath = item.file_path;
      } finally { await store.close(); }
      if (!filePath) return res.status(404).json({ error: 'Session not found' });
      const { readFileSync } = await import('fs');
      const json = JSON.parse(readFileSync(filePath, 'utf-8'));
      const messages = Array.isArray(json.messages) ? json.messages : [];
      return res.json({ sessionId: id, tool: 'gemini', lines: messages, count: messages.length, raw: json });
    }

    // Claude — original path.
    const sessionPath = getSessionPath(id);
    const { open } = await import('fs/promises');
    const file = await open(sessionPath);
    const rawLines: any[] = [];

    for await (const line of file.readLines()) {
      if (line.trim()) {
        try {
          rawLines.push(JSON.parse(line));
        } catch (e) {
          // Skip malformed lines
        }
      }
    }

    await file.close();

    res.json({
      sessionId: id,
      tool: 'claude',
      lines: rawLines,
      count: rawLines.length,
    });
  } catch (error) {
    console.error('Raw conversation error:', error);

    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get raw conversation',
    });
  }
});

export default router;
