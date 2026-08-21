/**
 * Conversation routes.
 */

import express from 'express';
import { getRecentSessions, getSessionPath, getSessionPaths, getRelatedItems, getSessionMetadata, getSessionIndex, hydrateSessions } from '../services/sessions.js';
import type { SessionIndexEntry } from '../services/sessions.js';
import { getConversation, getGeminiConversation, getOpenCodeConversation, getOpenCodeSubagents, getCodexConversation, getCodexSubagents, getSubagents } from '../services/parser.js';
import type { Subagent } from '../services/parser.js';
import { canonicalEventsToMessages, getBackendForId } from '../imports.js';
import {
  MetadataCache,
  OutcomeCache,
  createStore,
  createMetadataCache,
  createOutcomeCache,
  SummaryGenerator,
  parseSessionFile,
  loadSettings,
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
  gunzipContainer,
  parseTranscriptFromContainer,
  type CachedOutcome,
  type CachedOutcomeStatus,
} from '../imports.js';
import type { SourceType, SessionContent, OutcomeDaySummary } from '../imports.js';
import {
  serverSummaryConfig,
  envelopeToSessionContent,
  providerToSource,
  type CachedEnvelope,
} from '../services/summary-worker.js';
import { matchesPrefix } from '../util/paths.js';
import { tenantLimits, searchWindow, windowMeta } from '../util/billing.js';
import { featureRequired } from '../util/entitlements.js';
import { buildETag, maybeSendNotModified } from '../util/cacheable.js';
import { TenantTtlCache } from '../util/tenant-cache.js';
import { requireLocalMode, isServerMode } from '../util/mode.js';
import { openPgPoolRo, tenantQuery } from '@chat-recall/engine/core/store/pg-pool.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('conversations');

const router = express.Router();

// Per-project team visibility is enforced in the DB (RLS `author_visibility`
// policy) — a fetch of an unshared session's rows
// simply returns nothing under the request's `app.viewer`, so these handlers
// 404 naturally with no per-route guard to forget. See pg-schema.ts.

// 60s per-tenant cache for the dashboard's activity rollup (see
// GET /outcome-summary). Keyed by the days window.
const outcomeSummaryCache = new TenantTtlCache<{ days: number; rows: OutcomeDaySummary[] }>(60_000);

/**
 * Expand a partial session id (a unique prefix) to the full one. The recall
 * tools (recall_context/summary/show/diff/...) all route through
 * `/api/conversations/:id`, so resolving the prefix once here fixes every one:
 * `recall_summary e3105b00` used to 404 because the lookup was exact-match only.
 *
 *   - exact id              → returned unchanged (one PK-indexed probe; the
 *                             common case stays fast).
 *   - unique prefix         → expanded to the full id.
 *   - ambiguous prefix      → { ambiguous: [...candidates] } so the caller gets
 *                             the choices instead of a silent wrong/empty hit.
 *   - no match / no DB      → null (handlers fall through to their own 404).
 *
 * Postgres-direct + tenant-scoped (RLS-safe via tenantQuery), matching the
 * pattern in routes/metrics.ts and routes/admin.ts. The server is Postgres-only;
 * with no DATABASE_URL (unit tests) this is a no-op and the id passes through.
 */
