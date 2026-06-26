/**
 * API client for backend.
 */
import { getAccessToken } from './auth';

export interface SearchResult {
  sessionId: string;
  score: number;
  chunkType: string;
  text: string;
  projectPath: string;
  created: string;
  modified: string;
  firstPrompt: string;
  summary?: string;
  matchedChunks?: Array<{
    chunkType: string;
    text: string;
    score: number;
  }>;
}

export interface Message {
  line: number;
  role: 'user' | 'assistant' | 'summary';
  content: string;
  thinking?: string;
  toolCalls?: Array<{
    name: string;
    input: any;
    result?: any;
    isError?: boolean;
  }>;
  timestamp?: string;
}

export interface Subagent {
  id: string;
  kind: 'explore' | 'compact' | 'aside' | 'other';
  agentType?: string;
  description?: string;
  filePath: string;
  messageCount: number;
  toolUseCount: number;
  messages: Message[];
}

export interface SessionInfo {
  sessionId: string;
  projectPath: string;
  /** Logical cleartext project id (e.g. `git:github.com/me/repo`). Preferred
   *  over projectPath for grouping/display — projectPath can be a privacy hash. */
  projectId?: string;
  created: string;
  modified: string;
  filePath: string;
  firstPrompt?: string;
  summary?: string;
  tool?: string;
  /** Server-attached when summary generation has failed for this session.
   *  Absent means either pending (no attempt yet) or successful (a summary
   *  exists). The list shows "summary unavailable — check settings" with
   *  the error string as a hover tooltip. */
  summaryError?: { error: string; attemptCount: number; lastFailedAt: number };
  /** User-assigned conversation name (mirrors Claude Code's /rename). When
   *  set, the list and viewer show it in place of the auto summary. */
  userTitle?: string | null;
  /** Native title from the originating tool (Claude ai-title, OpenCode title…).
   *  Shown below a user name, above the AI summary / first prompt. */
  toolTitle?: string | null;
  /** Search-only: relevance score (0..1ish) for this hit. */
  score?: number;
  /** Search-only: top matched chunks (snippets) — drives the result preview. */
  matchedChunks?: Array<{ chunkType: string; text: string; score: number }>;
  /** Search-only: the user's query, so the row can highlight matched terms. */
  query?: string;
  /** Search-only: what kind of memory item this is. Drives the source badge
   *  and (for non-session items) the click-through behavior. */
  sourceType?: 'session' | 'plan' | 'task' | 'claude_md' | 'paste' | 'history' | 'diary';
  /**
   * UI-only: when ≥2 adjacent sessions with the same project + same
   * templated first prompt collapse into one feed row (e.g. PR-bot
   * worktree runs), the surviving row carries `runCount` (the total
   * collapsed) and `runMemberIds` (every member's id, so a later
   * "Expand N runs" affordance can list them).
   */
  runCount?: number;
  /** Single-prompt invocation (batch/bot run) — synced flag. */
  oneShot?: boolean;
  runMemberIds?: string[];
}

export interface IndexStats {
  totalChunks: number;
  totalSessions: number;
  projects: Record<string, number>;
  indexPath: string;
  /** False when the most recent vector-index read failed. UI shows a banner
   *  and continues to operate via FTS5 fallback. */
  vectorOk?: boolean;
  /** Error string from the most recent vector-index failure, if any. */
  vectorError?: string | null;
}

export interface ProjectInfo {
  path: string;
  name: string;
  count: number;
}

// Local mode proxies '/api' to the local server (vite proxy). Cloud mode sets
// VITE_API_BASE to the cloud API origin (e.g. https://chat-recall.munhq.com/api)
// and every request carries the Keycloak Bearer.
const API_BASE = import.meta.env.VITE_API_BASE || '/api';

// Fetch with a timeout — prevents infinite hanging when server is down.
// Default raised to 30s because the first request after a service restart
// can take 2–7s while the server's TTL path-map cache warms up; a 10s
// timeout would spuriously abort those cold-path requests and leave the
// UI blank. The hot path is ~50ms so 30s is well above the worst-case
// honest latency without being so long it hides real outages.
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Cloud mode: attach the Keycloak Bearer (no-op in local mode).
    const token = await getAccessToken();
    const headers = token ? { ...options.headers, Authorization: `Bearer ${token}` } : options.headers;
    const res = await fetch(url, { ...options, headers, signal: controller.signal });
    // 402 from any value route = subscription required. Broadcast once so the
    // app shell can drop the user onto the Subscribe screen instead of each
    // caller surfacing a dead error.
    if (res.status === 402) window.dispatchEvent(new CustomEvent('cr:payment-required'));
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Server capabilities — which views this deployment supports. Local mode
 *  exposes everything; server mode (self-host compose / SaaS) disables the
 *  filesystem-backed views (activity, toolkit, settings, projects). */
export interface ServerCapabilities {
  mode: 'local' | 'server';
  edition: 'selfhost' | 'cloud';
  features: {
    conversations: boolean;
    search: boolean;
    memory: boolean;
    analytics: boolean;
    security: boolean;
    activity: boolean;
    sessionDeepDive: boolean;
    toolkit: boolean;
    settings: boolean;
    projects: boolean;
    teams: boolean;
    account: boolean;
    codeIntel: boolean;
  };
}

const LOCAL_CAPABILITIES: ServerCapabilities = {
  mode: 'local',
  edition: 'selfhost',
  features: {
    conversations: true, search: true, memory: true, analytics: true,
    security: true, activity: true, sessionDeepDive: true, toolkit: true,
    settings: true, projects: true, teams: false, account: false, codeIntel: true,
  },
};

/** Fetch /api/capabilities. Falls back to "everything on" (the pre-
 *  capabilities behavior) when the endpoint is missing or unreachable, so
 *  older servers and flaky startups never blank the UI. */
