/**
 * API client for backend.
 */
import { isCloud, handleUnauthorized } from './auth';

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
  /** What actually happened — attached by the server in one batch (no
   *  per-row badge fetch). `discussion` = talk-only session (no file edits,
   *  no commits). Absent = not classified yet; the row renders without it. */
  outcome?: {
    status: 'shipped' | 'abandoned' | 'interrupted' | 'in_progress' | 'completed' | 'discussion' | 'unknown';
    files: number;
    linesAdded: number;
    linesRemoved: number;
    commits: number;
  };
}

export interface IndexStats {
  totalChunks: number;
  totalSessions: number;
  projects: Record<string, number>;
  indexPath: string;
  /** False when the most recent vector-index read failed. UI shows a banner
   *  and continues to operate via keyword (Postgres full-text) fallback. */
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
// VITE_API_BASE to the cloud API origin (e.g. https://chatrecall.dev/api)
// and every request carries the Keycloak Bearer.
const API_BASE = import.meta.env.VITE_API_BASE || '/api';

// Fetch with a timeout — prevents infinite hanging when server is down.
// Default raised to 30s because the first request after a service restart
// can take 2–7s while the server's TTL path-map cache warms up; a 10s
// timeout would spuriously abort those cold-path requests and leave the
// UI blank. The hot path is ~50ms so 30s is well above the worst-case
// honest latency without being so long it hides real outages.
// Active team (cloud, multi-membership). The server resolves a JWT user to a
// tenant via team membership and REQUIRES `x-team` when the user is in more
// than one team (auth.ts resolveTenantForUser → 400 otherwise). We send it on
// every request so activity/tasks/shares/search all resolve to the same team.
// Single-team users can send it harmlessly; self-host ignores it.
const ACTIVE_TEAM_LS = 'cr-active-team';
let activeTeam: string | null = (() => { try { return localStorage.getItem(ACTIVE_TEAM_LS); } catch { return null; } })();
export function setActiveTeam(slug: string | null): void {
  activeTeam = slug || null;
  try { if (slug) localStorage.setItem(ACTIVE_TEAM_LS, slug); else localStorage.removeItem(ACTIVE_TEAM_LS); } catch { /* no storage */ }
}
export function getActiveTeam(): string | null { return activeTeam; }

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Cloud mode: the session rides as an httpOnly cookie, so there is no token
    // to attach — `credentials: 'include'` is what authenticates the call. It is
    // set unconditionally because it is inert in local mode (no cookie exists)
    // and omitting it in cloud mode 401s every request.
    //
    // NOTE for cross-origin deployments (VITE_API_BASE pointing at another
    // host): the browser will refuse a credentialed response unless the server
    // echoes a concrete Access-Control-Allow-Origin and Allow-Credentials, so
    // CORS_ORIGIN must be set there. Wildcard CORS and credentials are mutually
    // exclusive by spec. Same-origin deployments, which is how the SaaS runs,
    // never reach that path.
    const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined) };
    if (activeTeam) headers['x-team'] = activeTeam;
    const res = await fetch(url, { ...options, headers, credentials: 'include', signal: controller.signal });
    // 401 = the session died server-side (revoked, expired, or never existed).
    // Previously this was gated on "we had a token attached"; with cookies the
    // client cannot see the credential, so the response IS the signal.
    // handleUnauthorized() is idempotent and guards its own redirect loop.
    if (res.status === 401 && isCloud()) handleUnauthorized();
    // A 402 means one of two very different things, and treating them alike
    // locked out people who had paid or were mid-trial.
    //
    //   featureRequired()      → this ONE capability needs a higher plan. Carries
    //                            `feature`. A trialing tenant touching a Team-only
    //                            route gets this, and it says nothing about their
    //                            entitlement.
    //   'subscription required'→ the tenant has no live entitlement at all.
    //
    // Only the second is grounds for the full-screen gate. Broadcasting on both
    // meant a single refused endpoint replaced the whole app with a paywall
    // headed "Your trial has ended" — for someone whose trial ran for another
    // fortnight. On a body we cannot parse we stay silent: the caller still sees
    // its own error, and the server keeps enforcing payment on every request, so
    // the cost of not gating is nothing while the cost of gating wrongly is a
    // locked-out customer.
    if (res.status === 402) {
      void res.clone().json().then((body) => {
        const featureLevel = body && typeof body === 'object' && 'feature' in body;
        // A LIMIT-level 402 (free-tier sync meters) is a third kind: the tenant
        // is fine, one meter is full. It must not raise the paywall — it raises
        // the quota notice on the sync surface instead.
        const limit = parseSyncLimit(body);
        if (limit) { window.dispatchEvent(new CustomEvent('cr:sync-limit', { detail: limit })); return; }
        // A FOURTH kind: the write was refused because no email address is
        // confirmed yet. The fix is a link in an inbox, not a checkout — so it
        // gets its own event and never falls through to the paywall path, where
        // it used to vanish silently once the paywall stopped rendering for
        // resolvable tenants.
        const err = body && typeof body === 'object' ? String((body as { error?: unknown }).error ?? '') : '';
        if (/email confirmation/i.test(err)) {
          const detail = (body as { detail?: unknown }).detail;
          window.dispatchEvent(new CustomEvent('cr:confirm-email', {
            detail: typeof detail === 'string' && detail ? detail : 'Confirm your email address to start your trial.',
          }));
          return;
        }
        if (!featureLevel) window.dispatchEvent(new CustomEvent('cr:payment-required'));
      }).catch(() => { /* unparseable 402 — see above */ });
    }
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
  /** The CLI release this server serves — what a device's version is judged against. */
  cli?: { version: string; sha256: string } | null;
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
export interface CodeHealth { score: number; findings: number; critical: number; high: number; medium: number; low: number; hotspots: number; aiAuthoredPct: number; aiCommits?: number; totalCommits?: number; savingsPct?: number; totalLines?: number; totalBytes?: number; naiveTokens?: number; outlineTokens?: number; latestSeq?: number; watcher?: boolean; stats?: Record<string, number>; }
export interface CodeMapNode { file: string; pkg?: string; symbols: number; lines: number; }
export interface CodeCouplingMetric { file: string; fanIn: number; fanOut: number; instability: number; }
export interface CodeBlastRadius { fileRole: string; fanIn: number; fanOut: number; direct: number; transitive: number; maxDepth: number; directFiles?: string[]; }
export interface CodeMap { nodes: CodeMapNode[]; edges: Array<{ from: string; to: string }>; buckets: { god_modules: string[]; stable_cores: string[]; unstable_drivers: string[]; islands: string[]; cycles: string[][] }; pkgFiles?: Record<string, string[]>; fileEdges?: Array<{ from: string; to: string }>; fileMeta?: Record<string, { symbols: number; lang: string }>; langSymbols?: Record<string, number>; coupling?: { god_modules: CodeCouplingMetric[]; stable_cores: CodeCouplingMetric[]; unstable_drivers: CodeCouplingMetric[]; islands: CodeCouplingMetric[] }; blast?: Record<string, CodeBlastRadius>; }
export interface CodeProject { projectId: string; rootPath: string; fileCount: number; symbolCount: number; langs: Record<string, number>; health: CodeHealth; map: CodeMap; label?: string | null; lastIndexedAt: number; collectorVersion?: number | null; }
export interface CodeFinding { id: string; projectId: string; category: string; severity: string; file: string; line: number | null; rule: string; title: string; snippet: string; why: string; agentPrompt: string; status: string; }
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

