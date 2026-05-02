/**
 * Session listing service.
 */

import { getAllSessions, parseSessionFile, MetadataCache, MemoryStore, findCodexSessionFile } from '../imports.js';
import type { SessionEntry, SessionMetadata, MemoryMetadataRow, MemoryLinkRow, SourceType } from '../imports.js';
import { homedir } from 'os';
import { join } from 'path';

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
  created: string;
  modified: string;
  fileMtime: number;
  filePath: string;
  firstPrompt?: string;
  summary?: string;
  tool?: string; // 'claude' | 'gemini' | 'opencode'
}

/**
 * Get recent sessions from all tools (Claude, Gemini, OpenCode),
 * sorted by modification time.
 */
export async function getRecentSessions(limit = 20): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  const cache = new MetadataCache();

  // 1. Claude sessions from filesystem
  for (const [entry, filePath] of getAllSessions()) {
    const cached = cache.get(entry.sessionId);

    let firstPrompt = entry.firstPrompt || '';
    let summary: string | undefined = undefined;

    if (cached) {
      firstPrompt = cached.firstPrompt;
      summary = cached.summary;
    } else {
      try {
        const content = await parseSessionFile(filePath);
        firstPrompt = content.firstPrompt || firstPrompt;
        summary = content.summaries.length > 0 ? content.summaries[0] : undefined;
      } catch {}
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

  cache.close();

  // 1b. Codex sessions from filesystem
  try {
    const { existsSync, readdirSync, statSync, readFileSync } = await import('fs');
    const { join } = await import('path');
    const codexSessionsDir = join(homedir(), '.codex', 'sessions');
    if (existsSync(codexSessionsDir)) {
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
              const sessionId = `codex_${file.replace(/^rollout-/, '').replace(/\.jsonl$/, '')}`;
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
  const store = new MemoryStore();
  const cache2 = new MetadataCache();
  try {
    const memItems = store.listItems('session' as SourceType, 5000, 0);
    const seenIds = new Set(sessions.map(s => s.sessionId));

    for (const item of memItems) {
      if (seenIds.has(item.id)) continue; // Skip Claude sessions (already added)

      const extra = JSON.parse(item.extra_json || '{}');
      const tool = extra.tool as string;
      if (!tool || tool === 'claude') continue; // Only add non-Claude

      const cached = cache2.get(item.id);

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
    store.close();
    cache2.close();
  }

  // Sort by modification time (newest first)
  sessions.sort((a, b) => b.fileMtime - a.fileMtime);

  return limit > 0 ? sessions.slice(0, limit) : sessions;
}

/**
 * Get session file path from session ID.
 */
export function getSessionPath(sessionId: string): string {
  // Session files are typically stored in ~/.claude/projects/<project-path>/<session-id>.jsonl
  // We need to search for it
  for (const [entry, filePath] of getAllSessions()) {
    if (entry.sessionId === sessionId) {
      return filePath;
    }
  }

  throw new Error(`Session not found: ${sessionId}`);
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
export function getRelatedItems(sessionId: string): RelatedItemsResponse {
  const store = new MemoryStore();
  try {
    // 1. Direct links from memory_links
    const rawLinks = store.getAllLinks('session' as SourceType, sessionId);
    const linkedItems: RelatedItem[] = [];

    for (const link of rawLinks) {
      const isOutgoing = link.source_type === 'session' && link.source_id === sessionId;
      const otherType = (isOutgoing ? link.target_type : link.source_type) as SourceType;
      const otherId = isOutgoing ? link.target_id : link.source_id;

      const meta = store.getItem(otherId, otherType);
      if (meta) {
        linkedItems.push(metadataToRelated(meta, link.link_type, link.confidence));
      }
    }

    // 2. Get the session's own metadata to find projectPath
    const sessionMeta = store.getItem(sessionId, 'session' as SourceType);
    const projectPath = sessionMeta?.project_path || '';

    // 3. CLAUDE.md for this project
    let projectClaudeMd: RelatedItem | null = null;
    if (projectPath) {
      const claudeMdItems = store.listItemsByProject('claude_md' as SourceType, projectPath, 1);
      if (claudeMdItems.length > 0) {
        projectClaudeMd = metadataToRelated(claudeMdItems[0], 'project_claude_md');
      }
    }

    // 4. Plans for this project
    const projectPlans: RelatedItem[] = [];
    if (projectPath) {
      const planItems = store.listItemsByProject('plan' as SourceType, projectPath, 5);
      for (const plan of planItems) {
        projectPlans.push(metadataToRelated(plan, 'project_plan'));
      }
    }

    // 5. Sibling sessions in same project (up to 5, excluding current)
    const siblingSessionsInProject: RelatedItemsResponse['siblingSessionsInProject'] = [];
    if (projectPath) {
      const siblings = store.listItemsByProject('session' as SourceType, projectPath, 6);
      const cache = new MetadataCache();
      for (const sib of siblings) {
        if (sib.id === sessionId) continue;
        if (siblingSessionsInProject.length >= 5) break;
        const cached = cache.get(sib.id);
        siblingSessionsInProject.push({
          sessionId: sib.id,
          firstPrompt: cleanBanner(sib.content_preview?.slice(0, 120) || sib.title) ?? '',
          summary: cleanBanner(cached?.summary),
          modified: new Date(sib.mtime).toISOString(),
        });
      }
      cache.close();
    }

    return { links: linkedItems, siblingSessionsInProject, projectClaudeMd, projectPlans };
  } finally {
    store.close();
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
}

/**
 * Get session metadata. First tries extra_json from SQLite (fast, requires re-index).
 * Falls back to parsing the JSONL directly (slow but always works).
 */
export async function getSessionMetadata(sessionId: string): Promise<SessionMetadataResponse | null> {
  // Try SQLite extra_json first (works for all tools)
  const store = new MemoryStore();
  try {
    const meta = store.getItem(sessionId, 'session' as SourceType);
    if (meta) {
      const extra = JSON.parse(meta.extra_json || '{}');
      // Accept any extra that has tool or inputTokens
      if (extra.tool || extra.inputTokens !== undefined) {
        // Carry over contentPreview and title from the store item
        extra._contentPreview = meta.content_preview || meta.title || '';
        extra._title = meta.title || '';
        return computeMetadataResponse(extra);
      }
    }
  } finally {
    store.close();
  }

  // Fall back to parsing the JSONL (Claude only)
  try {
    const sessionPath = getSessionPath(sessionId);
    const content = await parseSessionFile(sessionPath);
    return computeMetadataResponse(content.metadata);
  } catch {
    // Continue to per-tool fallbacks below.
  }

  // Codex fallback — metadata isn't tracked anywhere yet, so synthesize a
  // minimal response from the rollout file's session_meta + a quick scan
  // of the events. Pricing is unknown for Codex (varies by provider) so
  // estimatedCostUsd stays null and the UI renders "—".
  if (sessionId.startsWith('codex_')) {
    return await getCodexSessionMetadata(sessionId);
  }

  return null;
}

async function getCodexSessionMetadata(sessionId: string): Promise<SessionMetadataResponse | null> {
  const located = findCodexSessionFile(sessionId.replace(/^codex_/, ''));
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