export async function getCapabilities(): Promise<ServerCapabilities> {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/capabilities`, {}, 5000);
    if (!res.ok) return LOCAL_CAPABILITIES;
    const body = await res.json();
    if (!body || typeof body !== 'object' || !body.features) return LOCAL_CAPABILITIES;
    return { ...LOCAL_CAPABILITIES, ...body, features: { ...LOCAL_CAPABILITIES.features, ...body.features } };
  } catch {
    return LOCAL_CAPABILITIES;
  }
}

// ── Code intelligence (codeindex merge) ──────────────────────────────────
export interface CodeHealth { score: number; findings: number; critical: number; high: number; medium: number; low: number; hotspots: number; aiAuthoredPct: number; aiCommits?: number; totalCommits?: number; savingsPct?: number; stats?: Record<string, number>; }
export interface CodeMapNode { file: string; pkg?: string; symbols: number; lines: number; }
export interface CodeCouplingMetric { file: string; fanIn: number; fanOut: number; instability: number; }
export interface CodeMap { nodes: CodeMapNode[]; edges: Array<{ from: string; to: string }>; buckets: { god_modules: string[]; stable_cores: string[]; unstable_drivers: string[]; islands: string[]; cycles: string[][] }; pkgFiles?: Record<string, string[]>; fileEdges?: Array<{ from: string; to: string }>; fileMeta?: Record<string, { symbols: number; lang: string }>; langSymbols?: Record<string, number>; coupling?: { god_modules: CodeCouplingMetric[]; stable_cores: CodeCouplingMetric[]; unstable_drivers: CodeCouplingMetric[]; islands: CodeCouplingMetric[] }; }
export interface CodeProject { projectId: string; rootPath: string; fileCount: number; symbolCount: number; langs: Record<string, number>; health: CodeHealth; map: CodeMap; label?: string | null; lastIndexedAt: number; }
export interface CodeFinding { id: string; category: string; severity: string; file: string; line: number | null; rule: string; title: string; snippet: string; why: string; agentPrompt: string; status: string; }
export interface CodeHotspot { id: string; file: string; churn: number; complexity: number; score: number; aiAuthored: boolean; lines: number; suggestion?: string; }
export interface CodeAction { id: string; pri: number; category: string; title: string; fix: string; loc: Array<{ file: string; line?: number | null }>; agentPrompt: string; status: string; queued: boolean; }
export interface CodeFindingsSummary { total: number; bySeverity: Record<string, number>; byCategory: Record<string, number>; }

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
};

export async function getCodeProjects(): Promise<CodeProject[]> {
  const r = await fetchWithTimeout(`${API_BASE}/code/projects`);
  if (!r.ok) return [];
  return (await r.json()).projects ?? [];
}
export async function getCodeProject(id: string): Promise<CodeProject | null> {
  const r = await fetchWithTimeout(`${API_BASE}/code/projects/${encodeURIComponent(id)}`);
  return r.ok ? r.json() : null;
}
export async function getCodeSummary(project?: string): Promise<CodeFindingsSummary> {
  const r = await fetchWithTimeout(`${API_BASE}/code/summary${qs({ project })}`);
  return r.ok ? r.json() : { total: 0, bySeverity: {}, byCategory: {} };
}
export async function getCodeFindings(project?: string, opts: { severity?: string; category?: string; limit?: number } = {}): Promise<CodeFinding[]> {
  const r = await fetchWithTimeout(`${API_BASE}/code/findings${qs({ project, ...opts })}`);
  return r.ok ? (await r.json()).findings ?? [] : [];
}
export async function getCodeHotspots(project?: string, limit = 100): Promise<CodeHotspot[]> {
  const r = await fetchWithTimeout(`${API_BASE}/code/hotspots${qs({ project, limit })}`);
  return r.ok ? (await r.json()).hotspots ?? [] : [];
}
export async function getCodeActions(project?: string, opts: { status?: string; queued?: boolean; limit?: number } = {}): Promise<CodeAction[]> {
  const r = await fetchWithTimeout(`${API_BASE}/code/actions${qs({ project, ...opts })}`);
  return r.ok ? (await r.json()).actions ?? [] : [];
}
export async function patchCodeAction(id: string, body: { status?: string; queued?: boolean }): Promise<boolean> {
  const r = await fetchWithTimeout(`${API_BASE}/code/actions/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.ok;
}
export async function patchCodeProjectLabel(id: string, label: string | null): Promise<boolean> {
  const r = await fetchWithTimeout(`${API_BASE}/code/projects/${encodeURIComponent(id)}/label`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }) });
  return r.ok;
}
export interface CodeRecommendation { id: string; kind: string; severity: string; title: string; rationale: string; evidence: string[]; action: { type: string; payload: Record<string, unknown> }; }
export async function getCodeRecommendations(project: string): Promise<{ recommendations: CodeRecommendation[]; behavior: { failedOrAbandoned: number; totalSessions: number } | null }> {
  const r = await fetchWithTimeout(`${API_BASE}/code/recommendations${qs({ project })}`);
  return r.ok ? r.json() : { recommendations: [], behavior: null };
}
export async function applyCodeRecommendation(project: string, recId: string): Promise<{ ok: boolean; queued?: boolean; applied?: boolean; message?: string }> {
  const r = await fetchWithTimeout(`${API_BASE}/code/recommendations/${encodeURIComponent(recId)}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project }) });
  return r.ok ? r.json() : { ok: false, message: `HTTP ${r.status}` };
}
export async function writeTasksToProject(project: string): Promise<{ ok: boolean; queued?: boolean; filename?: string; count?: number; message?: string }> {
  const r = await fetchWithTimeout(`${API_BASE}/code/tasks/write`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project }) });
  return r.ok ? r.json() : { ok: false, message: `HTTP ${r.status}` };
}
// Account-level recommendations (chat-recall's own security + behaviour data).
export async function getAccountRecommendations(): Promise<{ recommendations: CodeRecommendation[]; behavior: { failedOrAbandoned: number; totalSessions: number } | null }> {
  const r = await fetchWithTimeout(`${API_BASE}/recommendations`);
  return r.ok ? r.json() : { recommendations: [], behavior: null };
}
export async function applyAccountRecommendation(recId: string): Promise<{ ok: boolean; queued?: boolean; message?: string }> {
  const r = await fetchWithTimeout(`${API_BASE}/recommendations/${encodeURIComponent(recId)}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return r.ok ? r.json() : { ok: false, message: `HTTP ${r.status}` };
}

/** Result item from a unified-memory search — covers non-session sources
 *  (paste, plan, claude_md, task, history, diary) so the UI can show the
 *  full picture of what matched a query. */
export interface MemoryHit {
  itemId: string;
  sourceType: 'session' | 'plan' | 'task' | 'claude_md' | 'paste' | 'history' | 'diary';
  title: string;
  text: string;
  score: number;
  chunkType: string;
  projectPath: string;
  filePath: string;
  mtime: number;
  matchedChunks: Array<{ chunkType: string; text: string; score: number }>;
}

export interface SearchResponse {
  sessions: SearchResult[];
  memory: MemoryHit[];
}

export async function searchSessions(
  query: string,
  topK = 10,
  projectFilter?: string
): Promise<SearchResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      topK,
      projectFilter,
      includeMemory: true,
      // Everything except `session` (already in `results`) and `history`.
      // A `history` item is a per-project aggregate of every shell line —
      // a single one can be 13MB on one line, which is low-signal noise in
      // results and froze the viewer. paste/plan/task/claude_md/diary are
      // bounded, high-value (e.g. pasted logs), and openable.
      sourceTypes: ['plan', 'task', 'claude_md', 'paste', 'diary'],
    }),
  }, 30000);

  if (!res.ok) {
    throw new Error(`Search failed: ${res.statusText}`);
  }

  const data = await res.json();
  return {
    sessions: data.results || [],
    memory: data.memoryResults || [],
  };
}

/**
 * Paginated sessions response. `total` is the count after filtering but
 * before slicing to the page; `hasMore` tells the UI whether to wire up
 * a "load more" trigger for scroll-to-bottom.
 */