// ── Knowledge graph (temporal entity-relationship facts) ──────────────────
// Previously had ZERO web surface despite being a headline feature. These wrap
// the existing /api/kg/* routes so the UI can finally render the graph.
export interface KgFact {
  direction?: 'incoming' | 'outgoing';
  subject: string; predicate: string; object: string;
  valid_from?: number | string | null; valid_to?: number | string | null;
  confidence?: number; source_session?: string | null; current?: boolean;
}
export interface KgStats { entities: number; triples: number; current_facts: number; expired_facts: number; relationship_types: number | string[]; }

export async function getKgStats(): Promise<KgStats> {
  const r = await fetchWithTimeout(`${API_BASE}/kg/stats`);
  return r.ok ? r.json() : { entities: 0, triples: 0, current_facts: 0, expired_facts: 0, relationship_types: 0 };
}
export async function queryKgEntity(entity: string, opts: { as_of?: string; direction?: 'incoming' | 'outgoing' | 'both' } = {}): Promise<{ entity: string; facts: KgFact[] }> {
  const r = await fetchWithTimeout(`${API_BASE}/kg/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity, ...opts }) });
  return r.ok ? r.json() : { entity, facts: [] };
}
export async function getKgTimeline(entity?: string, limit = 100): Promise<{ entity: string | null; entries: KgFact[] }> {
  const r = await fetchWithTimeout(`${API_BASE}/kg/timeline${qs({ entity, limit })}`);
  return r.ok ? r.json() : { entity: entity ?? null, entries: [] };
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
  /** Free plan: the server searched only this many trailing days. Null when the
   *  plan is unwindowed (or the server predates windowing). */
  windowDays: number | null;
  /** Free plan: matching results OUTSIDE the window — stored and locked, they
   *  unlock on upgrade. Null when unknown (the count is only attached when it is
   *  cheap to compute), 0 when everything matched inside the window. */
  lockedOlder: number | null;
}

export async function searchSessions(
  query: string,
  topK = 10,
  projectFilter?: string,
  // Only an explicit search (Enter / Search button) requests the semantic tier;
  // the debounced type-ahead leaves this false and stays FTS-only (no embed).
  semantic = false
): Promise<SearchResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      topK,
      projectFilter,
      semantic,
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
    // Free-plan window metadata. Defensive on purpose: a server that predates
    // windowing sends neither field, and that must read as "unwindowed".
    windowDays: typeof data.window_days === 'number' ? data.window_days : null,
    lockedOlder: typeof data.locked_older === 'number' ? data.locked_older : null,
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
  /** Free-tier window applied by the server; absent = unwindowed (paid). */
  windowDays?: number | null;
  /** Sessions the window locked away, given the caller's own filters. */
  lockedOlder?: number | null;
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
    windowDays: typeof data.window_days === 'number' ? data.window_days : null,
    lockedOlder: typeof data.locked_older === 'number' ? data.locked_older : null,
  };
}

export interface ConversationPage {
  messages: Message[];
  subagents: Subagent[];
  total: number;
  offset: number;
  /**
   * The server-side offset to ask for next: `offset + the rows the server
   * returned`, NOT `messages.length`. The command-noise filter below drops rows
   * AFTER the fetch, so a caller that pages by array length requests an offset
   * the server has already served and the same messages arrive twice.
   */
  nextOffset: number;
  hasMore: boolean;
}

const CONVERSATION_PAGE_SIZE = 500;

export async function getConversation(sessionId: string): Promise<Message[]> {
  const page = await getConversationPage(sessionId, 0, CONVERSATION_PAGE_SIZE);
  return page.messages;
}

export async function getConversationWithSubagents(
  sessionId: string,
): Promise<{ messages: Message[]; subagents: Subagent[]; total?: number; hasMore?: boolean; nextOffset: number }> {
  const page = await getConversationPage(sessionId, 0, CONVERSATION_PAGE_SIZE);
  return {
    messages: page.messages,
    subagents: page.subagents,
    total: page.total,
    hasMore: page.hasMore,
    nextOffset: page.nextOffset,
  };
}

/**
 * Fetch one window of a conversation. Server caps payload size with
 * `?limit=` and slices in-memory from the cached parse.
 *   - limit=0 → no slice (legacy / debug only — large sessions = MB of JSON)
 *   - limit>0 → server returns up to `limit` messages from `offset`
 */
// Claude Code logs slash-command / local-command plumbing as `user` turns
// (the caveat banner, the `/command` record, its stdout). The parser strips
// these at the source now, but envelopes synced before that fix still carry
// them — so we also drop them at render for immediate effect on existing data.
const COMMAND_NOISE = [
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
];
function isCommandNoise(m: Message): boolean {
  if (m.role !== 'user' || m.toolCalls?.length) return false;
  let t = m.content ?? '';
  for (const re of COMMAND_NOISE) t = t.replace(re, ' ');
  return t.trim().length === 0 && (m.content ?? '').trim().length > 0;
}

export async function getConversationPage(
  sessionId: string,
  offset = 0,
  limit = CONVERSATION_PAGE_SIZE,
): Promise<ConversationPage> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  const res = await fetchWithTimeout(`${API_BASE}/conversations/${sessionId}?${params}`, {}, 30000);
  if (!res.ok) throw new Error(`Failed to get conversation: ${res.statusText}`);
  const data = await res.json();
  const raw: Message[] = data.messages ?? [];
  const messages = raw.filter((m: Message) => !isCommandNoise(m));
  const servedFrom = data.offset ?? offset;
  return {
    messages,
    subagents: data.subagents ?? [],
    total: data.total ?? (messages.length),
    offset: servedFrom,
    // Count the RAW rows, so filtering never shifts the next request.
    nextOffset: servedFrom + raw.length,
    hasMore: !!data.hasMore,
  };
}

/** Safety bound for a walk to the end of a session: 40 pages = 20 000 messages. */
export const MAX_CONVERSATION_PAGES = 40;

/**
 * Page from `fromOffset` to the end of the session, handing each page to
 * `onPage` as it lands so the caller renders progressively instead of freezing
 * until the last page.
 *
 * `hasMore` in the result is true only if the page bound stopped the walk — the
 * caller must keep its own "load more" control alive in that case.
 */
export async function loadRestOfConversation(
  sessionId: string,
  fromOffset: number,
  onPage: (page: ConversationPage) => void,
): Promise<{ nextOffset: number; hasMore: boolean; total: number; pagesLoaded: number }> {
  let offset = fromOffset;
  let hasMore = true;
  let total = 0;
  let pagesLoaded = 0;
  while (hasMore && pagesLoaded < MAX_CONVERSATION_PAGES) {
    const page = await getConversationPage(sessionId, offset);
    onPage(page);
    total = page.total;
    hasMore = page.hasMore;
    pagesLoaded++;
    // The server returned no rows. Stop rather than request the same offset
    // for ever — a stalled walk is a hung tab.
    if (page.nextOffset <= offset) { hasMore = false; break; }
    offset = page.nextOffset;
  }
  return { nextOffset: offset, hasMore, total, pagesLoaded };
}


export async function getStatus(): Promise<IndexStats> {
  const res = await fetchWithTimeout(`${API_BASE}/status`);

  if (!res.ok) {
    throw new Error(`Failed to get status: ${res.statusText}`);
  }

  return await res.json();
}

/** One (day, status) cell of the activity rollup behind the dashboard's
 *  "this week" strip. `day` is YYYY-MM-DD (UTC, session file mtime). */
export interface OutcomeDayRow {
  day: string;
  status: 'shipped' | 'abandoned' | 'interrupted' | 'in_progress' | 'completed' | 'unknown';
  sessions: number;
  files: number;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
}

/** Sessions that actually edited a repo file (behaviour×code correlation).
 *  `file` is the repo-relative path a finding/hotspot carries. */
export async function getFileSessions(project: string, file: string, limit = 8): Promise<{ total: number; sessions: SessionInfo[] }> {
  const res = await fetchWithTimeout(`${API_BASE}/code/file-sessions?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}&limit=${limit}`);

  if (!res.ok) {
    throw new Error(`Failed to get file sessions: ${res.statusText}`);
  }

  return await res.json();
}

export async function getOutcomeSummary(days = 7): Promise<{ days: number; rows: OutcomeDayRow[] }> {
  const res = await fetchWithTimeout(`${API_BASE}/conversations/outcome-summary?days=${days}`);

  if (!res.ok) {
    throw new Error(`Failed to get outcome summary: ${res.statusText}`);
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

export interface AdminMetricsResponse {
  totals: {
    tenants: number;
    sessions: number;
    chunks: number;
    raw: number;
    findings: number;
    verified: number;
  };
  tenants: Array<{
    tenant: string;
    sessions: number;
    chunks: number;
    raw: number;
    findings: number;
    verified: number;
  }>;
}

export async function getAdminMetrics(): Promise<AdminMetricsResponse> {
  // Self-host gates /admin on the x-admin-key header (server ADMIN_KEY). The
  // console stashes the operator's key in localStorage; forward it here. In
  // cloud mode the key is absent and fetchWithTimeout attaches the Keycloak
  // Bearer instead — the admin realm role is what's checked there.
  const adminKey = (typeof localStorage !== 'undefined' && localStorage.getItem('cr-admin-key')) || '';
  const res = await fetchWithTimeout(
    `${API_BASE}/admin/metrics`,
    adminKey ? { headers: { 'x-admin-key': adminKey } } : {},
  );
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Failed to fetch admin metrics (status ${res.status})`);
  }
  return res.json();
}