export async function expandSessionId(
  tenant: string,
  id: string,
): Promise<{ resolved: string } | { ambiguous: string[] } | null> {
  if (!process.env.DATABASE_URL) return null;
  // Display read: prefix→full-id resolution + existence check for VIEWING a
  // conversation. Pure SELECTs over memory_metadata, lag-tolerant → read replica
  // (falls back to primary when no RO DSN is set).
  const pool = await openPgPoolRo();
  // Exact first — hits the (tenant,id) primary key, so a full id costs one probe.
  const exact = await tenantQuery(
    pool, tenant,
    `SELECT 1 FROM memory_metadata WHERE tenant=$1 AND source_type='session' AND id=$2 LIMIT 1`,
    [tenant, id],
  );
  if (exact.rows.length) return { resolved: id };
  // Prefix fallback. `id LIKE 'prefix%'` with the prefix's LIKE metacharacters
  // (`\` `%` `_`) escaped — session ids legitimately contain `_` (tool prefixes
  // like `opencode_`), so leaving it unescaped would treat it as a wildcard and
  // over-match. This form is SARGABLE against idx_mm_session_id_prefix
  // (text_pattern_ops), so it range-scans rather than sequential-scanning every
  // session row in the tenant — what `left(id, char_length($2)) = $2` forced.
  // Shortest id first is the tightest match.
  const likePrefix = id.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
  const rows = (await tenantQuery(
    pool, tenant,
    `SELECT id FROM memory_metadata
       WHERE tenant=$1 AND source_type='session' AND id LIKE $2 ESCAPE '\\'
       ORDER BY char_length(id) ASC
       LIMIT 5`,
    [tenant, likePrefix],
  )).rows as Array<{ id: string }>;
  if (rows.length === 0) return null;
  if (rows.length === 1) return { resolved: rows[0].id };
  return { ambiguous: rows.map((r) => r.id) };
}

// Rewrite a unique-prefix :id to its full session id before any handler runs.
// Ambiguous prefixes short-circuit with the candidate list; everything else
// (exact, unknown, no DB) passes through untouched.
router.param('id', (req, res, next, id) => {
  expandSessionId(req.tenant || 'default', String(id))
    .then((r) => {
      if (r && 'ambiguous' in r) {
        res.status(409).json({
          error: `ambiguous session id prefix "${id}" — matches ${r.ambiguous.length} sessions`,
          candidates: r.ambiguous,
        });
        return;
      }
      if (r && 'resolved' in r && r.resolved !== id) req.params.id = r.resolved;
      next();
    })
    .catch(() => next()); // never block a request on the expansion probe
});

// Genuinely FS-dependent endpoints only exist in local mode: live file scans
// and raw transcript serving read the on-disk JSONL directly. Everything
// else — diff, commits, outcome (+badges), markers, turns, regenerate-summary
// — serves from / writes to the synced store rows in server mode (the CLI
// computes diffs/outcomes; regenerate-summary rebuilds SessionContent from the
// synced envelope and summarizes with the server-configured provider).
router.use([
  '/:id/raw',
], requireLocalMode);

// DELETE /api/conversations/:id — purge a session everywhere and tombstone it
// so the next sync from any device can't resurrect it. The thin collector's
// `chat-recall delete` calls this directly (deletion is a server operation,
// not local state). Tenant-scoped via tenantAuth → runWithTenant.
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { createStore } = await import('../imports.js');
    const store = await createStore();
    try {
      await store.purgeSession(id);
      await store.addTombstone(id);
      res.json({ deleted: id, tombstoned: true });
    } finally {
      await store.close();
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'delete failed' });
  }
});

// Per-session diff/outcome/turns/markers are tool-agnostic: every backend
// (Claude, Gemini, OpenCode, Codex) goes through the generic engine's
// readEvents() adapter, and the synced compute_cache rows cover all four.
// (The old isNonClaude/emptyDiff/emptyOutcome short-circuits from before the
// ToolBackend registry were dead code and are gone.)