export interface RecentSessionsPage {
  sessions: SessionInfo[];
  count: number;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Backwards-compatible: returns just the page's sessions array. Existing
 * callers that don't care about pagination keep working unchanged.
 */
export async function getRecentSessions(
  limit = 20,
  projectFilter?: string,
  toolFilter?: string,
  sinceHours?: number,
): Promise<SessionInfo[]> {
  const page = await getRecentSessionsPage({ limit, offset: 0, projectFilter, toolFilter, sinceHours });
  return page.sessions;
}

/**
 * Paginated variant — use this for infinite-scroll/load-more flows.
 * Returns the full pagination metadata (`total`, `hasMore`, `offset`).
 */
export async function getRecentSessionsPage(opts: {
  limit?: number;
  offset?: number;
  projectFilter?: string;
  toolFilter?: string;
  sinceHours?: number;
}): Promise<RecentSessionsPage> {
  const { limit = 20, offset = 0, projectFilter, toolFilter, sinceHours } = opts;
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (projectFilter) params.append('project', projectFilter);
  if (toolFilter) params.append('tool', toolFilter);
  if (sinceHours !== undefined && Number.isFinite(sinceHours) && sinceHours > 0) {
    params.append('since_hours', String(sinceHours));
  }

  const res = await fetchWithTimeout(`${API_BASE}/conversations/recent?${params}`);
  if (!res.ok) {
    throw new Error(`Failed to get recent sessions: ${res.statusText}`);
  }
  const data = await res.json();
  return {
    sessions: data.sessions ?? [],
    count: data.count ?? data.sessions?.length ?? 0,
    total: data.total ?? 0,
    offset: data.offset ?? offset,
    limit: data.limit ?? limit,
    hasMore: data.hasMore ?? false,
  };
}

export interface ConversationPage {
  messages: Message[];
  subagents: Subagent[];
  total: number;
  offset: number;
  hasMore: boolean;
}

const CONVERSATION_PAGE_SIZE = 500;

export async function getConversation(sessionId: string): Promise<Message[]> {
  const page = await getConversationPage(sessionId, 0, CONVERSATION_PAGE_SIZE);
  return page.messages;
}

export async function getConversationWithSubagents(
  sessionId: string,
): Promise<{ messages: Message[]; subagents: Subagent[]; total?: number; hasMore?: boolean }> {
  const page = await getConversationPage(sessionId, 0, CONVERSATION_PAGE_SIZE);
  return { messages: page.messages, subagents: page.subagents, total: page.total, hasMore: page.hasMore };
}

/**
 * Fetch one window of a conversation. Server caps payload size with
 * `?limit=` and slices in-memory from the cached parse.
 *   - limit=0 → no slice (legacy / debug only — large sessions = MB of JSON)
 *   - limit>0 → server returns up to `limit` messages from `offset`
 */
export async function getConversationPage(
  sessionId: string,
  offset = 0,
  limit = CONVERSATION_PAGE_SIZE,
): Promise<ConversationPage> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}?${params}`, {}, 30000);
  if (!res.ok) throw new Error(`Failed to get conversation: ${res.statusText}`);
  const data = await res.json();
  return {
    messages: data.messages ?? [],
    subagents: data.subagents ?? [],
    total: data.total ?? (data.messages?.length ?? 0),
    offset: data.offset ?? offset,
    hasMore: !!data.hasMore,
  };
}

export async function getRawConversation(sessionId: string): Promise<any[]> {
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}/raw`, {}, 30000);

  if (!res.ok) {
    throw new Error(`Failed to get raw conversation: ${res.statusText}`);
  }

  const data = await res.json();
  return data.lines;
}

export async function getStatus(): Promise<IndexStats> {
  const res = await fetchWithTimeout(`${API_BASE}/status`);

  if (!res.ok) {
    throw new Error(`Failed to get status: ${res.statusText}`);
  }

  return await res.json();
}

export interface SyncStatus {
  sessions: number;
  rawArchived: number;
  rawBytes: number;
  newestSessionAgeMs: number | null;
  sourceTypes: Record<string, number>;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const res = await fetchWithTimeout(`${API_BASE}/status/sync`);
  if (!res.ok) {
    throw new Error(`Failed to get sync status: ${res.statusText}`);
  }
  return await res.json();
}

export function subscribeToStatus(
  onUpdate: (stats: IndexStats) => void,
  onError?: (error: Error) => void
): () => void {
  const eventSource = new EventSource(`${API_BASE}/status/stream`);

  eventSource.onmessage = (event) => {
    try {
      const stats = JSON.parse(event.data);
      onUpdate(stats);
    } catch (error) {
      onError?.(error as Error);
    }
  };

  eventSource.onerror = (error) => {
    onError?.(new Error('SSE connection failed'));
  };

  return () => {
    eventSource.close();
  };
}

// --- Analytics API ---

export interface AnalyticsData {
  summary: {
    totalSessions: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalDurationMin: number;
    hoursPerWeek: number;
    avgCostPerSession: number;
    avgDurationMin: number;
    sessionsWithoutPricing: number;
  };
  topByDuration: Array<{ id: string; slug: string; project: string; durationMin: number }>;
  topByCost: Array<{ id: string; slug: string; project: string; cost: number }>;
  topByTokens: Array<{ id: string; slug: string; project: string; tokensM: number }>;
  languages: Array<{ language: string; files: number }>;
  tools: Array<{ tool: string; sessions: number }>;
  models: Array<{ model: string; sessions: number }>;
  dailyCost: Array<{ day: string; cost: number }>;
  projects: Array<{
    path: string;
    name: string;
    sessions: number;
    totalCost: number;
    totalDurationMin: number;
    languages: Array<{ language: string; files: number }>;
    models: string[];
    description: string;
    weeklyVelocity: number[];
  }>;
  activityHeatmap: number[][];
  weeklyTrends: Array<{ week: string; cost: number; sessions: number; cacheRate: number }>;
  outcomes: Array<{ reason: string; count: number }>;
  sessionsByTool: Array<{ tool: string; count: number }>;
  toolDetails: Record<string, {
    sessions: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    durationMin: number;
    languages: Array<{ language: string; files: number }>;
    models: Array<{ model: string; count: number }>;
    projects: Array<{ project: string; count: number }>;
    tools: Array<{ tool: string; count: number }>;
  }>;
  fileHotspots: Array<{ file: string; count: number; projects: string[] }>;
  costByModel: Array<{ model: string; cost: number; sessions: number; tokensM: number }>;
  contextExhausted: Array<{ id: string; slug: string; project: string; peakK: number }>;
  contextUtilization: Array<{ range: string; count: number }>;
  periodComparison: {
    thisWeek: { sessions: number; cost: number; tokens: number; cacheRate: number };
    lastWeek: { sessions: number; cost: number; tokens: number; cacheRate: number };
  };
}

export async function getAnalytics(tool?: 'all' | 'claude' | 'gemini' | 'opencode' | 'codex'): Promise<AnalyticsData> {
  const url = tool && tool !== 'all'
    ? `${API_BASE}/analytics?tool=${encodeURIComponent(tool)}`
    : `${API_BASE}/analytics`;
  const res = await fetchWithTimeout(url, {}, 30000);
  if (!res.ok) {
    throw new Error(`Failed to get analytics: ${res.statusText}`);
  }
  return await res.json();
}

// --- Related Items API ---

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

export interface SiblingSession {
  sessionId: string;
  firstPrompt: string;
  summary?: string;
  modified: string;
}

export interface RelatedItemsResponse {
  links: RelatedItem[];
  siblingSessionsInProject: SiblingSession[];
  projectClaudeMd: RelatedItem | null;
  projectPlans: RelatedItem[];
}

export async function getSessionRelated(sessionId: string): Promise<RelatedItemsResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}/related`);
  if (!res.ok) {
    throw new Error(`Failed to get related items: ${res.statusText}`);
  }
  return await res.json();
}

// --- Session Metadata API ---

export interface SessionMetadataResponse {
  tool?: string;
  contentPreview?: string;
  toolsUsed: string[];
  gitBranch: string;
  slug: string;
  durationMs: number;
  lastStopReason: string;
  filesModified: string[];
  modelsUsed: string[];
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  peakContextTokens: number;
  estimatedCostUsd: number | null;
  cacheSavingsUsd: number | null;
  /** User-assigned conversation name (mirrors Claude Code's /rename). */
  userTitle?: string | null;
  /** Native title from the originating tool (Claude ai-title, OpenCode title…). */
  toolTitle?: string | null;
}

export async function getSessionMetadata(sessionId: string): Promise<SessionMetadataResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}/metadata`);
  if (!res.ok) {
    throw new Error(`Failed to get session metadata: ${res.statusText}`);
  }
  return await res.json();
}

export interface RegenerateSummaryResponse {
  sessionId: string;
  summary: string;
  summarySource: string;
}

export async function regenerateSummary(sessionId: string): Promise<RegenerateSummaryResponse> {
  // Long timeout — LLM call can take 30-60s
  const res = await fetchWithTimeout(
    `${API_BASE}/conversations/${sessionId}/regenerate-summary`,
    { method: 'POST' },
    120000
  );
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); if (j?.error) detail = j.error; } catch {}
    if (res.status === 429) {
      throw new Error(`Summary provider quota exhausted: ${detail}`);
    }
    throw new Error(`Failed to regenerate summary: ${detail}`);
  }
  return await res.json();
}