/** Tenant-wide sync exclusions — edited here, pulled by every device's sync
 *  client and UNIONED with its local rules (server config only adds). */
export interface TenantSyncConfig {
  excludeTools: string[];
  excludeProjects: string[];
  /** Transcript sources switched off, by client-reported id. Exclusion-only:
   *  the dashboard can turn a discovered source off, but cannot name a path for
   *  a collector to start reading. */
  excludeSources: string[];
  /** Homes approved in the dashboard, by client-reported id. */
  approveSources: string[];
}

/** A transcript source a collector reported finding on its machine. Paths only
 *  ever travel machine → server; this is the read-back for rendering toggles. */
export interface ReportedSource {
  id: string;
  tool: string;
  path: string;
  sessions: number;
  newestMtime: number;
  isPrimary: boolean;
  /** primary | approved | declined | pending — `pending` is a prompt. */
  decision?: string;
  via?: string;
  device?: string;
  reportedAt: number;
}

/** Per-device health for the fleet panel. `warnings` is the payload that matters —
 *  empty means nothing is wrong with that machine. */
export interface FleetDeviceHealth {
  deviceId: string;
  os: string | null;
  cliVersion: string | null;
  lastSeenAt: number | null;
  lastSyncAt: number | null;
  sessions: number;
  folders: { syncing: number; pending: number; declined: number };
  warnings: string[];
}