// GET /api/conversations/recent?limit=20&offset=0&project=...&tool=...&since_hours=...
//
// Single SQL query against `memory_metadata` (sorted by `idx_memory_mtime`).
// No filesystem walk, no JS sort, no in-process index cache — the page
// rows + total count both come back in <5ms even on a 10k-session install.
//
// GET /api/conversations/heal-audit — read-only self-heal audit for the
// caller's tenant. Dry-runs the same envelope-vs-archive comparison the sweep
// uses and reports how many sessions are still damaged (archive fuller than the
// rendered view). `?since_hours=N` bounds the scan. Writes NOTHING — this is the
// authoritative "0 remaining" check (the CLI repair --all scan is metric-fuzzy).
// Registered BEFORE '/:id' so the literal path isn't captured as an id.
router.get('/heal-audit', async (req, res) => {
  const sinceHoursRaw = req.query.since_hours as string | undefined;
  const sinceHours = sinceHoursRaw ? Number(sinceHoursRaw) : undefined;
  const sinceMs = sinceHours && Number.isFinite(sinceHours) && sinceHours > 0 ? Date.now() - sinceHours * 3600 * 1000 : 0;
  // ?apply=1 actually heals (not just audits) the caller's tenant — a manual
  // "heal now" for when you don't want to wait for the hourly sweep.
  const apply = req.query.apply === '1' || req.query.apply === 'true';
  const store = await createStore();
  try {
    const { selfHealTenant } = await import('../services/self-heal.js');
    const r = await selfHealTenant(store, { sinceMs, dryRun: !apply });
    res.json({ scanned: r.scanned, damaged: r.damaged, healed: r.healed, healthy: r.scanned - r.damaged, applied: apply, damagedIds: r.damagedIds });
  } catch (error) {
    log.error({ err: error }, 'heal-audit error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'heal-audit failed' });
  } finally {
    await store.close();
  }
});

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
    const callerSinceMs = sinceHours && Number.isFinite(sinceHours) && sinceHours > 0
      ? Date.now() - sinceHours * 3600 * 1000
      : undefined;
    // Free-tier list window: the feed reaches back only `searchWindowDays`
    // days. A caller's own narrower since_hours survives (max of the two
    // floors); null (paid, trialing, self-host) leaves the query untouched.
    const win = await searchWindow(req.tenant || 'default');
    const windowFloorMs = win.floorMs;
    const sinceMs = windowFloorMs !== undefined
      ? Math.max(callerSinceMs ?? 0, windowFloorMs)
      : callerSinceMs;
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
    let lockedOlder: number | undefined;
    try {
      // The windowed page and the unfloored count are independent — pay their
      // latencies together, not back-to-back. The count runs only on the free
      // path; its ROWS are moot (limit 1), only `total` is read. If the
      // caller's own since_hours is narrower than the window, both totals
      // match and locked_older is 0.
      const [{ rows, total }, unflooredResult] = await Promise.all([
        store.querySessionIndex({
          limit, offset, projectIdFilter, toolFilter, sinceMs, includeUntracked,
        }),
        windowFloorMs !== undefined
          ? store.querySessionIndex({
              limit: 1, offset: 0, projectIdFilter, toolFilter, sinceMs: callerSinceMs, includeUntracked,
            })
          : Promise.resolve(undefined),
      ]);
      if (unflooredResult) {
        lockedOlder = Math.max(unflooredResult.total - total, 0);
      }

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
          // Logical project id (cleartext, e.g. `git:github.com/me/repo`). The
          // UI groups/displays by this — project_path may be a privacy hash on
          // the SaaS, which would otherwise show users meaningless hashes.
          projectId: r.project_id || '',
          mtime: r.mtime || 0,
          tool,
          filePath: r.file_path || undefined,
          preIndexedFirstPrompt: r.content_preview || undefined,
          oneShot: extra.oneShot === true || undefined,
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
      // Only when windowed — the paid response shape is unchanged.
      ...windowMeta(win, lockedOlder),
    });
  } catch (error) {
    log.error({ err: error }, 'recent sessions error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get recent sessions',
    });
  }
});

