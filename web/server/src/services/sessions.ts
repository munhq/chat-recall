/**
 * Session listing service.
 */

import { getAllSessions, parseSessionFile, MetadataCache, MemoryStore } from '../imports.js';
import type { SessionEntry, SessionMetadata, MemoryMetadataRow, MemoryLinkRow, SourceType } from '../imports.js';
import { homedir } from 'os';
import { join } from 'path';

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
      firstPrompt,
      summary,
      tool: 'claude',
    });
  }

  cache.close();

  // 2. Gemini and OpenCode sessions from MemoryStore (indexed items)
  const store = new MemoryStore();
  try {
    const memItems = store.listItems('session' as SourceType, 5000, 0);
    const seenIds = new Set(sessions.map(s => s.sessionId));

    for (const item of memItems) {
      if (seenIds.has(item.id)) continue; // Skip Claude sessions (already added)

      const extra = JSON.parse(item.extra_json || '{}');
      const tool = extra.tool as string;
      if (!tool || tool === 'claude') continue; // Only add non-Claude

      sessions.push({
        sessionId: item.id,
        projectPath: item.project_path,
        created: new Date(item.mtime).toISOString(),
        modified: new Date(item.mtime).toISOString(),
        fileMtime: item.mtime,
        filePath: item.file_path,
        firstPrompt: item.content_preview || item.title,
        summary: undefined,
        tool,
      });
    }
  } finally {
    store.close();
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
          firstPrompt: sib.content_preview?.slice(0, 120) || sib.title,
          summary: cached?.summary,
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

function getModelPricing(model: string) {
  // Try exact match first, then prefix match
  if (PRICING[model]) return PRICING[model];
  for (const [key, val] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return val;
  }
  // Default to sonnet pricing as a safe estimate
  return PRICING['claude-sonnet-4-6'];
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
  // Computed cost
  estimatedCostUsd: number;
  cacheSavingsUsd: number;
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
    return null;
  }
}

function computeMetadataResponse(meta: Record<string, any>): SessionMetadataResponse {
  const modelsUsed: string[] = meta.modelsUsed || [];
  const inputTokens = meta.inputTokens || 0;
  const outputTokens = meta.outputTokens || 0;
  const cacheReadTokens = meta.cacheReadTokens || 0;
  const cacheCreationTokens = meta.cacheCreationTokens || 0;

  // Compute cost using the primary model (most expensive one as a worst-case estimate)
  // Note: inputTokens already includes cacheRead + cacheCreation (total context), so
  // non-cached input = inputTokens - cacheReadTokens - cacheCreationTokens
  const primaryModel = modelsUsed[0] || 'claude-sonnet-4-6';
  const pricing = getModelPricing(primaryModel);
  const nonCachedInput = Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);
  const inputCost = (nonCachedInput / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheRead;
  const cacheWriteCost = (cacheCreationTokens / 1_000_000) * pricing.cacheWrite;
  const estimatedCostUsd = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  // Savings = what it would have cost without cache
  const cacheSavingsUsd = (cacheReadTokens / 1_000_000) * (pricing.input - pricing.cacheRead);

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
    estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
    cacheSavingsUsd: Math.round(cacheSavingsUsd * 10000) / 10000,
  };
}
