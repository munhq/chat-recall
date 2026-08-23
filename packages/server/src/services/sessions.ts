/**
 * Session listing service.
 */

import { getAllSessions, parseSessionFile, createMetadataCache, createStore, createOutcomeCache, findCodexSessionFile, extractFirstUserPromptSync, codexBackend, getBackendForId } from '../imports.js';
import type { SessionEntry, SessionMetadata, MemoryMetadataRow, MemoryLinkRow, SourceType, CachedOutcome } from '../imports.js';
import { isServerMode } from '../util/mode.js';
import { join } from 'path';

/**
 * Local-mode-only iterator over the Claude filesystem walk. In server mode
 * (store-only deployment) data arrives exclusively via /api/sync — the server
 * must NEVER walk its own container home looking for transcripts. Every
 * `getAllSessions()` consumer in this service goes through this guard.
 */
function* localSessionsWalk(): Generator<[SessionEntry, string]> {
  if (isServerMode()) return;
  yield* getAllSessions();
}

// Client banners like "MCP issues detected. Run /mcp list for status." are
// prepended by Claude Code to the first user message when an MCP server fails.
// They leaked into older cached summaries/firstPrompts; strip on the way out
// so consumers never see them regardless of what's in the metadata cache.
const INJECTED_BANNERS: RegExp[] = [
  /MCP issues detected\. ?Run \/mcp list for status\.?/g,
  /Context low[^\n]*Run \/compact[^\n]*/g,
  /API Error:[^\n]{0,120}/g,
];
function cleanBanner(text: string | undefined): string | undefined {
  if (!text) return text;
  let out = text;
  for (const re of INJECTED_BANNERS) out = out.replace(re, ' ');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

export interface SessionInfo {
  sessionId: string;
  projectPath: string;
  /** Logical cleartext project id (e.g. `git:github.com/me/repo`). The UI
   *  groups/displays by this so users never see a privacy-hashed path. */
  projectId?: string;
  created: string;
  modified: string;
  fileMtime: number;
  filePath: string;
  firstPrompt?: string;
  summary?: string;
  tool?: string; // any AiTool: claude | gemini | opencode | codex | agy | cursor
  /** Single-prompt invocation (batch/bot run). UI shows a "one-shot" badge. */
  oneShot?: boolean;
  /**
   * Populated when summary generation has been attempted and failed
   * (recorded by the indexer's summary worker). UI uses this to show
   * "summary unavailable — check settings" instead of silently falling
   * back to first-prompt with no explanation. `null`/absent means no
   * attempt has happened yet (still pending) or the session has a
   * successful summary.
   */
  summaryError?: { error: string; attemptCount: number; lastFailedAt: number };
  /** User-assigned conversation name (mirrors Claude Code's /rename). When
   *  set, the UI and recall_recent show it in place of the auto summary. */
  userTitle?: string | null;
  /** Native title from the originating tool (Claude ai-title, OpenCode
   *  session.title, …). Display fallback below userTitle, above the summary. */
  toolTitle?: string | null;
  /** What actually happened — from the synced outcome classifier, attached
   *  in one batch so list rows never pay a per-row badge fetch.
   *  `discussion` = the classifier's 'unknown' with zero file edits, i.e. a
   *  talk-only session; real 'unknown' (files touched, outcome unclear) is
   *  passed through and hidden by the UI. */
  outcome?: {
    status: 'shipped' | 'abandoned' | 'interrupted' | 'in_progress' | 'completed' | 'discussion' | 'unknown';
    files: number;
    linesAdded: number;
    linesRemoved: number;
    commits: number;
  };
}

/**
 * Get recent sessions from all tools (Claude, Gemini, OpenCode),
 * sorted by modification time.
 */
export async function getRecentSessions(limit = 20): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  const cache = await createMetadataCache();

  // 1. Claude sessions from filesystem — local mode only (no-op on a server).
  for (const [entry, filePath] of localSessionsWalk()) {
    const cached = await cache.get(entry.sessionId);

    let firstPrompt = entry.firstPrompt || '';
    let summary: string | undefined = undefined;

    if (cached) {
      firstPrompt = cached.firstPrompt;
      summary = cached.summary;
    } else if (!firstPrompt) {
      // Fallback chain when cache is cold and the index entry has no
      // firstPrompt:
      //   1) cheap line-by-line scan for the first user prompt — bounded
      //      to ~500 lines, terminates early. This is the common case on
      //      a fresh DB and is what stops list rows reading
      //      "(no prompt captured)".
      //   2) full `parseSessionFile` to also extract embedded summaries.
      //      Only run when (1) finds nothing, since this walks the whole
      //      transcript and was the bottleneck on a 200-session list.
      try {
        firstPrompt = extractFirstUserPromptSync(filePath, { maxLength: 200 });
      } catch {}
      if (!firstPrompt) {
        try {
          const content = await parseSessionFile(filePath);
          firstPrompt = content.firstPrompt || firstPrompt;
          summary = content.summaries.length > 0 ? content.summaries[0] : undefined;
        } catch {}
      }
    }

    sessions.push({
      sessionId: entry.sessionId,
      projectPath: entry.projectPath,
      created: entry.created,
      modified: entry.modified,
      fileMtime: entry.fileMtime,
      filePath,
      firstPrompt: cleanBanner(firstPrompt) ?? '',
      summary: cleanBanner(summary),
      tool: 'claude',
    });
  }

  await cache.close();

  // 1b. Codex sessions from filesystem
  try {
    const { existsSync, readdirSync, statSync, readFileSync } = await import('fs');
    const { join } = await import('path');
    const codexSessionsDir = codexBackend.sessionsDir();
    // Same local-mode-only rule as localSessionsWalk(): never walk the
    // server host's own home for Codex rollouts in a deployment.
    if (!isServerMode() && existsSync(codexSessionsDir)) {
      const seenIds = new Set(sessions.map(s => s.sessionId));
      const years = readdirSync(codexSessionsDir);
      for (const year of years) {
        const yearDir = join(codexSessionsDir, year);
        const months = readdirSync(yearDir);
        for (const month of months) {
          const monthDir = join(yearDir, month);
          const days = readdirSync(monthDir);
          for (const day of days) {
            const dayDir = join(monthDir, day);
            const files = readdirSync(dayDir);
            for (const file of files) {
              if (!file.endsWith('.jsonl') || !file.startsWith('rollout-')) continue;
              const filePath = join(dayDir, file);
              const st = statSync(filePath);
              const mtime = st.mtimeMs;
              // Canonical id uses ONLY the UUID portion of the filename
              // (e.g. `019de782-…`), matching what the indexer (which uses
              // `meta.id` from the session_meta event) records. If we
              // included the timestamp prefix here too the same parent
              // would surface twice — once from this filesystem walk,
              // once from MemoryStore — under different ids.
              const uuidMatch = file.match(/([a-f0-9-]{36})\.jsonl$/i);
              if (!uuidMatch) continue;
              const sessionId = `codex_${uuidMatch[1]}`;
              if (seenIds.has(sessionId)) continue;

              let firstPrompt = '';
              let projectPath = '';
              let isSubagent = false;
              let hasSessionMeta = false;
              try {
                const lines = readFileSync(filePath, 'utf-8').split('\n');
                for (const line of lines) {
                  if (!line.trim()) continue;
                  try {
                    const obj = JSON.parse(line);
                    if (obj.type === 'session_meta' && obj.payload) {
                      hasSessionMeta = true;
                      projectPath = obj.payload.cwd || '';
                      // Codex spawns one rollout file per sub-agent dispatch.
                      // The sub-agent's session_meta carries thread_spawn /
                      // agent_role — the user-facing parent does not. Skip
                      // sub-agents so a single conversation doesn't surface
                      // as N top-level sessions.
                      if (obj.payload.source?.subagent?.thread_spawn ||
                          obj.payload.agent_role ||
                          obj.payload.agent_nickname) {
                        isSubagent = true;
                      }
                    }
                    if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
                      if (!firstPrompt) firstPrompt = obj.payload.message || '';
                    }
                  } catch {}
                }
              } catch {}
              // Pre-1.0 Codex rollout files have no session_meta event and
              // no user_message — they're not loadable as conversations,
              // so don't surface them in the UI list.
              if (isSubagent) continue;
              if (!hasSessionMeta && !firstPrompt) continue;

              sessions.push({
                sessionId,
                projectPath,
                created: new Date(mtime).toISOString(),
                modified: new Date(mtime).toISOString(),
                fileMtime: mtime,
                filePath,
                firstPrompt: cleanBanner(firstPrompt)?.slice(0, 200) ?? '',
                summary: undefined,
                tool: 'codex',
              });
            }
          }
        }
      }
    }
  } catch {}

  // 2. Gemini and OpenCode sessions from MemoryStore (indexed items).
  //    Summaries are looked up in MetadataCache keyed by the item id
  //    (e.g. "gemini_<sessionId>" / "opencode_<sessionId>") — populated
  //    by scripts/generate-summaries.ts once it's run.
  const store = await createStore();
  const cache2 = await createMetadataCache();
  try {
    const memItems = await store.listItems('session' as SourceType, 5000, 0);
    const seenIds = new Set(sessions.map(s => s.sessionId));

    for (const item of memItems) {
      if (seenIds.has(item.id)) continue; // Skip Claude sessions (already added)

      const extra = JSON.parse(item.extra_json || '{}');
      const tool = extra.tool as string;
      if (!tool || tool === 'claude') continue; // Only add non-Claude

      const cached = await cache2.get(item.id);

      sessions.push({
        sessionId: item.id,
        projectPath: item.project_path,
        created: new Date(item.mtime).toISOString(),
        modified: new Date(item.mtime).toISOString(),
        fileMtime: item.mtime,
        filePath: item.file_path,
        firstPrompt: cleanBanner(cached?.firstPrompt || item.content_preview || item.title),
        summary: cleanBanner(cached?.summary),
        tool,
      });
    }
  } finally {
    await store.close();
    await cache2.close();
  }

  // Sort by modification time (newest first)
  sessions.sort((a, b) => b.fileMtime - a.fileMtime);

  return limit > 0 ? sessions.slice(0, limit) : sessions;
}