export async function getFleetHealth(): Promise<{
  devices: FleetDeviceHealth[];
  summary: { devices: number; healthy: number; needsAttention: number; pendingFolders: number; unattributedSessions: number };
}> {
  const res = await fetchWithTimeout(`${API_BASE}/health/fleet`, {}, 15000);
  if (!res.ok) throw new Error(`Failed to load device health: ${res.statusText}`);
  return await res.json();
}

export async function getSyncSources(): Promise<{ sources: ReportedSource[]; excludeSources: string[]; approveSources: string[] }> {
  const res = await fetchWithTimeout(`${API_BASE}/sync-config/sources`);
  if (!res.ok) throw new Error(`Failed to get sync sources: ${res.statusText}`);
  return await res.json();
}

export async function getSyncConfig(): Promise<TenantSyncConfig> {
  const res = await fetchWithTimeout(`${API_BASE}/sync-config`);
  if (!res.ok) throw new Error(`Failed to get sync config: ${res.statusText}`);
  return await res.json();
}

export async function saveSyncConfig(cfg: TenantSyncConfig): Promise<TenantSyncConfig> {
  const res = await fetchWithTimeout(`${API_BASE}/sync-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Failed to save sync config: ${res.statusText}`);
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

export async function getAnalytics(tool?: 'all' | 'claude' | 'gemini' | 'opencode' | 'codex' | 'agy'): Promise<AnalyticsData> {
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
  /** Plans directly linked to this session (its own plan). */
  sessionPlans?: RelatedItem[];
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
  const res = await fetchWithTimeout(`${API_BASE}/memory/search`, {
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
    const res = await fetchWithTimeout(`${API_BASE}/settings/models?${q.toString()}`);
    if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { models: [], error: (err as Error).message };
  }
}

export async function getMemoryStatus(): Promise<MemoryStatus> {
  const res = await fetchWithTimeout(`${API_BASE}/memory/status`);

  if (!res.ok) {
    throw new Error(`Failed to get memory status: ${res.statusText}`);
  }

  return await res.json();
}

export async function getMemoryItem(sourceType: string, id: string): Promise<MemoryMetadataRow> {
  const res = await fetchWithTimeout(`${API_BASE}/memory/item/${sourceType}/${id}`);

  if (!res.ok) {
    throw new Error(`Failed to get memory item: ${res.statusText}`);
  }

  return await res.json();
}

export async function getMemoryItemContent(sourceType: string, id: string): Promise<string> {
  const res = await fetchWithTimeout(`${API_BASE}/memory/item/${sourceType}/${id}/content`);

  if (!res.ok) {
    throw new Error(`Failed to get memory item content: ${res.statusText}`);
  }

  const data = await res.json();
  return data.content;
}

export async function getMemoryLinks(sourceType: string, id: string): Promise<MemoryLinkRow[]> {
  const res = await fetchWithTimeout(`${API_BASE}/memory/links/${sourceType}/${id}`);

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

  const res = await fetchWithTimeout(`${API_BASE}/memory/browse/${sourceType}?${params}`);

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
  const res = await fetchWithTimeout(`${API_BASE}/memory/reindex`, {
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
  agy:      { sessions: boolean; plans: boolean };
  common:   { mcps: boolean; agentMd: boolean };
}

export interface SourceSettings {
  claudeHome?: string;
  geminiHome?: string;
  codexHome?: string;
  agyHome?: string;
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
  excludeTools: Array<'claude' | 'gemini' | 'opencode' | 'codex' | 'agy'>;
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
  counts: Record<ToolkitType, Record<'claude' | 'agy' | 'gemini' | 'opencode' | 'codex', number>>;
}

export async function getToolkitStatus(): Promise<ToolkitStatus> {
  const res = await fetchWithTimeout(`${API_BASE}/toolkit/status`);
  if (!res.ok) throw new Error(`Failed to load toolkit status: ${res.statusText}`);
  return await res.json();
}

export async function browseToolkit(
  type: ToolkitType,
  opts: { limit?: number; offset?: number; tool?: 'all' | 'claude' | 'gemini' | 'opencode' | 'codex' | 'agy' } = {},
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

export type SyncTool = 'claude' | 'agy' | 'gemini' | 'opencode' | 'codex';
/** Toolkit primitives with a clean cross-tool sync matrix. */
export type SyncType = 'skill' | 'mcp' | 'command' | 'agent' | 'instructions';

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
  tool: SyncTool;
  action: 'add' | 'remove';
}

export interface SyncResult {
  ok: boolean;
  total: number;
  copied: { tool: string; path?: string }[];
  skipped: { tool: string; reason: string }[];
  errors: { tool: string; error: string }[];
}

export async function bulkSyncToolkit(
  opts: { types?: SyncType[]; dryRun?: boolean } = {},
): Promise<SyncResult> {
  const res = await fetchWithTimeout(`${API_BASE}/toolkit/sync-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  }, 60_000);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Sync failed: ${res.statusText}`);
  }
  return await res.json();
}

// --- Matrix view: name × tool presence ---

/** Each cell holds the source row id for that (name, tool), or is absent. */
export type MatrixCells = Record<string, Partial<Record<string, string>>>;

export interface ToolkitMatrix {
  skill:   MatrixCells;
  mcp:     MatrixCells;
  command: MatrixCells;
  agent:   MatrixCells;
  instructions: MatrixCells;
  devices: string[];
  /** Per-device liveness — a column whose agent is offline can't apply anything. */
  deviceMeta?: Record<string, { lastSeenAt: number | null; cliVersion: string | null; os: string | null }>;
  supportedTargets: Record<SyncType, SyncTool[]>;
  pendingIntents?: any[];
}

/**
 * One capability needs a higher plan. The SERVER already answers this precisely
 * — `{error, feature, requires, upgradeUrl}` — so a caller can offer the upgrade
 * instead of reporting a failure.
 *
 * It exists because the alternative was shipped and was worse: the toolkit view
 * threw `Failed to load toolkit matrix: ${res.statusText}`, and `statusText` is
 * empty over HTTP/2, so a trialing user got a colon and nothing. A plan boundary
 * read as a broken product, mid-trial, which is the worst possible moment.
 */
export class FeatureGateError extends Error {
  readonly feature: string;
  readonly requires: string | null;
  readonly upgradeUrl: string | null;
  constructor(body: { error?: string; feature?: string; requires?: string; upgradeUrl?: string }) {
    super(body.error || 'this feature requires a higher plan');
    this.name = 'FeatureGateError';
    this.feature = body.feature || 'unknown';
    this.requires = body.requires || null;
    this.upgradeUrl = body.upgradeUrl || null;
  }
}

/**
 * The free tier's METER refusal, sibling of FeatureGateError. The server answers
 * a full sync meter with 402 { error, kind, used, limit, resetsAt?, requires,
 * upgradeUrl } (util/entitlements.ts limitReached). It is not an entitlement
 * problem — the tenant is fine, one meter is full — so it must never raise the
 * paywall; it renders as a quota notice with the numbers and the offer.
 */
export interface SyncLimitPayload {
  error: string;
  kind: 'sync_quota' | 'sync_storage';
  /** Bytes consumed against the meter. */
  used: number;
  /** The meter's size, in bytes. */
  limit: number;
  /** When the monthly meter turns over (ms). Absent for the storage cap. */
  resetsAt?: number;
  requires?: string;
  upgradeUrl?: string;
}

/** Recognise a limit-level 402 body. Null for anything else — including a
 *  feature-level 402, which carries `feature` and never `kind`. */
export function parseSyncLimit(body: unknown): SyncLimitPayload | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.kind !== 'sync_quota' && b.kind !== 'sync_storage') return null;
  if (typeof b.used !== 'number' || typeof b.limit !== 'number') return null;
  return {
    error: typeof b.error === 'string' ? b.error : 'sync limit reached',
    kind: b.kind,
    used: b.used,
    limit: b.limit,
    resetsAt: typeof b.resetsAt === 'number' ? b.resetsAt : undefined,
    requires: typeof b.requires === 'string' ? b.requires : undefined,
    upgradeUrl: typeof b.upgradeUrl === 'string' ? b.upgradeUrl : undefined,
  };
}

/** A sync meter is full. Carries the numbers so a caller renders an offer with
 *  used/limit and the reset date instead of relaying an opaque failure. */
export class SyncLimitError extends Error {
  readonly kind: SyncLimitPayload['kind'];
  readonly used: number;
  readonly limit: number;
  readonly resetsAt: number | null;
  readonly upgradeUrl: string | null;
  constructor(p: SyncLimitPayload) {
    super(p.error || 'sync limit reached');
    this.name = 'SyncLimitError';
    this.kind = p.kind;
    this.used = p.used;
    this.limit = p.limit;
    this.resetsAt = p.resetsAt ?? null;
    this.upgradeUrl = p.upgradeUrl ?? null;
  }
}

/**
 * Turn a non-OK response into the most specific error available: a
 * FeatureGateError for a feature-level 402, a SyncLimitError for a full free-tier
 * meter, otherwise a message that carries the server's own text.
 *
 * Never build a message from `res.statusText` alone — HTTP/2 has no status text,
 * so it is the empty string on every deployed response.
 */
export async function throwForResponse(res: Response, what: string): Promise<never> {
  let body: any = null;
  try { body = await res.clone().json(); } catch { /* not JSON — fall through */ }
  if (res.status === 402 && body && typeof body === 'object' && 'feature' in body) {
    throw new FeatureGateError(body);
  }
  if (res.status === 402) {
    const limit = parseSyncLimit(body);
    if (limit) throw new SyncLimitError(limit);
  }
  const detail = (body && typeof body === 'object' && (body.error || body.message))
    || res.statusText
    || `HTTP ${res.status}`;
  throw new Error(`${what}: ${detail}`);
}

/** What the post-checkout screen needs to hand a self-host buyer their licence. */
export interface LicenceDelivery {
  serial?: string;
  seats?: number | null;
  email?: string | null;
  features?: string[];
  /** The webhook has not landed yet — wait and ask again, do not report a fault. */
  pending?: boolean;
}

/**
 * Exchange a Stripe Checkout Session id for the licence serial it bought.
 *
 * The session id comes from the purchase redirect and is the only credential
 * involved, which is why this needs no account: the buyer of a self-hosted
 * licence has none with us.
 */
export async function getLicenceForSession(sessionId: string): Promise<LicenceDelivery> {
  const res = await fetchWithTimeout(
    `${API_BASE}/licence/for-session?session_id=${encodeURIComponent(sessionId)}`, {}, 20_000,
  );
  if (res.status === 202) return { pending: true };
  if (!res.ok) await throwForResponse(res, 'Could not look up this purchase');
  return await res.json();
}

/** Re-send the serial to the address already on the subscription — never to one
 *  the caller supplies, which would be an enumeration oracle. */
export async function resendLicenceSerial(sessionId: string): Promise<{ sent: boolean; email: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/licence/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  }, 20_000);
  if (!res.ok) await throwForResponse(res, 'Could not send the email');
  return await res.json();
}