// GET /api/conversations/outcome-summary?days=7
//
// Per-day, per-status activity rollup (sessions, files, ±lines, commits)
// from the outcome cache — powers the dashboard's "what happened this week"
// strip. One grouped index scan (~20ms on 10k sessions), 60s cached per
// tenant. Mounted BEFORE the /:id routes so the literal path wins.
router.get('/outcome-summary', async (req, res) => {
  try {
    const askedDays = Math.max(1, Math.min(parseInt(req.query.days as string) || 7, 90));
    // Free-tier window: the rollup reaches back at most `searchWindowDays`
    // days. A narrower ask survives; null (paid, self-host) is untouched.
    const win = await searchWindow(req.tenant || 'default');
    const days = win.days !== null ? Math.min(askedDays, win.days) : askedDays;
    const key = `days:${days}`;
    const hit = outcomeSummaryCache.get(key);
    if (hit) return res.json(hit);
    const oc = await createOutcomeCache();
    try {
      const rows = await oc.summarizeByDay(Date.now() - days * 86_400_000);
      const body = {
        days,
        rows,
        ...(win.days !== null ? { window_days: win.days } : {}),
      };
      outcomeSummaryCache.set(key, body);
      res.json(body);
    } finally {
      await oc.close();
    }
  } catch (error) {
    log.error({ err: error }, 'outcome summary error');
    res.status(500).json({ error: 'Failed to compute outcome summary' });
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
        return res.status(202).json({ sessionId: id, status: isServerMode() ? 'pending-sync' : 'computing', message: isServerMode() ? 'Not synced yet — this session\'s diff arrives with the next sync from its machine.' : 'Diff is being computed in the background.' });
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
    log.error({ err: error }, 'diff error');
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
      return res.status(202).json({ sessionId: id, status: isServerMode() ? 'pending-sync' : 'computing', message: isServerMode() ? 'Not synced yet — commits arrive with the next sync from this session\'s machine.' : 'Commits are being computed in the background.' });
    }
    return res.status(404).json({ error: 'Session not found' });
  } catch (error) {
    log.error({ err: error }, 'commits error');
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
        status: isServerMode() ? 'pending-sync' : 'computing',
        message: isServerMode()
          ? 'Not synced yet — the outcome arrives with the next sync from this session\'s machine.'
          : 'Outcome is being computed in the background. Retry in a moment.',
      });
    }
    return res.status(404).json({ error: 'Session not found' });
  } catch (error) {
    log.error({ err: error }, 'outcome error');
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
        log.error({ err, kind, sessionId }, 'async refresh failed');
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
// Tenant-scoped: the map is built from the tenant's own store rows, so an
// unscoped module-level value here both hid tenant B's sessions for the TTL
// window and disclosed tenant A's session ids + file paths to everyone.
const sessionPathCache = new TenantTtlCache<Map<string, string>>(10_000);

async function getCachedSessionPathMap(): Promise<Map<string, string>> {
  const cached = sessionPathCache.get();
  if (cached) return cached;
  // Primary source: indexed sessions from memory_metadata. <1ms.
  const store = await createStore();
  const map = new Map<string, string>();
  try {
    for (const r of await store.listAllSessionPaths()) map.set(r.id, r.file_path);
  } finally {
    await store.close();
  }
  // Coverage fill (LOCAL MODE ONLY): walk ~/.claude/projects/<encoded>/
  // <id>.jsonl by filename only (no parse) for any session id not yet in
  // memory_metadata. Active sessions and anything between indexer
  // passes show up here. Pure listdir is ~2ms for ~600 files —
  // cheaper than the 1-2s cost of the per-id `getSessionPath` fallback
  // that this avoids on subsequent requests. In server mode data arrives
  // exclusively via /api/sync — never walk the server host's own home.
  if (!isServerMode()) try {
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
  sessionPathCache.set(map);
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
    const warmed = await getCachedSessionPathMap();
    log.info({ sessions: warmed.size, ms: Date.now() - t0 }, 'path map warmed');
  } catch (err) {
    log.error({ err }, 'path map warm-up failed');
  }
  try {
    // Open the heavy-metadata cache so the very first L2 read pays
    // microseconds (DB already open) rather than 300-1500ms (open +
    // schema init). Triggers initSchema once at boot.
    const t0 = Date.now();
    getHeavyMetadataCache();
    log.info({ ms: Date.now() - t0 }, 'heavy metadata cache opened');
  } catch (err) {
    log.error({ err }, 'heavy metadata cache warm-up failed');
  }
  try {
    // Same for OutcomeCache (badge endpoint's L2 — opens on first badge
    // request otherwise).
    const t0 = Date.now();
    getOutcomeCache();
    log.info({ ms: Date.now() - t0 }, 'outcome cache opened');
  } catch (err) {
    log.error({ err }, 'outcome cache warm-up failed');
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
    log.error({ err: error }, 'outcome badge error');
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
    log.error({ err: error }, 'outcome badges batch error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to compute outcome badges' });
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

    // Local mode only: a fresh mtime-keyed hit is authoritative, because the
    // transcript on disk IS the source and the cache is keyed to its mtime.
    //
    // In server mode this must NOT short-circuit. The synced markers row and the
    // metadata row carry the same mtime, so a thinned row looks perfectly
    // "fresh" and would be returned unconditionally — which is exactly what
    // happened in prod: 3 prompts served for a session whose envelope holds 67.
    // There, freshness is not evidence of fullness, so the cached row is demoted
    // to just another candidate below.
    if (resolved && !isServerMode()) {
      const cached = await getCachedMarkers(id, resolved.mtime);
      if (cached) {
        const etag = buildETag([id, 'markers', resolved.mtime]);
        if (maybeSendNotModified(req, res, etag)) return;
        return res.json(cached);
      }
    }

    // Server mode: there is no transcript on disk, and THREE sources can answer.
    // Take whichever yields the MOST prompts, so a thin synced row can never
    // mask a fuller source. `GET /:id` already tiers this way (:1563-1611);
    // markers was the only route in this router that didn't, and that asymmetry
    // is how a truncated transcript made the UI (1035 messages) and
    // recall_user_prompts (3 prompts) disagree about the same session: the raw
    // archive refused the downgrade (putRawSession is shrink-protected) while
    // the derived markers row accepted it in the very same sync.
    if (isServerMode()) {
      const candidates: MarkersPayload[] = [];

      // 1. The synced markers row — what this route used to return
      //    unconditionally. Both the mtime-fresh row and the latest-by-any-mtime
      //    row are considered, since neither being "fresh" implies being full.
      let rowCount = 0;
      if (resolved) {
        const fresh = await getCachedMarkers(id, resolved.mtime);
        if (fresh?.prompts?.length) { candidates.push(fresh); rowCount = fresh.prompts.length; }
      }
      const stale = await getStaleHeavy<MarkersPayload>(id, 'markers');
      const staleCount = stale?.data?.prompts?.length ?? 0;
      if (staleCount > 0) { candidates.push(stale!.data); rowCount = Math.max(rowCount, staleCount); }

      const store = await createStore();
      try {
        // 2. The full synced conversation envelope — the same source `GET /:id`
        //    prefers. Carries real line numbers and timestamps (see
        //    `envelopeFromTurns`, routes/sync.ts:203-210), unlike the chunks.
        let gotEnvelope = false;
        const snapshot = await store.getCachedContentStale(id, 'session');
        if (snapshot) {
          try {
            const parsed = JSON.parse(snapshot.content) as {
              messages?: Array<{ line?: number; role?: string; content?: string; timestamp?: string }>;
            };
            const prompts = (parsed.messages ?? [])
              .filter((m) => m.role === 'user' && m.content && m.content.trim())
              .map((m, i) => {
                const parsedTs = m.timestamp ? Date.parse(m.timestamp) : NaN;
                return {
                  line: m.line ?? i + 1,
                  ts: Number.isFinite(parsedTs) ? parsedTs : 0,
                  tsIso: m.timestamp,
                  ...markPrompt(m.content!),
                };
              });
            if (prompts.length > 0) {
              candidates.push({ sessionId: id, prompts, summary: summarizeMarkers(prompts) });
              gotEnvelope = true;
            }
          } catch { /* corrupt envelope row — fall through to chunks */ }
        }

        // 3. Per-turn chunks, only when the envelope is missing or corrupt.
        //    Lowest fidelity: synthetic line numbers, no timestamps — same
        //    trade-off `GET /:id` documents at :1558-1562. It also OVER-counts:
        //    long turns are split into ~2KB chunks at ingest, so one user
        //    message can be several `user*` chunks (measured on a real session:
        //    67 user messages in the envelope vs 86 user chunks). That is why
        //    this is gated on the envelope being unavailable rather than folded
        //    into the max() below — otherwise fragments would beat real prompts.
        if (!gotEnvelope) {
          const chunks = await store.listChunksByItem('session', id);
          const prompts = chunks
            .filter((c) => c.chunk_type.startsWith('user') && c.text && c.text.trim())
            .map((c, i) => ({ line: i + 1, ts: 0, tsIso: undefined, ...markPrompt(c.text) }));
          if (prompts.length > 0) {
            candidates.push({ sessionId: id, prompts, summary: summarizeMarkers(prompts) });
          }
        }
      } finally {
        await store.close();
      }

      if (candidates.length === 0) {
        return res.status(404).json({ error: 'No synced markers for this session' });
      }
      const best = candidates.reduce((a, b) => (b.prompts.length > a.prompts.length ? b : a));
      // Promote a rebuild into the mtime-keyed cache so the next read is cheap.
      // Only when it actually beats every stored row — never cache a downgrade.
      // (setCompute enforces the same rule independently; this just avoids a
      // pointless write.)
      if (resolved && best.prompts.length > rowCount) {
        await setCachedMarkers(id, resolved.mtime, best);
      }
      return res.json(best);
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
    log.error({ err: error }, 'markers error');
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
    log.error({ err: error }, 'related items error');
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
    log.error({ err: error }, 'session metadata error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get session metadata',
    });
  }
});