/** Set or clear a user-assigned conversation name (mirrors Claude Code's
 *  /rename). Empty string clears it and reverts to the auto-derived title. */
export async function renameConversation(
  sessionId: string,
  name: string,
): Promise<{ sessionId: string; userTitle: string | null }> {
  const res = await fetchWithTimeout(
    `${API_BASE}/conversations/${sessionId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    },
    15000,
  );
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); if (j?.error) detail = j.error; } catch {}
    throw new Error(`Failed to rename: ${detail}`);
  }
  return await res.json();
}

// --- Memory API ---

export type SourceType = 'session' | 'plan' | 'task' | 'claude_md' | 'paste' | 'history' | 'diary';

export interface MemorySearchResult {
  itemId: string;
  sourceType: SourceType;
  title: string;
  text: string;
  score: number;
  chunkType: string;
  projectPath: string;
  filePath: string;
  mtime: number;
  matchedChunks: Array<{
    chunkType: string;
    text: string;
    score: number;
  }>;
}

export interface MemoryMetadataRow {
  id: string;
  source_type: string;
  title: string;
  project_path: string;
  content_preview: string;
  file_path: string;
  mtime: number;
  indexed_at: number;
  extra_json: string;
}

export interface MemoryLinkRow {
  id: number;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  link_type: string;
  confidence: number;
  created_at: number;
}

export interface MemoryStatus {
  totalChunks: number;
  totalItems: number;
  bySourceType: Record<string, { items: number; chunks: number }>;
  /** Per-(sourceType, tool) row counts — used by the Memory UI to hide tabs that have no rows for the selected tool. */
  bySourceAndTool?: Record<string, Record<string, number>>;
  indexPath: string;
  storeStats: Record<string, number>;
  linkCount: number;
}

export async function searchMemory(
  query: string,
  topK = 10,
  sourceTypes?: SourceType[],
  projectFilter?: string
): Promise<MemorySearchResult[]> {
  const res = await fetch(`${API_BASE}/memory/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topK, sourceTypes, projectFilter }),
  });

  if (!res.ok) {
    throw new Error(`Memory search failed: ${res.statusText}`);
  }

  const data = await res.json();
  return data.results;
}

export interface ProviderModel { id: string; label?: string }

/** List the models a provider offers (cheapest-first when pricing is known),
 *  to populate model dropdowns. */
export async function fetchProviderModels(opts: {
  kind: 'summary' | 'embedding';
  provider: string;
  baseUrl?: string;
  apiKey?: string;
}): Promise<{ models: ProviderModel[]; error?: string }> {
  const q = new URLSearchParams({ kind: opts.kind, provider: opts.provider });
  if (opts.baseUrl) q.set('baseUrl', opts.baseUrl);
  if (opts.apiKey) q.set('apiKey', opts.apiKey);
  try {
    const res = await fetch(`${API_BASE}/settings/models?${q.toString()}`);
    if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { models: [], error: (err as Error).message };
  }
}

export async function getMemoryStatus(): Promise<MemoryStatus> {
  const res = await fetch(`${API_BASE}/memory/status`);

  if (!res.ok) {
    throw new Error(`Failed to get memory status: ${res.statusText}`);
  }

  return await res.json();
}

export async function getMemoryItem(sourceType: string, id: string): Promise<MemoryMetadataRow> {
  const res = await fetch(`${API_BASE}/memory/item/${sourceType}/${id}`);

  if (!res.ok) {
    throw new Error(`Failed to get memory item: ${res.statusText}`);
  }

  return await res.json();
}

export async function getMemoryItemContent(sourceType: string, id: string): Promise<string> {
  const res = await fetch(`${API_BASE}/memory/item/${sourceType}/${id}/content`);

  if (!res.ok) {
    throw new Error(`Failed to get memory item content: ${res.statusText}`);
  }

  const data = await res.json();
  return data.content;
}

export async function getMemoryLinks(sourceType: string, id: string): Promise<MemoryLinkRow[]> {
  const res = await fetch(`${API_BASE}/memory/links/${sourceType}/${id}`);

  if (!res.ok) {
    throw new Error(`Failed to get memory links: ${res.statusText}`);
  }

  const data = await res.json();
  return data.links;
}

export async function browseMemory(
  sourceType: string,
  limit = 50,
  offset = 0
): Promise<MemoryMetadataRow[]> {
  const params = new URLSearchParams({
    limit: limit.toString(),
    offset: offset.toString(),
  });

  const res = await fetch(`${API_BASE}/memory/browse/${sourceType}?${params}`);

  if (!res.ok) {
    throw new Error(`Failed to browse memory: ${res.statusText}`);
  }

  const data = await res.json();
  return data.items;
}

export async function reindexMemory(
  sourceTypes: SourceType[],
  force = false
): Promise<{
  itemsProcessed: number;
  chunksAdded: number;
  linksAdded: number;
  errors: number;
}> {
  const res = await fetch(`${API_BASE}/memory/reindex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceTypes, force }),
  });

  if (!res.ok) {
    throw new Error(`Failed to reindex memory: ${res.statusText}`);
  }

  return await res.json();
}

// --- Settings API (settings.json-backed, structured) ---

export type EmbedderProvider = 'ollama' | 'gemini' | 'openai' | 'nvidia' | 'openai-compat' | 'none';
export type SummaryProvider =
  | 'none'
  | 'cli'
  | 'ollama'
  | 'ollama-cloud'
  | 'gemini'
  | 'gemini-cli'
  | 'openai'
  | 'nvidia'
  | 'openai-compat'
  | 'claude';

export interface EmbeddingSettings {
  provider: EmbedderProvider;
  ollamaHost?: string;
  ollamaModel?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  nvidiaApiKey?: string;
  nvidiaModel?: string;
  openaiCompatBaseUrl?: string;
  openaiCompatModel?: string;
  openaiCompatApiKey?: string;
  openaiCompatDimension?: number;
}

export interface SummarySettings {
  provider: SummaryProvider;
  cliCommand?: string;
  cliPreset?: string;
  cliTimeoutMs?: number;
  geminiModel?: string;
  claudeModel?: string;
  ollamaModel?: string;
  anthropicApiKey?: string;
  // OpenAI-compatible HTTP providers (openai-compat / ollama-cloud / openai / nvidia)
  apiBaseUrl?: string;
  apiModel?: string;
  apiKey?: string;
}

// --- v2 source/privacy/sync blocks (mirror src/core/settings.ts) ----------

export interface SourcesEnabled {
  claude:   { sessions: boolean; plans: boolean; tasks: boolean; pasteCache: boolean;
              history: boolean; skills: boolean; agents: boolean; commands: boolean;
              hooks: boolean; plugins: boolean };
  gemini:   { sessions: boolean; plans: boolean; brain: boolean; extensions: boolean };
  opencode: { sessions: boolean; plans: boolean; todos: boolean; skills: boolean };
  codex:    { sessions: boolean; plugins: boolean; skills: boolean };
  common:   { mcps: boolean; agentMd: boolean };
}

export interface SourceSettings {
  claudeHome?: string;
  geminiHome?: string;
  codexHome?: string;
  opencodeDbPath?: string;
  extraClaudeHomes?: string[];
  enabled: SourcesEnabled;
}

export interface UserRedactionRule {
  label: string;
  pattern: string;
}

export interface PrivacySettings {
  redactIndex: boolean;
  redactionRules?: UserRedactionRule[];
  projectDenylist: string[];
  projectAllowlist?: string[];
  redactToolOutputs: boolean;
  redactPasteCache: boolean;
  redactFilePaths: boolean;
}

export interface SyncSettings {
  enabled: boolean;
  endpoint?: string;
  tokenRef?: string;
  upload: {
    raw?: boolean;
    findings: boolean;
    sessionMeta: boolean;
    dismissals: boolean;
    customRules: boolean;
  };
  excludeTools: Array<'claude' | 'gemini' | 'opencode' | 'codex'>;
  excludeProjects: string[];
  excludePreviewPatterns?: string[];
}

export interface AppSettings {
  v: number;
  embedding: EmbeddingSettings;
  summary: SummarySettings;
  sources: SourceSettings;
  privacy: PrivacySettings;
  sync: SyncSettings;
}

export interface SettingsResponse {
  settings: AppSettings;
  presets: {
    embeddingProviders: EmbedderProvider[];
    summaryProviders: SummaryProvider[];
    summaryCliPresets: string[];
    summaryCliPresetCommands: Record<string, string>;
    embeddingHints: Record<string, { label: string; requires: string }>;
    summaryHints: Record<string, { label: string; requires: string }>;
  };
  status: {
    ollama?: { reachable: boolean; models?: string[]; error?: string };
    geminiCli?: { available: boolean; version?: string };
    cli?: { available: boolean };
    /** preset name → whether its binary is on PATH */
    cliDetected?: Record<string, boolean>;
  };
}

export interface TestResult {
  ok: boolean;
  error?: string;
  note?: string;
  models?: string[];
  dimension?: number;
  version?: string;
}

export async function getSettings(): Promise<SettingsResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/settings`);
  if (!res.ok) throw new Error(`Failed to load settings: ${res.statusText}`);
  return await res.json();
}