export async function getToolkitMatrix(): Promise<ToolkitMatrix> {
  const res = await fetchWithTimeout(`${API_BASE}/toolkit/matrix`, {}, 30_000);
  if (!res.ok) await throwForResponse(res, 'Failed to load toolkit matrix');
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
  | { kind: 'copy'; artifactType: SyncType; name: string; fromTool: SyncTool; toTool: SyncTool; deviceId?: string | null };

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
export type AiTool = 'claude' | 'gemini' | 'opencode' | 'codex' | 'agy';

export interface EditRow {
  ts: number;
  tsIso?: string;
  sessionId: string;
  projectPath: string;
  projectId?: string | null;
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

// ── Activity summary (the "work rhythm" view) ──
export interface ActivityOutcomes { shipped: number; interrupted: number; abandoned: number; inProgress: number }
export interface ActivityProject {
  id: string; name: string; files: number; linesAdded: number; linesRemoved: number;
  sessions: number; outcomes: ActivityOutcomes; sparkline: number[];
  hotFiles: Array<{ file: string; edits: number }>;
}
export interface ActivitySummaryResponse {
  window: { sinceHours: number; from: number; to: number };
  pulse: Array<{ bucket: number; edits: number; sessions: number }>;
  totals: { sessions: number; files: number; linesAdded: number; linesRemoved: number } & ActivityOutcomes;
  projects: ActivityProject[];
  hotFiles: Array<{ file: string; project: string; edits: number }>;
  sessions: Array<{ id: string; title: string; tool: AiTool; project: string; outcome: string; files: number; linesAdded: number; linesRemoved: number; mtime: number }>;
}

export async function getActivitySummary(opts: { sinceHours?: number; project?: string; tools?: AiTool[] } = {}): Promise<ActivitySummaryResponse> {
  const params = new URLSearchParams();
  if (opts.sinceHours !== undefined) params.append('since_hours', String(opts.sinceHours));
  if (opts.project) params.append('project', opts.project);
  if (opts.tools && opts.tools.length > 0) params.append('tools', opts.tools.join(','));
  const res = await fetchWithTimeout(`${API_BASE}/edits/summary?${params}`, {}, 60000);
  if (!res.ok) throw new Error(`Failed to load activity summary: ${res.statusText}`);
  return await res.json();
}


export async function updateItemProjectPath(
  sourceType: string,
  id: string,
  projectPath: string
): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/memory/item/${sourceType}/${id}`, {
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
    firstSeen: number;
    lastSeen: number;
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
  const res = await fetchWithTimeout(`${API_BASE}/secrets/by-rule`, {}, 15000);
  if (!res.ok) throw new Error(`Failed to load rules: ${res.statusText}`);
  return await res.json();
}

export async function dismissSecret(preview: string, status: 'rotated' | 'false_positive' | 'dismissed', reason?: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/secrets/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preview, status, reason }),
  }, 10000);
  if (!res.ok) throw new Error(`Dismiss failed: ${res.statusText}`);
}
export async function undismissSecret(preview: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/secrets/undismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preview }),
  }, 10000);
  if (!res.ok) throw new Error(`Undismiss failed: ${res.statusText}`);
}

/* SECURITY_TASKS.md — per-project, status-tracked rotation checklist the local
 * agent writes into the repo (same rail as CODE_TASKS.md). */
export interface WriteSecurityTasksResult {
  ok: boolean;
  queued: boolean;
  intentId?: string;
  filename?: string;
  count?: number;
  open?: number;
  message: string;
}
export async function writeSecurityTasks(project: string): Promise<WriteSecurityTasksResult> {
  const res = await fetchWithTimeout(`${API_BASE}/secrets/tasks/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project }),
  }, 15000);
  if (!res.ok) throw new Error(`Write security tasks failed: ${res.statusText}`);
  return await res.json();
}