// Transient upstream failures (gateway 5xx/429, provider hiccups, dropped
// connections) that a short retry usually absorbs. Anything else — auth,
// misconfiguration, unsummarizable content — fails immediately; retrying
// cannot fix those.
const TRANSIENT_SUMMARY_ERROR =
  /\b(429|502|503|504)\b|upstream_failed|retryable|rate.?limit|timed?\s?out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up/i;

const REGEN_ATTEMPTS = 3;
const REGEN_BACKOFF_MS = 2000;

/**
 * Generate a summary, retrying transient upstream failures with linear
 * backoff (2s, then 4s) so a seconds-long provider blip never reaches the
 * user. Non-transient errors and outages that outlast the backoff window
 * still throw — the route records those in the summary_errors ledger.
 * `backoffMs` is injectable for tests only.
 */
export async function generateSummaryWithRetry(
  generator: Pick<SummaryGenerator, 'generate'>,
  content: Parameters<SummaryGenerator['generate']>[0],
  backoffMs = REGEN_BACKOFF_MS,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= REGEN_ATTEMPTS; attempt++) {
    try {
      return await generator.generate(content);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === REGEN_ATTEMPTS || !TRANSIENT_SUMMARY_ERROR.test(msg)) throw e;
      log.warn({ attempt, msg: msg.slice(0, 200) }, 'regenerate-summary: transient upstream failure, retrying');
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
  }
  throw lastErr;
}