/**
 * Lightweight session index entry — just enough to sort, filter, and
 * decide which sessions need full hydration. No firstPrompt, no summary.
 *
 * `sessionId` is the canonical id (with `codex_`/`gemini_`/`opencode_`
 * prefix where applicable). `filePath` is the on-disk JSONL path when
 * available — used to stat the file for outcome badges and for hydration.
 */
export interface SessionIndexEntry {
  sessionId: string;
  projectPath: string;
  /** Logical cleartext project id, passed through to the hydrated SessionInfo. */
  projectId?: string;
  mtime: number;
  tool: 'claude' | 'codex' | 'gemini' | 'opencode' | 'agy' | 'cursor';
  filePath?: string;
  /** Pre-computed when available (Claude sessions-index.json). Used to
   *  short-circuit hydration when the index already has it. */
  preIndexedFirstPrompt?: string;
  /** Single-prompt invocation (batch/bot run) — synced flag from extra_json. */
  oneShot?: boolean;
}

/**
 * Tools whose sessions reach the local listing only through MemoryStore.
 *
 * Claude and Codex are walked from the filesystem earlier in this module, so
 * they are deliberately absent — including them would double-count. Every
 * other backend has no per-session file to walk, so a tool missing from this
 * set is silently dropped from `recent` and from the project counts.
 */