/* Custom (tenant-defined) secret-detection rules — CRUD + regex sandbox. */
export interface CustomSecretRule {
  id: number;
  name: string;
  regex: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string | null;
  /** SQLite-style flag from the server row: 1 = enabled, 0 = disabled. */
  enabled: number;
  /** 1 = this rule also REDACTS on the client (not just reports). The collector
   *  installs redact rules into its in-process redactor at sync time, so the
   *  pattern starts masking on every device without a CLI release. */
  redact?: number;
  updated_at: number;
}
/** The redaction set the collector installs at sync time: chat-recall's curated
 *  rules plus any tenant rule flagged `redact`. Served alongside the tenant's
 *  own rules so the dashboard can show what protection is already in place
 *  rather than an empty table. */
export interface ServedRulePack {
  version: string;
  revision?: string;
  source?: string;
  rules: Array<{ name: string; regex: string; flags?: string; redact: boolean; source: 'pack' | 'tenant' }>;
}
export async function getCustomSecretRules(): Promise<{ rules: CustomSecretRule[]; version?: string; pack?: ServedRulePack }> {
  const res = await fetchWithTimeout(`${API_BASE}/secrets/rules`, {}, 10000);
  if (!res.ok) throw new Error(`Failed to load custom rules: ${res.statusText}`);
  return await res.json();
}
export async function saveCustomSecretRule(rule: Partial<CustomSecretRule>): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/secrets/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rule),
  }, 10000);
  const j = await res.json().catch(() => ({}));
  return res.ok ? { ok: true } : { ok: false, error: j.error || res.statusText };
}
export async function deleteCustomSecretRule(id: number): Promise<void> {
  await fetchWithTimeout(`${API_BASE}/secrets/rules/${id}`, { method: 'DELETE' }, 10000);
}
export async function testCustomSecretRule(sample: string, regex: string): Promise<
  { ok: true; count: number; matches: Array<{ match: string; index: number }> } | { ok: false; error: string }