export async function saveSettings(update: Partial<AppSettings>): Promise<{
  ok: boolean;
  settings: AppSettings;
  restartHint: string;
}> {
  const res = await fetchWithTimeout(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to save settings: ${res.statusText} ${body}`);
  }
  return await res.json();
}

export async function testSettings(
  kind: 'embedding' | 'summary',
  config: EmbeddingSettings | SummarySettings,
): Promise<TestResult> {
  const res = await fetchWithTimeout(`${API_BASE}/settings/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, config }),
  }, 15000);
  return await res.json();
}

// --- Patterns / cross-session insights ---

export interface PatternsHotFile {
  file: string;
  touchedInSessions: number;
  lastTouch: string;
  projects: string[];
  sampleSessionIds: string[];
}

export interface PatternsTopic {
  topic: string;
  sessionCount: number;
  sampleSessions: Array<{ id: string; project: string; snippet: string }>;
}

export interface PatternsRedundancy {
  projectPath: string;
  a: { id: string; mtime: string };
  b: { id: string; mtime: string };
  sharedFiles: string[];
  overlap: number;
}

export interface PatternsResponse {
  hotFiles: PatternsHotFile[];
  filesByProjectRecent: Record<string, Array<{ file: string; count: number; lastTouch: string }>>;
  redundancyPairs: PatternsRedundancy[];
  topics: PatternsTopic[];
  meta: { sessionsAnalyzed: number; generatedAt: string };
}

export async function getPatterns(): Promise<PatternsResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/analytics/patterns`, {}, 30000);
  if (!res.ok) throw new Error(`Failed to load patterns: ${res.statusText}`);
  return await res.json();
}

// --- Toolkit (skills, MCPs, commands, agents, hooks, plugins) ---

export type ToolkitType = 'skill' | 'mcp' | 'command' | 'agent' | 'hook' | 'plugin';

export interface ToolkitStatus {
  counts: Record<ToolkitType, Record<'claude' | 'gemini' | 'opencode' | 'codex', number>>;
}

export async function getToolkitStatus(): Promise<ToolkitStatus> {
  const res = await fetchWithTimeout(`${API_BASE}/toolkit/status`);
  if (!res.ok) throw new Error(`Failed to load toolkit status: ${res.statusText}`);
  return await res.json();
}

export async function browseToolkit(
  type: ToolkitType,
  opts: { limit?: number; offset?: number; tool?: 'all' | 'claude' | 'gemini' | 'opencode' | 'codex' } = {},
): Promise<MemoryMetadataRow[]> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.append('limit', String(opts.limit));
  if (opts.offset !== undefined) params.append('offset', String(opts.offset));
  if (opts.tool && opts.tool !== 'all') params.append('tool', opts.tool);
  const res = await fetchWithTimeout(`${API_BASE}/toolkit/browse/${type}?${params}`);
  if (!res.ok) throw new Error(`Failed to browse toolkit: ${res.statusText}`);
  const data = await res.json();
  return data.items;
}

export async function getToolkitItem(type: ToolkitType, id: string): Promise<MemoryMetadataRow> {
  const res = await fetchWithTimeout(`${API_BASE}/toolkit/item/${type}/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to get toolkit item: ${res.statusText}`);
  return await res.json();
}

export async function getToolkitItemContent(type: ToolkitType, id: string): Promise<{ content: string; filePath: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/toolkit/item/${type}/${encodeURIComponent(id)}/content`);
  if (!res.ok) throw new Error(`Failed to load toolkit item content: ${res.statusText}`);
  return await res.json();
}

export async function promoteToolkitItem(
  type: ToolkitType,
  sourceId: string,
  toTool: 'claude' | 'gemini' | 'opencode' | 'codex',
): Promise<{ ok: boolean; targetPath?: string; error?: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/toolkit/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, sourceId, toTool }),
  }, 30000);
  const data = await res.json();
  if (!res.ok) return { ok: false, error: data.error || res.statusText };
  return data;
}

// --- Sync-all (bulk promote across tools) ---

export type SyncTool = 'claude' | 'gemini' | 'opencode' | 'codex';
/** Toolkit primitives with a clean cross-tool sync matrix. */
export type SyncType = 'skill' | 'mcp' | 'command' | 'agent';

export interface SyncPlanEntry {
  type: SyncType;
  name: string;
  source: SyncTool;
  presentIn: SyncTool[];
  copyTo: SyncTool[];
}

export interface SyncResultEntry extends SyncPlanEntry {
  copied: { tool: SyncTool; targetPath?: string }[];
  skipped: { tool: SyncTool; reason: string }[];
  errors: { tool: SyncTool; error: string }[];
}

export interface SyncDryRunResponse {
  dryRun: true;
  plan: SyncPlanEntry[];
  totalToCopy: number;
}

export interface SyncRunResponse {
  dryRun: false;
  summary: {
    itemsConsidered: number;
    itemsCopied: number;
    itemsSkipped: number;
    itemsFailed: number;
  };
  results: SyncResultEntry[];
}

export async function syncToolkit(
  opts: { types?: SyncType[]; dryRun?: boolean } = {},
): Promise<SyncDryRunResponse | SyncRunResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/toolkit/sync-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  }, 120_000);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Sync failed: ${res.statusText}`);
  }
  return await res.json();
}

// --- Matrix view: name × tool presence ---

/** Each cell holds the source row id for that (name, tool), or is absent. */
export type MatrixCells = Record<string, Partial<Record<SyncTool, string>>>;

export interface ToolkitMatrix {
  skill:   MatrixCells;
  mcp:     MatrixCells;
  command: MatrixCells;
  agent:   MatrixCells;
  supportedTargets: Record<SyncType, SyncTool[]>;
}

export async function getToolkitMatrix(): Promise<ToolkitMatrix> {
  const res = await fetchWithTimeout(`${API_BASE}/toolkit/matrix`, {}, 30_000);
  if (!res.ok) throw new Error(`Failed to load toolkit matrix: ${res.statusText}`);
  return await res.json();
}

// --- Model-B cross-tool sync intents (UI enqueues, local agent executes) ---

export interface SyncIntentRow {
  id: string;
  device_id: string | null;
  kind: 'copy' | 'sync_all';
  artifact_type: string | null;
  name: string | null;
  from_tool: string | null;
  to_tool: string | null;
  status: 'pending' | 'done' | 'error';
  result: string | null;
  created_at: number;
  updated_at: number;
}

export type SyncIntentBody =
  | { kind: 'sync_all' }
  | { kind: 'copy'; artifactType: SyncType; name: string; fromTool: SyncTool; toTool: SyncTool };

/** Queue a cross-tool sync intent. The user's local CLI agent drains + executes it. */
export async function enqueueSyncIntent(body: SyncIntentBody): Promise<{ ok: boolean; id?: string; error?: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/sync-intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 30_000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || res.statusText };
  return { ok: true, id: data.id };
}

/** Recent intents (any status) — used to poll for "applied yet?". */
export async function listSyncIntents(limit = 50): Promise<SyncIntentRow[]> {
  const res = await fetchWithTimeout(`${API_BASE}/sync-intents?limit=${limit}`, {}, 30_000);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({ intents: [] }));
  return data.intents || [];
}

export async function removeToolkitItem(
  type: 'skill' | 'mcp',
  name: string,
  tool: SyncTool,
): Promise<{ ok: boolean; removedPath?: string; error?: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/toolkit/item`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, name, tool }),
  }, 30_000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || res.statusText };
  return data;
}