const STORE_BACKED_TOOLS = new Set<SessionIndexEntry['tool']>(['gemini', 'opencode', 'agy', 'cursor']);

/**
 * Build the light session index across all tools — single pass, no
 * firstPrompt extraction. The result is what pagination filters, sorts,
 * and slices over before hydrating only the visible page.
 *
 * Sorted newest-first by mtime so callers can `slice(offset, offset+limit)`
 * directly to get the requested page.
 */
export async function getSessionIndex(): Promise<SessionIndexEntry[]> {
  const out: SessionIndexEntry[] = [];

  // 1. Claude sessions — walk the index entries (no parseSessionFile).
  //    Local mode only (no-op on a server deployment).
  for (const [entry, filePath] of localSessionsWalk()) {
    out.push({
      sessionId: entry.sessionId,
      projectPath: entry.projectPath || '',
      mtime: entry.fileMtime || 0,
      tool: 'claude',
      filePath,
      preIndexedFirstPrompt: entry.firstPrompt || undefined,
    });
  }

  // 2. Codex sessions — read just the session_meta line for cwd; no
  //    firstPrompt scan, no full parse.
  try {
    const { existsSync, readdirSync, statSync, readFileSync } = await import('fs');
    const { join } = await import('path');
    const codexSessionsDir = codexBackend.sessionsDir();
    // Same local-mode-only rule as localSessionsWalk(): never walk the
    // server host's own home for Codex rollouts in a deployment.
    if (!isServerMode() && existsSync(codexSessionsDir)) {
      for (const year of readdirSync(codexSessionsDir)) {
        for (const month of readdirSync(join(codexSessionsDir, year))) {
          for (const day of readdirSync(join(codexSessionsDir, year, month))) {
            const dayDir = join(codexSessionsDir, year, month, day);
            for (const file of readdirSync(dayDir)) {
              if (!file.endsWith('.jsonl') || !file.startsWith('rollout-')) continue;
              const filePath = join(dayDir, file);
              const uuidMatch = file.match(/([a-f0-9-]{36})\.jsonl$/i);
              if (!uuidMatch) continue;
              const sessionId = `codex_${uuidMatch[1]}`;
              try {
                const head = readFileSync(filePath, 'utf-8').split('\n', 5);
                let cwd = '';
                let isSubagent = false;
                for (const line of head) {
                  if (!line.trim()) continue;
                  try {
                    const obj = JSON.parse(line);
                    if (obj.type === 'session_meta' && obj.payload) {
                      cwd = obj.payload.cwd || '';
                      if (obj.payload.source?.subagent?.thread_spawn ||
                          obj.payload.agent_role ||
                          obj.payload.agent_nickname) {
                        isSubagent = true;
                      }
                      break;
                    }
                  } catch { /* skip */ }
                }
                if (isSubagent) continue;
                if (!cwd) continue;
                out.push({
                  sessionId,
                  projectPath: cwd,
                  mtime: statSync(filePath).mtimeMs,
                  tool: 'codex',
                  filePath,
                });
              } catch { /* unreadable — skip */ }
            }
          }
        }
      }
    }
  } catch { /* codex dir missing */ }

  // 3. Gemini + OpenCode — already in MemoryStore.
  try {
    const store = await createStore();
    try {
      const items = await store.listItems('session' as SourceType, 100_000, 0);
      for (const item of items) {
        let extra: Record<string, unknown> = {};
        try { extra = JSON.parse(item.extra_json || '{}'); } catch {}
        // Claude and Codex are walked from the filesystem above; the rest have
        // no per-session file of their own and only exist in MemoryStore.
        const tool = extra.tool as SessionIndexEntry['tool'] | undefined;
        if (!tool || !STORE_BACKED_TOOLS.has(tool)) continue;
        out.push({
          sessionId: item.id,
          projectPath: item.project_path || '',
          mtime: item.mtime || 0,
          tool,
          filePath: item.file_path || undefined,
          preIndexedFirstPrompt: item.content_preview || item.title || undefined,
        });
      }
    } finally {
      await store.close();
    }
  } catch { /* MemoryStore unavailable */ }

  // Newest first. Stable enough — mtime collisions are rare.
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * Hydrate a slice of the session index — only the requested rows get
 * firstPrompt + summary lookups. This is what makes pagination cheap:
 * walk all 575 sessions to build the index (fast, no parse), then
 * extractFirstUserPromptSync only on the 20 you're actually showing.
 */
export async function hydrateSessions(entries: SessionIndexEntry[]): Promise<SessionInfo[]> {
  const cache = await createMetadataCache();
  // One batched outcome read for the whole page — the list must say what
  // happened (shipped/abandoned/interrupted/discussion + change size) without
  // a per-row badge round-trip. Best-effort: rows render without it.
  let outcomes = new Map<string, CachedOutcome>();
  try {
    const oc = await createOutcomeCache();
    try {
      outcomes = await oc.getMany(entries.map(e => e.sessionId));
    } finally {
      await oc.close();
    }
  } catch { /* outcome-less rows are fine */ }
  try {
    const errors = await cache.getSummaryErrors(entries.map(e => e.sessionId));

    const result: SessionInfo[] = [];
    // Sessions whose firstPrompt was extracted on this request — write
    // them back to the cache in a single batch at the end so we never
    // re-extract for the same (sessionId, mtime) pair. Avoids the per-
    // request `extractFirstUserPromptSync` × N cost that was pure waste.
    const toPersist: Array<{ sessionId: string; firstPrompt: string; mtime: number }> = [];

    for (const e of entries) {
      const cached = await cache.get(e.sessionId);
      let firstPrompt = e.preIndexedFirstPrompt || '';
      let summary: string | undefined;
      let needsPersist = false;

      if (cached) {
        firstPrompt = cached.firstPrompt || firstPrompt;
        summary = cached.summary;
      } else if (!firstPrompt && e.tool === 'claude' && e.filePath) {
        try {
          firstPrompt = extractFirstUserPromptSync(e.filePath, { maxLength: 200 });
          if (firstPrompt) needsPersist = true;
        } catch {}
      } else if (!firstPrompt && e.preIndexedFirstPrompt) {
        // Codex/Gemini/OpenCode: have a preIndexedFirstPrompt from the
        // source walk but no cache row yet. Persist what we have so the
        // summary worker can later upgrade the row with an AI summary.
        firstPrompt = e.preIndexedFirstPrompt;
        needsPersist = true;
      }

      if (needsPersist && firstPrompt) {
        toPersist.push({ sessionId: e.sessionId, firstPrompt, mtime: e.mtime });
      }

      const iso = new Date(e.mtime || 0).toISOString();
      const oc = outcomes.get(e.sessionId);
      result.push({
        sessionId: e.sessionId,
        projectPath: e.projectPath,
        projectId: e.projectId || '',
        created: iso,
        modified: iso,
        fileMtime: e.mtime,
        filePath: e.filePath || '',
        firstPrompt: cleanBanner(firstPrompt) ?? '',
        summary: cleanBanner(summary),
        tool: e.tool,
        oneShot: e.oneShot,
        summaryError: !summary && errors.has(e.sessionId) ? errors.get(e.sessionId)! : undefined,
        userTitle: cached?.userTitle ?? undefined,
        toolTitle: cached?.toolTitle ?? undefined,
        outcome: oc ? {
          status: oc.status === 'unknown' && oc.fileCount === 0 ? 'discussion' : oc.status,
          files: oc.fileCount,
          linesAdded: oc.linesAdded,
          linesRemoved: oc.linesRemoved,
          commits: oc.commits,
        } : undefined,
      });
    }

    // Single bulk write — never blocks the response (we've already built
    // the result array and the persistence is best-effort future-cache).
    for (const row of toPersist) {
      try {
        await cache.set({
          sessionId: row.sessionId,
          firstPrompt: row.firstPrompt,
          summary: '',
          summarySource: 'original',
          mtime: row.mtime,
          indexedAt: Date.now(),
        });
      } catch { /* benign — next request will retry */ }
    }

    return result;
  } finally {
    await cache.close();
  }
}

/**
 * Count sessions per project across all tools — without loading firstPrompts,
 * summaries, or anything else expensive. Used by `/api/status` which only
 * needs aggregate counts; loading firstPrompts via `getRecentSessions(0)`
 * was the bottleneck that turned status into a 40+ second request after
 * a service restart (extractFirstUserPromptSync × 574 sessions).
 *
 * Returns `{ projects, total }` so callers can produce the same shape the
 * status endpoint already uses without a second pass.
 */
export async function getSessionProjectCounts(): Promise<{ projects: Record<string, number>; total: number }> {
  const projects: Record<string, number> = {};
  let total = 0;

  // 1. Claude sessions — walk the index entries (no parseSessionFile, no
  //    extractFirstUserPromptSync — just project paths). Local mode only.
  for (const [entry] of localSessionsWalk()) {
    const p = entry.projectPath || '';
    if (p) projects[p] = (projects[p] || 0) + 1;
    total++;
  }

  // 2. Codex sessions — single walk over rollout files; we need the
  //    session_meta event for projectPath, but that's the first event in
  //    each rollout so we can stop reading after we find it.
  try {
    const { existsSync, readdirSync, readFileSync } = await import('fs');
    const { join } = await import('path');
    const codexSessionsDir = codexBackend.sessionsDir();
    // Same local-mode-only rule as localSessionsWalk(): never walk the
    // server host's own home for Codex rollouts in a deployment.
    if (!isServerMode() && existsSync(codexSessionsDir)) {
      for (const year of readdirSync(codexSessionsDir)) {
        for (const month of readdirSync(join(codexSessionsDir, year))) {
          for (const day of readdirSync(join(codexSessionsDir, year, month))) {
            const dayDir = join(codexSessionsDir, year, month, day);
            for (const file of readdirSync(dayDir)) {
              if (!file.endsWith('.jsonl') || !file.startsWith('rollout-')) continue;
              try {
                // Read just enough to find session_meta — the first event.
                const head = readFileSync(join(dayDir, file), 'utf-8').split('\n', 5);
                let cwd = '';
                let isSubagent = false;
                for (const line of head) {
                  if (!line.trim()) continue;
                  try {
                    const obj = JSON.parse(line);
                    if (obj.type === 'session_meta' && obj.payload) {
                      cwd = obj.payload.cwd || '';
                      if (obj.payload.source?.subagent?.thread_spawn ||
                          obj.payload.agent_role ||
                          obj.payload.agent_nickname) {
                        isSubagent = true;
                      }
                      break;
                    }
                  } catch { /* skip */ }
                }
                if (isSubagent) continue;
                if (cwd) projects[cwd] = (projects[cwd] || 0) + 1;
                total++;
              } catch { /* skip unreadable */ }
            }
          }
        }
      }
    }
  } catch { /* codex dir missing or unreadable */ }

  // 3. Store rows. In LOCAL mode only gemini/opencode/agy live here (claude +
  //    codex were counted from disk above — counting their rows again would
  //    double-count). In SERVER mode the store is the ONLY source: branches
  //    1–2 are disabled there, and synced Claude/Codex sessions are store rows
  //    like everything else. Filtering them out on the server made
  //    totalSessions read 0 with thousands synced — which kept the first-run
  //    "connect your machine" hero up forever for a fully-synced user.
  try {
    const store = await createStore();
    try {
      // listItems pages — pass a generous cap that's larger than any
      // realistic local session count.
      const items = await store.listItems('session' as SourceType, 100_000, 0);
      const serverMode = isServerMode();
      for (const item of items) {
        let extra: Record<string, unknown> = {};
        try { extra = JSON.parse(item.extra_json || '{}'); } catch {}
        const tool = extra.tool as SessionIndexEntry['tool'] | undefined;
        if (!serverMode && (!tool || !STORE_BACKED_TOOLS.has(tool))) continue;
        const p = item.project_path || '';
        if (p) projects[p] = (projects[p] || 0) + 1;
        total++;
      }
    } finally {
      await store.close();
    }
  } catch { /* MemoryStore unavailable — claude+codex counts still useful */ }

  return { projects, total };
}

/**
 * Get session file path from session ID.
 */
export function getSessionPath(sessionId: string): string {
  // Session files are typically stored in ~/.claude/projects/<project-path>/<session-id>.jsonl
  // We need to search for it. Local mode only — a server has no transcripts on disk.
  for (const [entry, filePath] of localSessionsWalk()) {
    if (entry.sessionId === sessionId) {
      return filePath;
    }
  }

  throw new Error(`Session not found: ${sessionId}`);
}

/**
 * Bulk lookup: build the (sessionId → filePath) map in a SINGLE pass over
 * `getAllSessions()`, then pluck the requested ids out of it.
 *
 * Why this exists: the batch outcome endpoint resolves dozens of ids per
 * request. Calling `getSessionPath` per id walks the entire ~3000-session
 * project tree N times — quadratic. This function turns N walks into one.
 */
export function getSessionPaths(sessionIds: string[]): Map<string, string> {
  const want = new Set(sessionIds);
  const out = new Map<string, string>();
  if (want.size === 0) return out;
  // Local mode only — a server deployment never walks its own container home.
  for (const [entry, filePath] of localSessionsWalk()) {
    if (want.has(entry.sessionId)) {
      out.set(entry.sessionId, filePath);
      // Early exit when we've found everything we were asked about.
      if (out.size === want.size) break;
    }
  }
  return out;
}

// --- Related items ---

export interface RelatedItem {
  id: string;
  sourceType: string;
  title: string;
  contentPreview: string;
  projectPath: string;
  mtime: number;
  linkType: string;
  confidence: number;
}

export interface RelatedItemsResponse {
  links: RelatedItem[];
  siblingSessionsInProject: Array<{
    sessionId: string;
    firstPrompt: string;
    summary?: string;
    modified: string;
  }>;
  projectClaudeMd: RelatedItem | null;
  /** Plans directly linked to THIS session (the plan written in this conversation). */
  sessionPlans: RelatedItem[];
  /** Other plans in the same project, excluding the session's own plans. */
  projectPlans: RelatedItem[];
}

function metadataToRelated(row: MemoryMetadataRow, linkType: string, confidence = 1.0): RelatedItem {
  return {
    id: row.id,
    sourceType: row.source_type,
    title: row.title,
    contentPreview: row.content_preview.slice(0, 200),
    projectPath: row.project_path,
    mtime: row.mtime,
    linkType,
    confidence,
  };
}

/**
 * Get enriched related items for a session, including:
 * - Direct links (tasks, history) from memory_links
 * - CLAUDE.md for the same project
 * - Plans for the same project
 * - Sibling sessions in the same project
 */
export async function getRelatedItems(sessionId: string): Promise<RelatedItemsResponse> {
  const store = await createStore();
  try {
    // 1. Direct links from memory_links. Plans directly linked to this session
    //    (linkType 'plan_for_session') are the conversation's OWN plans — split
    //    them out so the UI can lead with them; everything else stays in `links`.
    const rawLinks = await store.getAllLinks('session' as SourceType, sessionId);
    const linkedItems: RelatedItem[] = [];
    const sessionPlans: RelatedItem[] = [];
    const sessionPlanIds = new Set<string>();

    for (const link of rawLinks) {
      const isOutgoing = link.source_type === 'session' && link.source_id === sessionId;
      const otherType = (isOutgoing ? link.target_type : link.source_type) as SourceType;
      const otherId = isOutgoing ? link.target_id : link.source_id;

      const meta = await store.getItem(otherId, otherType);
      if (!meta) continue;

      if (otherType === 'plan') {
        if (sessionPlanIds.has(otherId)) continue;
        sessionPlanIds.add(otherId);
        sessionPlans.push(metadataToRelated(meta, link.link_type, link.confidence));
      } else {
        linkedItems.push(metadataToRelated(meta, link.link_type, link.confidence));
      }
    }

    // 2. Get the session's own metadata to find projectPath
    const sessionMeta = await store.getItem(sessionId, 'session' as SourceType);
    const projectPath = sessionMeta?.project_path || '';

    // 3. CLAUDE.md for this project
    let projectClaudeMd: RelatedItem | null = null;
    if (projectPath) {
      const claudeMdItems = await store.listItemsByProject('claude_md' as SourceType, projectPath, 1);
      if (claudeMdItems.length > 0) {
        projectClaudeMd = metadataToRelated(claudeMdItems[0], 'project_claude_md');
      }
    }

    // 4. Other plans for this project (excluding the session's own plans).
    const projectPlans: RelatedItem[] = [];
    if (projectPath) {
      const planItems = await store.listItemsByProject('plan' as SourceType, projectPath, 10);
      for (const plan of planItems) {
        if (sessionPlanIds.has(plan.id)) continue;
        projectPlans.push(metadataToRelated(plan, 'project_plan'));
        if (projectPlans.length >= 5) break;
      }
    }

    // 5. Sibling sessions in same project (up to 5, excluding current)
    const siblingSessionsInProject: RelatedItemsResponse['siblingSessionsInProject'] = [];
    if (projectPath) {
      const siblings = await store.listItemsByProject('session' as SourceType, projectPath, 6);
      const cache = await createMetadataCache();
      for (const sib of siblings) {
        if (sib.id === sessionId) continue;
        if (siblingSessionsInProject.length >= 5) break;
        const cached = await cache.get(sib.id);
        siblingSessionsInProject.push({
          sessionId: sib.id,
          firstPrompt: cleanBanner(sib.content_preview?.slice(0, 120) || sib.title) ?? '',
          summary: cleanBanner(cached?.summary),
          modified: new Date(sib.mtime).toISOString(),
        });
      }
      await cache.close();
    }

    return { links: linkedItems, siblingSessionsInProject, projectClaudeMd, sessionPlans, projectPlans };
  } finally {
    await store.close();
  }
}

// --- Session metadata (token usage, cost, tools, etc.) ---

/** Cost rates per million tokens (Claude pricing as of 2025) */
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-6':    { input: 15,  output: 75,  cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4-6':  { input: 3,   output: 15,  cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-4-5':   { input: 0.8, output: 4,   cacheRead: 0.08, cacheWrite: 1 },
  // Fallback / older model names
  'claude-sonnet-4-5':  { input: 3,   output: 15,  cacheRead: 0.3,  cacheWrite: 3.75 },
};

/** Returns pricing for a model, or null if unknown (Gemini, Ollama, custom). */
function getModelPricing(model: string): typeof PRICING[string] | null {
  if (!model) return null;
  if (PRICING[model]) return PRICING[model];
  for (const [key, val] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return val;
  }
  return null;
}

export interface SessionMetadataResponse {
  tool: string;
  contentPreview: string;
  toolsUsed: string[];
  gitBranch: string;
  slug: string;
  durationMs: number;
  lastStopReason: string;
  filesModified: string[];
  modelsUsed: string[];
  messageCount: number;
  // Token usage
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  peakContextTokens: number;
  // Computed cost — null when no model in the session has known pricing
  // (e.g. Gemini, Ollama, custom). UI should render "—" not "$0".
  estimatedCostUsd: number | null;
  cacheSavingsUsd: number | null;
  /** AI-generated session summary (synced from the producer; attached by
   *  getSessionMetadata from the metadata cache — computeMetadataResponse
   *  itself doesn't populate it). recall_summary / recall_smart_resume read it. */
  summary?: string;
  /** User-assigned conversation name (mirrors Claude Code's /rename). The
   *  viewer header prefers this over the auto-derived title when present. */
  userTitle?: string | null;
  /** Native title from the originating tool (Claude ai-title, OpenCode title…). */
  toolTitle?: string | null;
}

/**
 * Get session metadata. First tries extra_json from SQLite (fast, requires re-index).
 * Falls back to parsing the JSONL directly (slow but always works).
 */
export async function getSessionMetadata(sessionId: string): Promise<SessionMetadataResponse | null> {
  // Try SQLite extra_json first (works for all tools)
  const store = await createStore();
  try {
    const meta = await store.getItem(sessionId, 'session' as SourceType);
    if (meta) {
      const extra = JSON.parse(meta.extra_json || '{}');
      // Accept any extra that has tool or inputTokens
      if (extra.tool || extra.inputTokens !== undefined) {
        // Carry over contentPreview and title from the store item
        extra._contentPreview = meta.content_preview || meta.title || '';
        extra._title = meta.title || '';
        const response = computeMetadataResponse(extra);
        // Attach the synced AI summary (computeMetadataResponse doesn't know
        // about it — it lives in the metadata cache, populated by sync ingest).
        // This is what recall_summary / recall_smart_resume read.
        try {
          const cache = await createMetadataCache();
          const cached = await cache.get(sessionId);
          await cache.close();
          if (cached?.summary) response.summary = cleanBanner(cached.summary);
          if (cached?.userTitle) response.userTitle = cached.userTitle;
          if (cached?.toolTitle) response.toolTitle = cached.toolTitle;
        } catch { /* summary is best-effort */ }
        return response;
      }
    }
  } finally {
    await store.close();
  }

  // Fall back to parsing the JSONL (Claude only)
  try {
    const sessionPath = getSessionPath(sessionId);
    const content = await parseSessionFile(sessionPath);
    // parseSessionFile returns firstPrompt as a top-level field, NOT
    // inside .metadata. Without merging it in, the response carries
    // contentPreview: '' for any session not yet in memory_metadata,
    // which cascades into "Untitled session" in the UI even though
    // the prompt is sitting in the JSONL waiting to be read.
    const fp = content.firstPrompt || '';
    return computeMetadataResponse({
      ...content.metadata,
      _contentPreview: fp,
      slug: content.metadata?.slug || fp.slice(0, 80),
    });
  } catch {
    // Continue to per-tool fallbacks below.
  }

  // Codex fallback — metadata isn't tracked anywhere yet, so synthesize a
  // minimal response from the rollout file's session_meta + a quick scan
  // of the events. Pricing is unknown for Codex (varies by provider) so
  // estimatedCostUsd stays null and the UI renders "—".
  if (codexBackend.matchesId(sessionId)) {
    return await getCodexSessionMetadata(sessionId);
  }

  return null;
}

async function getCodexSessionMetadata(sessionId: string): Promise<SessionMetadataResponse | null> {
  const located = findCodexSessionFile(codexBackend.toRawId(sessionId));
  if (!located) return null;

  const { readFileSync, statSync } = await import('fs');
  let raw: string;
  try { raw = readFileSync(located.path, 'utf-8'); } catch { return null; }

  const lines = raw.split('\n');
  const toolsUsed = new Set<string>();
  const filesModified = new Set<string>();
  const modelsUsed = new Set<string>();
  let messageCount = 0;
  let firstTs = 0;
  let lastTs = 0;
  let slug = '';
  let gitBranch = '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    const tsIso = obj.timestamp;
    if (typeof tsIso === 'string') {
      const t = Date.parse(tsIso);
      if (!Number.isNaN(t)) {
        if (!firstTs || t < firstTs) firstTs = t;
        if (t > lastTs) lastTs = t;
      }
    }

    if (obj.type === 'session_meta' && obj.payload) {
      gitBranch = obj.payload.git?.branch || '';
    }
    if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
      messageCount++;
      if (!slug) slug = String(obj.payload.message || '').slice(0, 100);
    }
    if (obj.type === 'response_item' && obj.payload?.type === 'message' && obj.payload.role === 'assistant') {
      messageCount++;
    }
    if (obj.type === 'response_item' && obj.payload?.type === 'function_call') {
      const name = obj.payload.name;
      if (name) toolsUsed.add(name);
      // Best-effort: pull a file path from common arg shapes.
      let args: any = obj.payload.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = null; }
      }
      const file = args?.file_path || args?.path || args?.target_file || args?.file;
      if (typeof file === 'string' && file.trim()) filesModified.add(file);
    }
  }

  let mtime = 0;
  try { mtime = statSync(located.path).mtimeMs; } catch { /* ignore */ }
  const durationMs = firstTs && lastTs ? lastTs - firstTs : 0;

  return computeMetadataResponse({
    tool: 'codex',
    _contentPreview: slug,
    _title: slug,
    toolsUsed: [...toolsUsed],
    gitBranch,
    slug,
    durationMs,
    lastStopReason: '',
    filesModified: [...filesModified],
    modelsUsed: [...modelsUsed],
    messageCount,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    peakContextTokens: 0,
    _mtime: mtime,
  });
}

