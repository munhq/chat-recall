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

export async function getRecentSessions(
  limit = 20,
  projectFilter?: string,
  toolFilter?: string,
  sinceHours?: number,
): Promise<SessionInfo[]> {
  const params = new URLSearchParams({ limit: limit.toString() });
  if (projectFilter) {
    params.append('project', projectFilter);
  }
  if (toolFilter) {
    params.append('tool', toolFilter);
  }
  if (sinceHours !== undefined && Number.isFinite(sinceHours) && sinceHours > 0) {
    params.append('since_hours', String(sinceHours));
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
  estimatedCostUsd: number | null;
  cacheSavingsUsd: number | null;
}

export async function getSessionMetadata(sessionId: string): Promise<SessionMetadataResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}/metadata`);
  if (!res.ok) {
    throw new Error(`Failed to get session metadata: ${res.statusText}`);
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
}

export interface AppSettings {
  v: number;
  embedding: EmbeddingSettings;
  summary: SummarySettings;
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

// --- Companions / codeindex ---

export interface CodeindexStatus {
  installed: boolean;
  path?: string;
  version?: string;
  size?: number;
  prebuiltAvailable: boolean;
  artifactName?: string;
  unsupportedReason?: string;
}

export interface CodeindexInfo {
  status: CodeindexStatus;
  capabilities: Array<{ name: string; desc: string }>;
  installHint: { cli: string; curl: string; repo: string };
  pitch: string;
}

export async function getCodeindexStatus(): Promise<CodeindexInfo> {
  const res = await fetchWithTimeout(`${API_BASE}/settings/codeindex`);
  if (!res.ok) throw new Error(`Failed to load codeindex status: ${res.statusText}`);
  return await res.json();
}

export async function uninstallCodeindex(): Promise<{ ok: boolean; removed: boolean; unregistered: boolean }> {
  const res = await fetchWithTimeout(`${API_BASE}/settings/codeindex/uninstall`, { method: 'POST' });
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

// --- Edits timeline / live session files ---

export type EditOp = 'edit' | 'write' | 'multi_edit' | 'notebook_edit' | 'read';

export interface EditRow {
  ts: number;
  tsIso?: string;
  sessionId: string;
  projectPath: string;
  file: string;
  op: EditOp;
  toolName: string;
  line: number;
}

export interface EditsTimelineResponse {
  sinceHours: number;
  total: number;
  truncated: boolean;
  edits: EditRow[];
}

export async function getEditsTimeline(opts: {
  sinceHours?: number;
  limit?: number;
  pattern?: string;
  project?: string;
  includeReads?: boolean;
} = {}): Promise<EditsTimelineResponse> {
  const params = new URLSearchParams();
  if (opts.sinceHours !== undefined) params.append('since_hours', String(opts.sinceHours));
  if (opts.limit !== undefined) params.append('limit', String(opts.limit));
  if (opts.pattern) params.append('pattern', opts.pattern);
  if (opts.project) params.append('project', opts.project);
  if (opts.includeReads) params.append('include_reads', 'true');

  const res = await fetchWithTimeout(`${API_BASE}/edits/timeline?${params}`, {}, 30000);
  if (!res.ok) {
    throw new Error(`Failed to load edits timeline: ${res.statusText}`);
  }
  return await res.json();
}

export interface LiveSessionFiles {
  sessionId: string;
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