// --- Edits timeline / live session files ---

export type EditOp = 'edit' | 'write' | 'multi_edit' | 'notebook_edit' | 'read';
export type AiTool = 'claude' | 'gemini' | 'opencode' | 'codex';

export interface EditRow {
  ts: number;
  tsIso?: string;
  sessionId: string;
  projectPath: string;
  repoRoot?: string | null;
  repoName?: string | null;
  file: string;
  op: EditOp;
  toolName: string;
  tool: AiTool;
  line: number;
}

export interface EditsTimelineResponse {
  sinceHours: number;
  total: number;
  truncated: boolean;
  byTool?: Partial<Record<AiTool, number>>;
  byProject?: Record<string, number>;
  byRepo?: Record<string, { name: string; count: number; sample: string }>;
  edits: EditRow[];
}

export async function getEditsTimeline(opts: {
  sinceHours?: number;
  limit?: number;
  pattern?: string;
  project?: string;
  includeReads?: boolean;
  groupByRepo?: boolean;
  tools?: AiTool[];
} = {}): Promise<EditsTimelineResponse> {
  const params = new URLSearchParams();
  if (opts.sinceHours !== undefined) params.append('since_hours', String(opts.sinceHours));
  if (opts.limit !== undefined) params.append('limit', String(opts.limit));
  if (opts.pattern) params.append('pattern', opts.pattern);
  if (opts.project) params.append('project', opts.project);
  if (opts.includeReads) params.append('include_reads', 'true');
  if (opts.groupByRepo) params.append('group_by_repo', 'true');
  if (opts.tools && opts.tools.length > 0) params.append('tools', opts.tools.join(','));

  const res = await fetchWithTimeout(`${API_BASE}/edits/timeline?${params}`, {}, 30000);
  if (!res.ok) {
    throw new Error(`Failed to load edits timeline: ${res.statusText}`);
  }
  return await res.json();
}

export interface LiveSessionFiles {
  sessionId: string;
  tool: AiTool;
  projectPath: string;
  files: string[];
  reads: string[];
  filesByExt: Record<string, string[]>;
  edits: Array<{
    ts: number;
    tsIso?: string;
    file: string;
    op: EditOp;
    toolName: string;
    tool: AiTool;
    line: number;
  }>;
  source: 'live';
}

export async function getLiveSessionFiles(sessionId: string): Promise<LiveSessionFiles> {
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}/files-live`);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Session not found');
    throw new Error(`Failed to live-scan session: ${res.statusText}`);
  }
  return await res.json();
}

export async function updateItemProjectPath(
  sourceType: string,
  id: string,
  projectPath: string
): Promise<void> {
  const res = await fetch(`${API_BASE}/memory/item/${sourceType}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_path: projectPath }),
  });

  if (!res.ok) {
    throw new Error(`Failed to update project path: ${res.statusText}`);
  }
}

// ── Diff / Commits / Outcome / Markers / Turns ─────────────────────────

export type SessionStatus = 'shipped' | 'interrupted' | 'abandoned' | 'in_progress' | 'unknown';
export type PromptMarker =
  | 'interrupt'
  | 'frustrated'
  | 'correction'
  | 'approval'
  | 'question'
  | 'directive'
  | 'clarification_request';

export interface SessionDiffFile {
  file: string;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  reverted: boolean;
  succeededEvents: number;
  failedEvents: number;
  initialKnown: boolean;
  events: Array<{
    ts: number;
    tsIso?: string;
    line: number;
    toolName: string;
    toolUseId: string;
    succeeded: boolean;
    toolError?: string;
    applyError?: string;
    editsCount?: number;
    writeBytes?: number;
  }>;
}

export interface SessionDiffResponse {
  sessionId: string;
  projectPath: string;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  files: SessionDiffFile[];
  /** Set when the server returned 202 — the real payload is being computed. */
  _computing?: boolean;
}

export async function getSessionDiff(sessionId: string, file?: string): Promise<SessionDiffResponse> {
  const params = file ? `?file=${encodeURIComponent(file)}` : '';
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}/diff${params}`, {}, 60000);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Session not found');
    throw new Error(`Failed to load diff: ${res.statusText}`);
  }
  // 202 = server kicked off a background compute. Body is just a status
  // placeholder ({ status: 'computing', ... }) without any of the
  // payload fields the panels read. Tag it so the panel can render a
  // proper "still computing" state instead of crashing on
  // `undefined.length`.
  const body = await res.json();
  if (res.status === 202) return { ...body, _computing: true } as SessionDiffResponse;
  return body;
}

export interface SessionCommit {
  repo: string;
  repoName: string;
  sha: string;
  shortSha: string;
  authorIso: string;
  authorName: string;
  subject: string;
  body: string;
  files: string[];
  linesAdded: number;
  linesRemoved: number;
  matchedSessionFiles: string[];
}

export interface SessionCommitsResponse {
  sessionId: string;
  startMs: number;
  endMs: number;
  totalCommits: number;
  repos: Array<{
    repo: string;
    repoName: string;
    commits: SessionCommit[];
  }>;
  /** Set when the server returned 202 — the real payload is being computed. */
  _computing?: boolean;
}

export async function getSessionCommits(sessionId: string): Promise<SessionCommitsResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}/commits`, {}, 30000);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Session not found');
    throw new Error(`Failed to load commits: ${res.statusText}`);
  }
  const body = await res.json();
  if (res.status === 202) return { ...body, _computing: true } as SessionCommitsResponse;
  return body;
}

export interface SessionDecision { text: string; ts: number; tsIso?: string; line: number; }
export interface SessionBlocker {
  kind: 'tool_error' | 'interrupt' | 'unknown_error';
  text: string; ts: number; tsIso?: string; line: number;
}
export interface ClaimReactionPair {
  claim?: { text: string; ts: number; tsIso?: string; line: number };
  reaction?: { text: string; ts: number; tsIso?: string; line: number; markers: PromptMarker[]; intensity: number };
}
export interface MarkedPrompt {
  text: string; markers: PromptMarker[]; intensity: number;
  line?: number; ts?: number; tsIso?: string;
}
export interface SessionMarkerCounts {
  total: number;
  interrupt: number;
  frustrated: number;
  correction: number;
  approval: number;
  question: number;
  directive: number;
  clarification_request: number;
  peakIntensity: number;
}

