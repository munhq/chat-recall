/**
 * API client for backend.
 */

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
  created: string;
  modified: string;
  filePath: string;
  firstPrompt?: string;
  summary?: string;
  tool?: string;
}

export interface IndexStats {
  totalChunks: number;
  totalSessions: number;
  projects: Record<string, number>;
  indexPath: string;
}

export interface ProjectInfo {
  path: string;
  name: string;
  count: number;
}

const API_BASE = '/api';

// Fetch with a timeout — prevents infinite hanging when server is down
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function searchSessions(
  query: string,
  topK = 10,
  projectFilter?: string
): Promise<SearchResult[]> {
  const res = await fetchWithTimeout(`${API_BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topK, projectFilter }),
  }, 30000);

  if (!res.ok) {
    throw new Error(`Search failed: ${res.statusText}`);
  }

  const data = await res.json();
  return data.results;
}

export async function getRecentSessions(limit = 20, projectFilter?: string, toolFilter?: string): Promise<SessionInfo[]> {
  const params = new URLSearchParams({ limit: limit.toString() });
  if (projectFilter) {
    params.append('project', projectFilter);
  }
  if (toolFilter) {
    params.append('tool', toolFilter);
  }

  const res = await fetchWithTimeout(`${API_BASE}/conversations/recent?${params}`);

  if (!res.ok) {
    throw new Error(`Failed to get recent sessions: ${res.statusText}`);
  }

  const data = await res.json();
  return data.sessions;
}

export async function getConversation(sessionId: string): Promise<Message[]> {
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}`, {}, 30000);

  if (!res.ok) {
    throw new Error(`Failed to get conversation: ${res.statusText}`);
  }

  const data = await res.json();
  return data.messages;
}

export async function getConversationWithSubagents(
  sessionId: string,
): Promise<{ messages: Message[]; subagents: Subagent[] }> {
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}`, {}, 30000);

  if (!res.ok) {
    throw new Error(`Failed to get conversation: ${res.statusText}`);
  }

  const data = await res.json();
  return { messages: data.messages ?? [], subagents: data.subagents ?? [] };
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
    avgCostPerSession: number;
    avgDurationMin: number;
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
    thisWeek: { sessions: number; cost: number; cacheRate: number };
    lastWeek: { sessions: number; cost: number; cacheRate: number };
  };
}

export async function getAnalytics(): Promise<AnalyticsData> {
  const res = await fetchWithTimeout(`${API_BASE}/analytics`, {}, 30000);
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
  estimatedCostUsd: number;
  cacheSavingsUsd: number;
}

export async function getSessionMetadata(sessionId: string): Promise<SessionMetadataResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}/metadata`);
  if (!res.ok) {
    throw new Error(`Failed to get session metadata: ${res.statusText}`);
  }
  return await res.json();
}

// --- Memory API ---

export type SourceType = 'session' | 'plan' | 'task' | 'claude_md' | 'paste' | 'history';

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

// --- Settings API ---

export interface AppSettings {
  SUMMARY_PROVIDER?: string;
  SUMMARY_CLI_PRESET?: string;
  SUMMARY_CLI_CMD?: string;
  SUMMARY_CLI_TIMEOUT_MS?: string;
  GEMINI_MODEL?: string;
  EMBEDDING_PROVIDER?: string;
  OLLAMA_HOST?: string;
  OLLAMA_SUMMARY_MODEL?: string;
  CLAUDE_DIR?: string;
}

export interface SettingsResponse {
  envPath: string;
  settings: AppSettings;
  presets: {
    summaryCliPresets: string[];
    summaryProviders: string[];
    embeddingProviders: string[];
  };
}

export async function getSettings(): Promise<SettingsResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/settings`);
  if (!res.ok) throw new Error(`Failed to load settings: ${res.statusText}`);
  return await res.json();
}

export async function saveSettings(settings: AppSettings): Promise<{
  ok: boolean;
  envPath: string;
  updated: string[];
  restartHint: string;
}> {
  const res = await fetchWithTimeout(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to save settings: ${res.statusText} ${body}`);
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