function computeMetadataResponse(meta: Record<string, any>): SessionMetadataResponse {
  const modelsUsed: string[] = meta.modelsUsed || [];
  const inputTokens = meta.inputTokens || 0;
  const outputTokens = meta.outputTokens || 0;
  const cacheReadTokens = meta.cacheReadTokens || 0;
  const cacheCreationTokens = meta.cacheCreationTokens || 0;

  // Compute cost using whichever model has known pricing. If none do (Gemini,
  // Ollama, custom), return null and let the UI render "—" — never fabricate.
  // Note: inputTokens already includes cacheRead + cacheCreation (total context), so
  // non-cached input = inputTokens - cacheReadTokens - cacheCreationTokens
  let pricing: ReturnType<typeof getModelPricing> = null;
  for (const m of modelsUsed) {
    if (!m || m === '<synthetic>') continue;
    pricing = getModelPricing(m);
    if (pricing) break;
  }
  let estimatedCostUsd: number | null = null;
  let cacheSavingsUsd: number | null = null;
  if (pricing) {
    const nonCachedInput = Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);
    const inputCost = (nonCachedInput / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheRead;
    const cacheWriteCost = (cacheCreationTokens / 1_000_000) * pricing.cacheWrite;
    estimatedCostUsd = inputCost + outputCost + cacheReadCost + cacheWriteCost;
    cacheSavingsUsd = (cacheReadTokens / 1_000_000) * (pricing.input - pricing.cacheRead);
  }

  return {
    tool: meta.tool || 'claude',
    contentPreview: meta._contentPreview || meta.slug || '',
    toolsUsed: meta.toolsUsed || [],
    gitBranch: meta.gitBranch || '',
    slug: meta.slug || '',
    durationMs: meta.durationMs || 0,
    lastStopReason: meta.lastStopReason || '',
    filesModified: meta.filesModified || [],
    modelsUsed,
    messageCount: meta.messageCount || 0,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    peakContextTokens: meta.peakContextTokens || 0,
    estimatedCostUsd: estimatedCostUsd === null ? null : Math.round(estimatedCostUsd * 10000) / 10000,
    cacheSavingsUsd: cacheSavingsUsd === null ? null : Math.round(cacheSavingsUsd * 10000) / 10000,
  };
}