> {
  const res = await fetchWithTimeout(`${API_BASE}/secrets/rules/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sample, regex }),
  }, 10000);
  const j = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, ...j } : { ok: false, error: j.error || 'test failed' };
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
  source?: 'git-remote' | 'git-local' | 'auto-workspace' | 'path' | 'user' | 'untracked' | 'automation';
  workspace?: boolean;
  orphan?: boolean;
  /** Newest session mtime (ms) under this node — powers the "Recent" group. */
  lastMtime?: number;
  /** Filesystem path this project maps to. Needed to scope path-substring
   *  filters (memory search/browse filter on project_path, not project_id). */
  projectPath?: string;
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

// GET /api/projects/:id/dossier has no client caller: the dossier is consumed
// by the CLI (`chat-recall dossier`) and by MCP (recall_project_context), not
// by this UI. The route stays; the unused fetch wrapper does not.

// ── Account / billing / alerts (cloud) ───────────────────────────────────

export interface MeInfo {
  /** Platform operator (ADMIN_EMAILS on cloud). Used to HIDE the admin
   *  console rather than render it and let the server refuse — never a
   *  security boundary, since every admin route still calls requireAdmin(). */
  isOperator?: boolean;
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
  /** Authoritative "may this tenant use the paid surface?" — the same answer the
   *  server gate gives. Never re-derive this from status/dates on the client. */
  entitled?: boolean;
  /** The tenant's resolved features, from the server's one resolver. Used to hide
   *  what this account cannot use; never to decide access, which is server-side. */
  features?: string[];
  /** On the no-card trial (a trial with no Stripe subscription behind it). */
  onTrial?: boolean;
  /** Whole days remaining on that trial; null when not on one. */
  trialDaysLeft?: number | null;
  /** Configured trial length, for copy that states it. */
  trialLengthDays?: number;
  /** The plan actually in force — 'free' once the entitlement lapses. `plan`
   *  above stays the recorded billing row. */
  effectivePlan?: string | null;
  /** The plan's meters. null values mean unmetered. */
  limits?: {
    searchWindowDays: number | null;
    syncBytesPerMonth: number | null;
    syncStorageBytes: number | null;
  } | null;
  /** Metered tenants only. monthBytes = this month's sync traffic (the quota);
   *  storedBytes = what is actually stored (the cap) — measured, not summed
   *  traffic, so re-synced sessions do not inflate it. */
  usage?: { monthBytes: number; storedBytes: number; month: string } | null;
}
export interface PlanInfo {
  configured: boolean;
  trialDays: number;
  /** Length of the no-card trial a new tenant gets, in days. */
  freeTrialDays?: number;
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

// ── Device sync tokens (connect-your-machine onboarding) ────────────────

export interface DeviceInfo {
  deviceId: string;
  createdAt: number;
  revoked: boolean;
  /** Last authenticated request from this device (null = never since heartbeats shipped). */
  lastSeenAt?: number | null;
  /** CLI version the device last advertised, and its platform. */
  cliVersion?: string | null;
  os?: string | null;
}

/** semver-ish compare, mirroring the CLI's — -1 (a<b), 0, 1. Prereleases ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** A device is "offline" once it hasn't authenticated for 24h — the watch
 *  daemon heartbeats far more often than that, so silence this long is real. */
export const DEVICE_OFFLINE_MS = 24 * 3600 * 1000;

export type DeviceHealth = 'ok' | 'outdated' | 'offline' | 'unknown' | 'revoked';

/** Health of one device against the CLI release the server serves. */
export function deviceHealth(d: DeviceInfo, serverCli?: string | null, now = Date.now()): DeviceHealth {
  if (d.revoked) return 'revoked';
  if (!d.lastSeenAt) return 'unknown';
  if (now - d.lastSeenAt > DEVICE_OFFLINE_MS) return 'offline';
  if (serverCli && d.cliVersion && compareVersions(serverCli, d.cliVersion) > 0) return 'outdated';
  return 'ok';
}

/** Mint (or rotate) a device sync token. The raw token is shown ONCE. */
export async function mintDeviceToken(teamSlug: string, deviceId: string): Promise<{ token: string; device_id: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/teams/${encodeURIComponent(teamSlug)}/tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_id: deviceId }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `token mint failed: ${res.statusText}`);
  return await res.json();
}

/** Devices with a sync token (metadata only — never the token itself). */
export async function listDevices(teamSlug: string): Promise<DeviceInfo[]> {
  const res = await fetchWithTimeout(`${API_BASE}/teams/${encodeURIComponent(teamSlug)}/tokens`);
  if (!res.ok) throw new Error(`listing devices failed: ${res.statusText}`);
  return (await res.json()).devices ?? [];
}

export async function revokeDevice(teamSlug: string, deviceId: string): Promise<void> {
  const res = await fetchWithTimeout(
    `${API_BASE}/teams/${encodeURIComponent(teamSlug)}/tokens/${encodeURIComponent(deviceId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `revoke failed: ${res.statusText}`);
}

// ── Team collaboration (Phase 2/1): activity view + per-project sharing ──

export interface TeamActivityRow {
  authorSub: string | null;
  memberEmail: string | null;
  projectId: string;
  sessions: number;
  lastMtime: number;
}
export interface TeamActivityResponse {
  tenant: string;
  members: Array<{ sub: string; email: string | null; role: string }>;
  activity: TeamActivityRow[];
}
export interface ProjectShare {
  teamSlug: string;
  ownerSub: string;
  projectId: string;
  scope: string;
  sharedAt: number;
}

/** Per-member × per-project activity, RLS-scoped to what the caller may see. */
export async function getTeamActivity(opts: { project?: string; member?: string; sinceDays?: number } = {}): Promise<TeamActivityResponse> {
  const qs = new URLSearchParams();
  if (opts.project) qs.set('project', opts.project);
  if (opts.member) qs.set('member', opts.member);
  if (opts.sinceDays && opts.sinceDays > 0) qs.set('since', String(Date.now() - opts.sinceDays * 86400000));
  const suffix = qs.toString() ? `?${qs}` : '';
  const res = await fetchWithTimeout(`${API_BASE}/activity${suffix}`);
  if (!res.ok) await throwForResponse(res, 'Could not load team activity');
  return await res.json();
}

// Per-project sharing goes through the data-plane /api/shares (tenant + owner
// resolved from the request), so no team slug is threaded — the active-team
// header selects the team, exactly like every other data route.

/** Every share in the team (all members) — the "who shares what" overview. */
export async function listTeamShares(): Promise<ProjectShare[]> {
  const res = await fetchWithTimeout(`${API_BASE}/shares/all`);
  if (!res.ok) await throwForResponse(res, 'Could not load the team\u2019s shares');
  return (await res.json()).shares ?? [];
}

/** Just the caller's own shares (what YOU expose to the team). */
export async function listMyShares(): Promise<ProjectShare[]> {
  const res = await fetchWithTimeout(`${API_BASE}/shares`);
  if (!res.ok) await throwForResponse(res, 'Could not load your shares');
  return (await res.json()).shares ?? [];
}

/** Share one of the caller's projects into the team. */
export async function addShare(projectId: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/shares`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_id: projectId }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `addShare failed: ${res.statusText}`);
}

/** Stop sharing one of the caller's projects. */
export async function removeShare(projectId: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/shares`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_id: projectId }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `removeShare failed: ${res.statusText}`);
}