// POST /api/conversations/:id/regenerate-summary
//
// On-demand re-generation of an AI summary for a single session.
//
//   local mode  — parse the on-disk JSONL and summarize with the provider
//                 configured in settings (CLI/Gemini/Claude/Ollama).
//   server mode — there is no JSONL on disk; rebuild SessionContent from the
//                 synced content_cache envelope and summarize with the
//                 server-configured provider (serverSummaryConfig / env).
//
// Existing cached summary (if any) is overwritten on success. Failures are
// recorded in the summary_errors ledger (same one the background sweep
// reads), so a failed regenerate is durable and diagnosable, not just an
// HTTP response the user may have closed.
router.post('/:id/regenerate-summary', async (req, res) => {
  const { id } = req.params;
  try {
    // Free tenants receive no AI summaries anywhere: the background sweep skips
    // them (summary-worker), so an on-demand path that still generated would be
    // the loophole. 'insights' is the AI-analysis tier the free plan lacks —
    // featureRequired names the cheapest plan that restores it. Self-host is
    // never gated: tenantLimits() returns FULL_LIMITS with billing off.
    if (!(await tenantLimits(req.tenant || 'default')).summaries) {
      return res.status(402).json(featureRequired('insights'));
    }

    let content: Awaited<ReturnType<typeof parseSessionFile>> | SessionContent;
    let summary: string;
    let summarySource: string;

    if (isServerMode()) {
      // No filesystem: rebuild from the synced envelope, summarize with the
      // server's configured provider. Same path the background sweep uses.
      const config = serverSummaryConfig();
      if (!config) {
        return res.status(501).json({
          error: 'summary generation not configured',
          detail: 'Set SUMMARY_PROVIDER (and a key/model) on the server to enable summary regeneration.',
        });
      }

      const store = await createStore();
      let raw: string | null;
      try {
        // mtime >= 0 → latest synced envelope regardless of metadata mtime.
        raw = await store.getCachedContent(id, 'session', 0);
      } finally {
        await store.close();
      }
      if (!raw) return res.status(404).json({ error: 'Session not synced' });

      const envelope = JSON.parse(raw) as CachedEnvelope;
      const built = envelopeToSessionContent(id, envelope);
      if (!built) return res.status(422).json({ error: 'Session has no summarizable content' });
      content = built;

      const generator = new SummaryGenerator(config);
      summary = await generateSummaryWithRetry(generator, built);
      summarySource = providerToSource(config.provider);
    } else {
      const path = getSessionPath(id); // throws if missing
      const parsed = await parseSessionFile(path);
      content = parsed;

      const settings = loadSettings();
      const provider = (settings.summary?.provider as any) || (process.env.SUMMARY_PROVIDER as any) || 'cli';
      const cliCommand = settings.summary?.cliCommand || process.env.SUMMARY_CLI_CMD;
      const generator = new SummaryGenerator({ provider, cliCommand });

      summary = await generateSummaryWithRetry(generator, parsed);
      summarySource = provider === 'gemini-cli' ? 'gemini' : provider;
    }

    const cache = await createMetadataCache();
    try {
      await cache.set({
        sessionId: id,
        firstPrompt: content.firstPrompt || '',
        summary,
        summarySource: summarySource as any,
        mtime: Date.now(),
        indexedAt: Date.now(),
      });
      await cache.clearSummaryError(id);
    } finally {
      await cache.close();
    }

    res.json({ sessionId: id, summary, summarySource });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Surface quota errors with a 429 so the UI can render a clear message
    const status = /QUOTA_EXHAUSTED|429|exhausted your capacity|rate.?limit/i.test(msg) ? 429 : 500;
    log.error({ id, msg: msg.slice(0, 300) }, 'regenerate-summary failed');
    // Durable failure record: the summary_errors ledger is what ops and the
    // background sweep read. For a still-unsummarized session this also hands
    // the retry over to the sweep's backoff machinery. Best-effort — the
    // ledger write must never mask the real error.
    try {
      const cache = await createMetadataCache();
      try { await cache.recordSummaryError(id, msg); } finally { await cache.close(); }
    } catch { /* best-effort */ }
    res.status(status).json({ error: msg.slice(0, 500) });
  }
});