export interface SessionOutcomeResponse {
  sessionId: string;
  found: boolean;
  status: SessionStatus;
  reason: string;
  startMs: number;
  endMs: number;
  decisions: SessionDecision[];
  blockers: SessionBlocker[];
  claimReaction: ClaimReactionPair;
  prompts: MarkedPrompt[];
  promptMarkers: SessionMarkerCounts;
  commits: SessionCommitsResponse;
  fileCount: number;
  filesChanged: string[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  /** Set when the server returned 202 — the real payload is being computed. */
  _computing?: boolean;
}

export async function getSessionOutcome(sessionId: string): Promise<SessionOutcomeResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}/outcome`, {}, 60000);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Session not found');
    throw new Error(`Failed to load outcome: ${res.statusText}`);
  }
  const body = await res.json();
  if (res.status === 202) return { ...body, _computing: true } as SessionOutcomeResponse;
  return body;
}

export interface SessionOutcomeBadgeResponse {
  // Server may return the heavyweight statuses (shipped/abandoned) when the
  // full classifier is later wired into the badge endpoint, or the cheaper
  // quick-classifier statuses today. The client shouldn't care which —
  // both tier into the same badge color via the rendering logic.
  emoji: string;
  label: 'shipped' | 'interrupted' | 'abandoned' | 'in_progress' | 'completed' | 'unknown';
  tooltip: string;
  fileCount: number;
  commits: number;
  cached?: boolean;
}

// In-memory L1 cache for badges. Survives for the page session — when a
// row scrolls out and back into view the IntersectionObserver re-fires,
// and the cached entry means we don't re-hit the network at all.
const badgeClientCache = new Map<string, SessionOutcomeBadgeResponse>();

// Negative cache for sessions the server returned 404 for, so we don't
// retry those forever during a single page session.
const badge404Cache = new Set<string>();

// Batching: when 50 rows render at once their IntersectionObservers all
// fire ~simultaneously. Per-row HTTP overhead in dev mode is ~600ms so
// 50 sequential calls take 30s. Coalescing them into one batch request
// turns that into a single ~50ms round-trip.
//
// Each call to `getSessionOutcomeBadge` pushes the requested id into a
// pending bucket and either schedules a flush (debounce window) or joins
// an already-scheduled flush. When the flush fires we POST all collected
// ids in one request, then resolve every pending caller from the result.
const BATCH_DEBOUNCE_MS = 30;
const MAX_BATCH = 200;
type PendingResolver = {
  resolve: (badge: SessionOutcomeBadgeResponse) => void;
  reject: (err: Error) => void;
};
let pendingBatch = new Map<string, PendingResolver[]>();
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

async function flushBadgeBatch(): Promise<void> {
  pendingTimer = null;
  if (pendingBatch.size === 0) return;
  const batch = pendingBatch;
  pendingBatch = new Map();

  const ids = Array.from(batch.keys());
  // The server caps at MAX_BATCH; if we have more, do multiple requests.
  // (Each chunk runs in parallel — they don't depend on each other.)
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += MAX_BATCH) {
    chunks.push(ids.slice(i, i + MAX_BATCH));
  }

  await Promise.all(chunks.map(async chunk => {
    try {
      const res = await fetchWithTimeout(`${API_BASE}/conversations/outcome/badges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: chunk }),
      }, 30000);
      if (!res.ok) throw new Error(`badges batch failed: ${res.status} ${res.statusText}`);
      const body = await res.json() as { badges: Record<string, SessionOutcomeBadgeResponse> };
      for (const id of chunk) {
        const resolvers = batch.get(id) ?? [];
        const badge = body.badges?.[id];
        if (badge) {
          badgeClientCache.set(id, badge);
          for (const r of resolvers) r.resolve(badge);
        } else {
          // Server didn't include this id — treat as 404.
          badge404Cache.add(id);
          for (const r of resolvers) r.reject(new Error('Session not found'));
        }
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const id of chunk) {
        const resolvers = batch.get(id) ?? [];
        for (const r of resolvers) r.reject(e);
      }
    }
  }));
}

export async function getSessionOutcomeBadge(sessionId: string): Promise<SessionOutcomeBadgeResponse> {
  // L1 client cache — instant.
  const hit = badgeClientCache.get(sessionId);
  if (hit) return hit;
  if (badge404Cache.has(sessionId)) throw new Error('Session not found');

  return new Promise<SessionOutcomeBadgeResponse>((resolve, reject) => {
    const list = pendingBatch.get(sessionId);
    if (list) {
      list.push({ resolve, reject });
    } else {
      pendingBatch.set(sessionId, [{ resolve, reject }]);
    }
    if (!pendingTimer) {
      pendingTimer = setTimeout(() => { void flushBadgeBatch(); }, BATCH_DEBOUNCE_MS);
    }
  });
}

export interface SessionMarkersResponse {
  sessionId: string;
  prompts: MarkedPrompt[];
  summary: SessionMarkerCounts;
}

export async function getSessionMarkers(sessionId: string): Promise<SessionMarkersResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}/markers`, {}, 30000);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Session not found');
    throw new Error(`Failed to load markers: ${res.statusText}`);
  }
  return await res.json();
}

export type TurnKind = 'user' | 'assistant_text' | 'tool_use' | 'tool_result';
export interface SessionTurn {
  kind: TurnKind;
  ts: number;
  tsIso?: string;
  line: number;
  text?: string;
  toolName?: string;
  toolUseId?: string;
  toolInputSummary?: string;
  command?: string;
  resultSummary?: string;
  resultIsError?: boolean;
  resultExitCode?: number;
  resultBytes?: number;
}
export interface SessionTurnsResponse {
  sessionId: string;
  found: boolean;
  startMs: number;
  endMs: number;
  turns: SessionTurn[];
}

export async function getSessionTurns(sessionId: string, limit?: number): Promise<SessionTurnsResponse> {
  const qp = limit ? `?limit=${limit}` : '';
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}/turns${qp}`, {}, 30000);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Session not found');
    throw new Error(`Failed to load turns: ${res.statusText}`);
  }
  return await res.json();
}

// ── Secret findings ────────────────────────────────────────────────
export interface SecretFinding {
  detector: string;
  rule: string;
  line: number;
  preview: string;
  scanned_at: number;
  /** Number of OTHER sessions that contain this same redacted key. */
  crossSessionCount?: number;
}
export interface SessionSecretsResponse {
  sessionId: string;
  total: number;
  byDetector: Record<string, SecretFinding[]>;
}