// ── Collaborative team tasks (Phase 3) ───────────────────────────────────

export type TeamTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
export interface TeamTask {
  id: string; projectId: string; title: string; description: string;
  status: TeamTaskStatus; assigneeSub: string | null; createdBy: string;
  blocks: string[]; blockedBy: string[]; linkedSessionId: string | null;
  /** Set when the card was auto-filed from a code finding. */
  linkedFindingId?: string | null;
  due: number | null; createdAt: number; updatedAt: number;
}

export interface AutoTasksPolicy { enabled: boolean; maxPri: 0 | 1 }
export async function getAutoTasksPolicy(): Promise<AutoTasksPolicy> {
  const res = await fetchWithTimeout(`${API_BASE}/tasks/policy`);
  if (!res.ok) throw new Error('Failed to load auto-tasks policy');
  return res.json();
}
export async function setAutoTasksPolicy(p: AutoTasksPolicy): Promise<AutoTasksPolicy> {
  const res = await fetchWithTimeout(`${API_BASE}/tasks/policy`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
  });
  if (!res.ok) throw new Error('Failed to save auto-tasks policy');
  return res.json();
}
export interface TeamTaskComment { id: string; taskId: string; authorSub: string; body: string; createdAt: number; }

export async function listTasks(opts: { project?: string; assignee?: string; status?: TeamTaskStatus } = {}): Promise<TeamTask[]> {
  const qs = new URLSearchParams();
  if (opts.project) qs.set('project', opts.project);
  if (opts.assignee) qs.set('assignee', opts.assignee);
  if (opts.status) qs.set('status', opts.status);
  const suffix = qs.toString() ? `?${qs}` : '';
  const res = await fetchWithTimeout(`${API_BASE}/tasks${suffix}`);
  if (!res.ok) throw new Error(`listTasks failed: ${res.statusText}`);
  return (await res.json()).tasks ?? [];
}

export async function createTask(input: { title: string; description?: string; projectId?: string; assigneeSub?: string | null }): Promise<TeamTask> {
  const res = await fetchWithTimeout(`${API_BASE}/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `createTask failed: ${res.statusText}`);
  return (await res.json()).task;
}

export async function getTask(id: string): Promise<{ task: TeamTask; comments: TeamTaskComment[] }> {
  const res = await fetchWithTimeout(`${API_BASE}/tasks/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`getTask failed: ${res.statusText}`);
  return await res.json();
}

export async function updateTask(id: string, patch: { status?: TeamTaskStatus; assigneeSub?: string | null; title?: string; description?: string }): Promise<TeamTask> {
  const res = await fetchWithTimeout(`${API_BASE}/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `updateTask failed: ${res.statusText}`);
  return (await res.json()).task;
}

export async function addTaskComment(id: string, body: string): Promise<TeamTaskComment> {
  const res = await fetchWithTimeout(`${API_BASE}/tasks/${encodeURIComponent(id)}/comments`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `addTaskComment failed: ${res.statusText}`);
  return (await res.json()).comment;
}

// ── The user's own data controls ───────────────────────────────────────────
//
// Export is a plain link rather than a fetch: the response is a streamed NDJSON
// download, and pulling megabytes into memory to hand them straight back to a
// blob is worse than letting the browser do what it already does well.

/** Where to point a download link. Export stays available when a tenant lapses
 *  (it is a GET), because taking your own history with you must never require
 *  paying again. */
export function dataExportUrl(project?: string): string {
  const qs = project ? `?project=${encodeURIComponent(project)}` : '';
  return `${API_BASE}/data/export${qs}`;
}

/** Delete every session under one project. Tombstoned, so a later sync will not
 *  restore it. */
export async function deleteProjectData(project: string): Promise<{ deleted: number }> {
  const res = await fetchWithTimeout(`${API_BASE}/data/delete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project }),
  }, 120_000);
  if (!res.ok) await throwForResponse(res, 'Could not delete that project');
  return await res.json();
}

/** Delete everything. `confirm` must be the exact phrase the server requires —
 *  the UI must not pre-fill it, or the guard is decoration. */
export async function deleteAllData(confirm: string): Promise<{ deleted: number }> {
  const res = await fetchWithTimeout(`${API_BASE}/data/delete-all`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm }),
  }, 300_000);
  if (!res.ok) await throwForResponse(res, 'Could not delete your data');
  return await res.json();
}

/** The phrase /api/data/delete-all demands. Shown to the user to type. */
export const DELETE_ALL_PHRASE = 'delete everything';

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

/** One entry of the plan catalogue, priced live by Stripe (never hardcoded). */
export interface CataloguePlan {
  key: string;
  label: string;
  selfServe: boolean;
  seats: 'fixed' | 'per_seat';
  minSeats?: number | null;
  maxSeats?: number | null;
  amount?: number | null;
  currency?: string;
  interval?: 'month' | 'year' | null;
  intervalCount?: number | null;
  productName?: string | null;
  contact?: string | null;
}
export interface PlanCatalogue {
  configured: boolean;
  billingEnabled: boolean;
  trialDays: number;
  freeTrialDays?: number;
  plans: CataloguePlan[];
}

/** The whole catalogue with live Stripe amounts. PUBLIC — no auth needed. */
export async function getPlans(): Promise<PlanCatalogue> {
  const res = await fetchWithTimeout(`${API_BASE}/billing/plans`, {}, 15000);
  if (!res.ok) return { configured: false, billingEnabled: false, trialDays: 14, plans: [] };
  return await res.json();
}

/** Start a Stripe Checkout for a specific plan → returns the hosted URL.
 *
 *  `plan` must be sent: with no body the server falls back to the FIRST self-serve
 *  plan in the catalogue, which silently sold Solo monthly to anyone who clicked
 *  a button meaning something else. */
export async function startCheckout(opts?: { plan?: string; seats?: number }): Promise<string> {
  const res = await fetchWithTimeout(`${API_BASE}/billing/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan: opts?.plan, seats: opts?.seats }),
  });
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