// PATCH /api/conversations/:id
//
// Set or clear a user-assigned conversation name (mirrors Claude Code's
// /rename). Stored in session_metadata.user_title, which the indexer/summary
// upsert never touches — so the name survives every re-sync. Body:
//   { "name": "auth refactor" }  → set
//   { "name": "" } | { "name": null }  → clear (revert to auto title)
// Tenant scope + prefix-id expansion are inherited from router.param('id').
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const body = (req.body ?? {}) as { name?: unknown; title?: unknown };
    const input = body.name ?? body.title;
    let title: string | null;
    if (input === null || input === undefined || (typeof input === 'string' && input.trim() === '')) {
      title = null; // clear → revert to auto-derived title
    } else if (typeof input === 'string') {
      title = input.trim().slice(0, 200);
    } else {
      return res.status(400).json({ error: 'name must be a string' });
    }
    const cache = await createMetadataCache();
    try {
      await cache.setUserTitle(id, title);
    } finally {
      await cache.close();
    }
    res.json({ sessionId: id, userTitle: title });
  } catch (error) {
    log.error({ id, err: error }, 'rename failed');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to rename session' });
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
      } else if (id.startsWith('agy_')) {
        tool = 'agy';
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
      const PARSER_VERSION = 6;
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
        // Prefer the LATEST envelope even when its mtime lags the metadata
        // row (mid-backfill, or an active session that grew since the last
        // sync). A complete snapshot beats the text-only chunk fallback.
        const stale = await store.getCachedContentStale(id, 'session');
        if (stale) {
          try {
            const parsed = JSON.parse(stale.content);
            if (parsed && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
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
                snapshotMtime: stale.mtime,
              });
            }
          } catch { /* corrupt row — fall through to chunks */ }
        }
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
      } else if (tool === 'agy') {
        // Antigravity — parse through the generic event bridge (no hand-
        // written parser; the ToolBackend's readEvents() feeds
        // canonicalEventsToMessages). Same path parseTranscript uses.
        const backend = getBackendForId(id);
        if (!backend) throw new Error('No backend registered for agy sessions');
        messages = canonicalEventsToMessages(backend.readEvents(id));
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
    log.error({ err: error }, 'conversation error');

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
      const { openSqliteReadonlyOrThrow } = await import('@chat-recall/engine/core/sqlite-reader.js');
      const path = opencodeBackend.dbPath();
      try {
        // Throws on a missing file rather than creating an empty one.
        const db = openSqliteReadonlyOrThrow(path);
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
        log.error({ err: e }, 'opencode raw error');
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
    log.error({ err: error }, 'raw conversation error');

    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get raw conversation',
    });
  }
});