export async function getSessionSecrets(sessionId: string): Promise<SessionSecretsResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/secrets/session/${sessionId}`, {}, 15000);
  if (!res.ok) throw new Error(`Failed to load secrets: ${res.statusText}`);
  return await res.json();
}

// ── Global security view ───────────────────────────────────────────
export interface SecretsSummary {
  totals: Array<{ detector: string; findings: number; sessions: number }>;
  topRules: Array<{ detector: string; rule: string; n: number }>;
  sessionsWithFindings: number;
  total: number;
  verified: number;
  actionRequired: number;
  distinct: number;
}

export interface DistinctSecretsResponse {
  secrets: Array<{
    preview: string;
    rules: Array<{ detector: string; rule: string }>;
    detectors: string[];
    sessions: Array<{ sessionId: string; project: string; lines: number[] }>;
    sessionCount: number;
    occurrences: number;
    verified?: boolean | null;
  }>;
  dismissedCount: number;
}

export async function getDistinctSecrets(includeDismissed = false): Promise<DistinctSecretsResponse> {
  const qp = includeDismissed ? '?include_dismissed=true' : '';
  const res = await fetchWithTimeout(`${API_BASE}/secrets/distinct${qp}`, {}, 15000);
  if (!res.ok) throw new Error(`Failed to load distinct secrets: ${res.statusText}`);
  return await res.json();
}
export interface FlaggedSession {
  sessionId: string;
  project: string;
  title: string;
  mtime: number;
  detectors: Record<string, number>;
  total: number;
  agreement: number;
}
export async function getSecretsSummary(): Promise<SecretsSummary> {
  const res = await fetchWithTimeout(`${API_BASE}/secrets/summary`, {}, 15000);
  if (!res.ok) throw new Error(`Failed to load secrets summary: ${res.statusText}`);
  return await res.json();
}
export async function getFlaggedSessions(minAgreement = 1): Promise<{ sessions: FlaggedSession[]; count: number }> {
  const res = await fetchWithTimeout(`${API_BASE}/secrets/sessions?min=${minAgreement}`, {}, 15000);
  if (!res.ok) throw new Error(`Failed to load flagged sessions: ${res.statusText}`);
  return await res.json();
}

export interface SecretRuleRollup {
  detector: string;
  rule: string;
  occurrences: number;
  distinctSecrets: number;
  sessions: number;
  sampleSessions: string[];
  samplePreviews: string[];
}
export async function getSecretsByRule(): Promise<{ rules: SecretRuleRollup[] }> {
  const res = await fetchWithTimeout(`/api/secrets/by-rule`, {}, 15000);
  if (!res.ok) throw new Error(`Failed to load rules: ${res.statusText}`);
  return await res.json();
}

export async function dismissSecret(preview: string, status: 'rotated' | 'false_positive' | 'dismissed', reason?: string): Promise<void> {
  const res = await fetchWithTimeout('/api/secrets/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preview, status, reason }),
  }, 10000);
  if (!res.ok) throw new Error(`Dismiss failed: ${res.statusText}`);
}
export async function undismissSecret(preview: string): Promise<void> {
  const res = await fetchWithTimeout('/api/secrets/undismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preview }),
  }, 10000);
  if (!res.ok) throw new Error(`Undismiss failed: ${res.statusText}`);
}

/* ────────────────────────────────────────────────────────────────
 * Projects: workspaces, declared overrides, dossier rendering.
 * Backend: /api/projects (see web/server/src/routes/projects.ts).
 * ──────────────────────────────────────────────────────────────── */

export interface DeclaredSubProject { id: string; name?: string; path: string }
export interface DeclaredProject {
  id: string;
  name?: string;
  root: string;
  workspace?: boolean;
  children?: DeclaredSubProject[];
}
export interface ProjectsConfig {
  projects?: DeclaredProject[];
  ignore?: Array<{ match: string }>;
  autoWorkspaceMinRepos?: number;
}
export interface AggregatedProject {
  project_id: string;
  display_name: string;
  source: 'git-remote' | 'git-local' | 'auto-workspace' | 'path' | 'user' | 'ignored';
  items: number;
  last_mtime: number;
  workspace_id?: string;
  is_workspace?: boolean;
}
export interface ProjectsResponse {
  config_path: string;
  config: ProjectsConfig;
  workspaces: AggregatedProject[];
  standalone: AggregatedProject[];
  all: AggregatedProject[];
}

export async function getProjects(): Promise<ProjectsResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/projects`);
  if (!res.ok) throw new Error(`getProjects failed: ${res.statusText}`);
  return await res.json();
}

/**
 * Hierarchical project tree shape returned by /api/projects/tree.
 * Workspaces nest projects; an `untracked:*` node holds the path-only
 * buckets and any orphan transcripts (folder no longer on disk).
 */
export interface ProjectTreeApiNode {
  id: string;
  name: string;
  count: number;
  totalCount: number;
  children: ProjectTreeApiNode[];
  source?: 'git-remote' | 'git-local' | 'auto-workspace' | 'path' | 'user' | 'untracked';
  workspace?: boolean;
  orphan?: boolean;
}
export interface ProjectTreeResponse {
  nodes: ProjectTreeApiNode[];
  totalCount: number;
}

export async function getProjectTree(): Promise<ProjectTreeResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/projects/tree`);
  if (!res.ok) throw new Error(`getProjectTree failed: ${res.statusText}`);
  return await res.json();
}

export async function saveProjectsConfig(config: ProjectsConfig): Promise<{ ok: boolean; changed_rows: number }> {
  const res = await fetchWithTimeout(`${API_BASE}/projects`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  }, 60000);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`saveProjectsConfig failed: ${res.statusText} — ${err}`);
  }
  return await res.json();
}

export async function getProjectDossier(projectId: string, opts: { sessions?: number; tasks?: number; plans?: number } = {}): Promise<{ project_id: string; markdown: string }> {
  const qs = new URLSearchParams();
  if (opts.sessions) qs.set('sessions', String(opts.sessions));
  if (opts.tasks) qs.set('tasks', String(opts.tasks));
  if (opts.plans) qs.set('plans', String(opts.plans));
  const id = encodeURIComponent(projectId);
  const url = `${API_BASE}/projects/${id}/dossier${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetchWithTimeout(url, {}, 60000);
  if (!res.ok) throw new Error(`getProjectDossier failed: ${res.statusText}`);
  return await res.json();
}

// ── Account / billing / alerts (cloud) ───────────────────────────────────

export interface MeInfo {
  user: { sub: string; email: string | null };
  teams: Array<{ team_slug: string; name?: string; role?: string }>;
}
export interface Entitlement {
  billingEnabled: boolean;
  tenant: string;
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';
  plan: string | null;
  currentPeriodEnd: number | null;
  hasSubscription: boolean;
}
export interface PlanInfo {
  configured: boolean;
  trialDays: number;
  amount?: number | null;
  currency?: string;
  interval?: string | null;
  productName?: string | null;
}

/** Current Keycloak user + team memberships (self-authenticating route). */
export async function getMe(): Promise<MeInfo> {
  const res = await fetchWithTimeout(`${API_BASE}/me`);
  if (!res.ok) throw new Error(`getMe failed: ${res.statusText}`);
  return await res.json();
}

/** Create a personal workspace (team == tenant). Used by first-run onboarding.
 *  The server derives the slug from the name; returns { slug, name, role }. */
export async function createTeam(name: string): Promise<{ slug: string; name: string; role: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/teams`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `createTeam failed: ${res.statusText}`);
  return await res.json();
}

/** Current subscription/entitlement for the caller's tenant. Throws with the
 *  server's error message (e.g. "no team yet …") so the gate can branch on it. */
export async function getEntitlement(): Promise<Entitlement> {
  const res = await fetchWithTimeout(`${API_BASE}/billing`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `getEntitlement failed: ${res.statusText}`);
  return await res.json();
}

/** Public — Stripe-driven pricing for the landing page. Never throws on config. */
export async function getPlan(): Promise<PlanInfo> {
  const res = await fetchWithTimeout(`${API_BASE}/billing/plan`, {}, 15000);
  if (!res.ok) return { configured: false, trialDays: 14 };
  return await res.json();
}

/** Start a Stripe Checkout (card-required trial) → returns the hosted URL. */
export async function startCheckout(): Promise<string> {
  const res = await fetchWithTimeout(`${API_BASE}/billing/checkout`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `checkout failed: ${res.statusText}`);
  return body.url as string;
}

/** Open the Stripe Billing Portal (manage / cancel) → returns the hosted URL. */
export async function openBillingPortal(): Promise<string> {
  const res = await fetchWithTimeout(`${API_BASE}/billing/portal`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `portal failed: ${res.statusText}`);
  return body.url as string;
}

/** Secret-alert webhook config. */
export async function getAlertConfig(): Promise<{ webhookUrl: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/account/alerts`);
  if (!res.ok) throw new Error(`getAlertConfig failed: ${res.statusText}`);
  return await res.json();
}
export async function setAlertConfig(webhookUrl: string): Promise<{ webhookUrl: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/account/alerts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ webhookUrl }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `setAlertConfig failed: ${res.statusText}`);
  return body;
}
export async function testAlertWebhook(webhookUrl?: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/account/alerts/test`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(webhookUrl ? { webhookUrl } : {}),
  });
  return await res.json().catch(() => ({ ok: false, error: res.statusText }));
}