// GET /api/conversations/:id/raw-archive
//
// Serve the shrink-protected `raw_sessions` archive for a session. Unlike
// `/:id/raw` (which reads the local filesystem and is 501 in server mode), this
// reads the archived, redacted raw container the sync path stored — so it works
// on the SaaS and self-host alike. It is the recovery path's source of truth:
// `chat-recall repair` pulls this to seed the local shadow and rebuild a
// history an upstream tool truncated in place.
//
// Response (JSON): { sessionId, tool, mtime, size, capturedAt, gzB64, messages }.
//   gzB64    — base64 of the gzipped RawContainer (feed to seedShadow / gunzip).
//   messages — count parsed from the container (for quick verification).
//
// `?count=1` — read-only discovery mode for the `repair --all` sweep: parse and
// return the message count + byte size WITHOUT the gzB64 payload. Same read, no
// multi-MB transfer per session, so a scan of many sessions stays cheap. This
// endpoint never mutates anything in either mode.
router.get('/:id/raw-archive', async (req, res) => {
  const { id } = req.params;
  const countOnly = req.query.count === '1' || req.query.count === 'true';
  const store = await createStore();
  try {
    const row = await store.getRawSession(id);
    if (!row) return res.status(404).json({ error: 'No raw archive for this session' });

    let messages = 0;
    try {
      const container = gunzipContainer(row.gz);
      if (container) messages = parseTranscriptFromContainer(container).messages.length;
    } catch { /* corrupt archive — still return metadata/bytes so the caller can inspect */ }

    res.json({
      sessionId: id,
      tool: row.tool,
      mtime: row.mtime,
      size: row.size,
      capturedAt: row.captured_at,
      messages,
      ...(countOnly ? {} : { gzB64: Buffer.from(row.gz).toString('base64') }),
    });
  } catch (error) {
    log.error({ err: error, session: id }, 'raw-archive error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read raw archive' });
  } finally {
    await store.close();
  }
});

export default router;
