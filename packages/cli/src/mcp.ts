#!/usr/bin/env node
/**
 * MCP server for chat-recall.
 *
 * Exposes chat recall as tools that can be used by Claude Code.
 */

import { config } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync as _execSync } from 'child_process';

import { getEmbedder, type EmbedderProvider } from '@chat-recall/engine/core/embedder.js';
import { acquireIndexLock } from '@chat-recall/engine/core/index-lock.js';
import { getRecentSessions, extractConversationContext, formatContext } from '@chat-recall/engine/core/context.js';
import { getCacheDbPath, getIdentityFilePath, getDataDir } from '@chat-recall/engine/core/paths.js';
import { parseSessionFile } from '@chat-recall/engine/parsers/session.js';
import {
  detectTool,
  liveScanModifiedFiles,
  liveScanRecentEdits,
  liveScanSessionEdits,
  type SessionEdit,
} from '@chat-recall/engine/core/live-session-scan.js';
import { findRepoRoot } from '@chat-recall/engine/core/session-replay.js';
import { getSessionCommits } from '@chat-recall/engine/core/session-git.js';
import { extractTurnsAny, replaySessionAny } from '@chat-recall/engine/core/session-multi-tool.js';
import { computeOutcome } from '@chat-recall/engine/core/session-outcome.js';
// Side-effect import: registers the four ToolBackend implementations so
// getBackendForId(...) works everywhere downstream.
import '@chat-recall/engine/core/backends/index.js';
import { claudeBackend } from '@chat-recall/engine/core/backends/claude.js';
import { listAvailableBackends, getBackendForId } from '@chat-recall/engine/core/tool-backend.js';
import type { SessionTurn } from '@chat-recall/engine/core/session-turns.js';
import { markPrompt, summarizeMarkers } from '@chat-recall/engine/core/session-sentiment.js';
import { tierFor } from '@chat-recall/engine/core/score-tier.js';
import { outcomeOneLiner, statusEmoji } from '@chat-recall/engine/core/outcome-display.js';
import { MemoryIndex } from '@chat-recall/engine/core/memory-index.js'; // static helpers only
import { createVectorStore } from '@chat-recall/engine/core/store/vector.js';
import { createStore } from '@chat-recall/engine/core/store/index.js';
import { buildProjectDossier } from '@chat-recall/engine/core/project-dossier.js';
import { SourceRegistry } from '@chat-recall/engine/core/source-registry.js';
import { SessionSource } from '@chat-recall/engine/parsers/session-source.js';
import { PlanSource } from '@chat-recall/engine/parsers/plan-source.js';
import { TaskSource } from '@chat-recall/engine/parsers/task-source.js';
import { ClaudeMdSource } from '@chat-recall/engine/parsers/claude-md-source.js';
import { HistorySource } from '@chat-recall/engine/parsers/history-source.js';
import { PasteSource } from '@chat-recall/engine/parsers/paste-source.js';
import { GeminiSessionSource } from '@chat-recall/engine/parsers/gemini-source.js';
import { GeminiBrainSource } from '@chat-recall/engine/parsers/gemini-brain-source.js';
import { OpenCodeSource } from '@chat-recall/engine/parsers/opencode-source.js';
import { OpenCodeTodoSource } from '@chat-recall/engine/parsers/opencode-todo-source.js';
import { CodexSessionSource } from '@chat-recall/engine/parsers/codex-session-source.js';
import { createMetadataCache } from '@chat-recall/engine/core/store/caches.js';
import { createKnowledgeGraph } from '@chat-recall/engine/core/store/knowledge-graph.js';
import { classifyChunk } from '@chat-recall/engine/core/memory-classifier.js';
import { extractAndPopulateKG } from '@chat-recall/engine/core/entity-extractor.js';
import { sanitizeQuery } from '@chat-recall/engine/core/query-sanitizer.js';
import { estimateCostUsdOrNull } from '@chat-recall/engine/core/model-pricing.js';
import { getWAL } from '@chat-recall/engine/core/write-ahead-log.js';
import { DiarySource } from '@chat-recall/engine/parsers/diary-source.js';
import { SkillsSource } from '@chat-recall/engine/parsers/skills-source.js';
import { McpsSource } from '@chat-recall/engine/parsers/mcps-source.js';
import { SlashCommandsSource } from '@chat-recall/engine/parsers/slash-commands-source.js';
import { SubagentsSource } from '@chat-recall/engine/parsers/subagents-source.js';
import { HooksSource } from '@chat-recall/engine/parsers/hooks-source.js';
import { PluginsSource } from '@chat-recall/engine/parsers/plugins-source.js';
import type { SourceType } from '@chat-recall/engine/types/memory.js';

// Load .env configuration
config();

/**
 * Cached check for whether the codeindex companion is available. We only run
 * this once per process (cheap PATH lookup) and use the result to decide
 * whether to append "tip: call codeindex find_symbol/read_symbol on these
 * files" hints to file-related tool responses.
 *
 * The cache is intentionally permissive: if the user installs codeindex while
 * the MCP server is running, they'll see the hint after the next mcp restart.
 * Trade-off: avoid a `which` syscall on every tool invocation.
 */
let _codeindexAvailable: boolean | null = null;
function codeindexAvailable(): boolean {
  if (_codeindexAvailable !== null) return _codeindexAvailable;
  try {
    _execSync('command -v codeindex', { stdio: 'ignore' });
    _codeindexAvailable = true;
  } catch {
    _codeindexAvailable = false;
  }
  return _codeindexAvailable;
}

/**
 * Append a one-line hint to a tool-result text body when codeindex is on PATH.
 * The agent sees both MCP servers but doesn't always know they compose — this
 * makes the connection explicit at the point where it'd actually be useful.
 */
function withCodeindexHint(body: string, kind: 'files' | 'redundancy' | 'session'): string {
  if (!codeindexAvailable()) return body;
  const hints: Record<string, string> = {
    files:      '\n\n_Tip: codeindex is also installed — call `find_symbol` or `get_outline` on these files for current symbol-level detail._',
    redundancy: '\n\n_Tip: codeindex is also installed — call `find_symbol` to check whether the symbols you\'re about to write already exist in this codebase._',
    session:    '\n\n_Tip: codeindex is also installed — call `get_outline` on each file for its current symbol structure._',
  };
  return body + hints[kind];
}

interface ShowMessage {
  line: number;
  role: string;
  text: string;
}

/**
 * Render any backend's session into the `ShowMessage[]` shape `recall_show`
 * consumes. Reads canonical events directly from the backend (not turns),
 * so Claude session-summary entries surface as `role: 'Summary'` rows
 * alongside user/assistant/tool turns — same as before the unification.
 *
 * Returns null when no backend recognizes `sessionId` or when the session
 * has no readable events.
 */
function loadMessagesViaRegistry(sessionId: string, includeCode: boolean): ShowMessage[] | null {
  const backend = getBackendForId(sessionId);
  if (!backend) return null;
  const events = backend.readEvents(backend.toRawId(sessionId));
  if (events.length === 0) return null;

  const messages: ShowMessage[] = [];
  for (const e of events) {
    let role = '';
    let text = '';
    if (e.kind === 'user') {
      role = 'User';
      text = e.text || '';
    } else if (e.kind === 'assistant_text') {
      role = backend.displayName;
      text = e.text || '';
      if (!includeCode) text = text.replace(/```[\s\S]*?```/g, '[code block]');
    } else if (e.kind === 'summary') {
      role = 'Summary';
      text = e.text || '';
    } else if (e.kind === 'tool_use') {
      role = 'Tool';
      const name = e.toolName || '';
      text = e.command ? `${name} $ ${e.command}` : name;
    } else if (e.kind === 'tool_result') {
      // Skip noisy successful outputs unless include_code asked for them.
      if (!includeCode && !e.resultIsError) continue;
      role = 'ToolResult';
      const body = (e.resultBody || '').slice(0, 8000);
      text = e.resultIsError ? `[error] ${body}` : body;
    }
    if (!text.trim()) continue;
    messages.push({ line: e.line, role, text });
  }
  return messages;
}

// ── Remote scope (chat-recall server) ───────────────────────────────
// When the user has run `chat-recall login`, search tools can query the
// synced server instead of the local index — cross-device (and team)
// recall from inside the agent. Local stays the default: it's offline,
// faster, and always present.

function remoteCredentials(): { base: string; token: string } | null {
  try {
    const raw = readFileSync(join(getDataDir(), 'credentials.json'), 'utf-8');
    const c = JSON.parse(raw) as { serverUrl?: string; token?: string };
    if (!c.serverUrl || !c.token) return null;
    return { base: c.serverUrl.replace(/\/+$/, ''), token: c.token };
  } catch { return null; }
}

async function remotePost<T>(path: string, body: unknown): Promise<T> {
  const cred = remoteCredentials();
  if (!cred) throw new Error('scope "server" needs a login — run `chat-recall login <server-url>` first.');
  const res = await fetch(cred.base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`server ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<T>;
}

async function remoteGet<T>(path: string): Promise<T> {
  const cred = remoteCredentials();
  if (!cred) throw new Error('scope "server" needs a login — run `chat-recall login <server-url>` first.');
  const res = await fetch(cred.base + path, {
    headers: { authorization: `Bearer ${cred.token}` },
  });
  if (!res.ok) throw new Error(`server ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<T>;
}

/**
 * Throw the uniform "you must log in" error when no credentials exist.
 * Every server-backed tool calls this at entry so the agent always gets the
 * same actionable message instead of a raw fetch failure.
 */
function requireRemote(): { base: string; token: string } {
  const cred = remoteCredentials();
  if (!cred) {
    throw new Error(
      'chat-recall is not logged in. Run `chat-recall login <server-url>` to connect this machine to your chat-recall server (self-host or cloud), then retry.',
    );
  }
  return cred;
}

/** GET with a query string built from params (undefined/null values are dropped). */
async function remoteGetQS<T>(path: string, params: Record<string, string | number | boolean | undefined | null>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const query = qs.toString();
  return remoteGet<T>(query ? `${path}?${query}` : path);
}

/**
 * GET that does NOT throw on 202/404 — the conversation deep-dive endpoints
 * answer 202 "pending-sync" (the session's compute hasn't been shipped from its
 * machine yet) or 404 (unknown session). Returns the status so the caller can
 * render a friendly message instead of a stack trace.
 */
async function remoteGetSoft<T>(path: string, params: Record<string, string | number | boolean | undefined | null> = {}): Promise<{ status: number; data: T | null; message?: string }> {
  const cred = requireRemote();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const q = qs.toString();
  const res = await fetch(cred.base + (q ? `${path}?${q}` : path), { headers: { authorization: `Bearer ${cred.token}` } });
  if (res.status === 202 || res.status === 404) {
    const body = await res.json().catch(() => ({}));
    return { status: res.status, data: null, message: (body as { message?: string }).message };
  }
  if (!res.ok) throw new Error(`server ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return { status: res.status, data: (await res.json()) as T };
}

// Tool schemas
const RecallSearchSchema = z.object({
  query: z.string().describe('What you\'re looking for (e.g., "OAuth implementation", "React hooks")'),
  top_k: z.number().optional().default(5).describe('Number of results to return'),
  project_filter: z.string().optional().describe('Optional filter by project path substring'),
  skip_ranking: z.boolean().optional().default(false).describe('Skip Claude ranking for faster results'),
  provider: z.enum(['ollama', 'gemini']).optional().default('ollama').describe('Embedding provider'),
  scope: z.enum(['local', 'server']).optional().default('local')
    .describe('local = this machine\'s index (default, offline). server = the synced chat-recall server (cross-device/team history; needs `chat-recall login`).'),
});

const RecallIndexSchema = z.object({
  force: z.boolean().optional().default(false).describe('Force re-index all sessions'),
  provider: z.enum(['ollama', 'gemini']).optional().default('ollama').describe('Embedding provider'),
});

const RecallShowSchema = z.object({
  session_id: z.string().describe('Session ID from search results'),
  around_line: z.number().optional().describe('Optional line number to show context around'),
  max_messages: z.number().optional().default(10).describe('Maximum messages to return'),
  from_end: z.number().optional()
    .describe('Return the last N messages of the session. Mutually exclusive with around_line.'),
  include_code: z.boolean().optional().default(false)
    .describe('Keep code blocks in assistant messages instead of replacing them with [code block].'),
});

const RecallRecentSchema = z.object({
  project_filter: z.string().optional().describe('Filter by project name (e.g., "inco", "poly")'),
  limit: z.number().optional().default(10).describe('Number of recent sessions to show'),
  since_hours: z.number().optional()
    .describe('Only include sessions modified in the last N hours. Combine with limit for "last 6h, top 20".'),
  scope: z.enum(['local', 'server']).optional().default('local')
    .describe('local = this machine (default). server = the synced chat-recall server (needs `chat-recall login`).'),
});

const RecallEditsTimelineSchema = z.object({
  since_hours: z.number().optional().default(24)
    .describe('Time window in hours. Defaults to 24h.'),
  limit: z.number().optional().default(100).describe('Maximum edit rows to return'),
  pattern: z.string().optional().describe('Optional substring filter on file path'),
  project_filter: z.string().optional()
    .describe('Filter by project name (matched against the encoded project directory name)'),
  include_reads: z.boolean().optional().default(false)
    .describe('Include read-type tool calls in addition to write/edit ones'),
  tools: z.array(z.enum(['claude', 'gemini', 'opencode', 'codex'])).optional()
    .describe('Restrict to a subset of AI tools. Default: all four (claude+gemini+opencode+codex).'),
  group_by_repo: z.boolean().optional().default(false)
    .describe('Group output by detected git repo root instead of returning a flat list. Useful when a single session touched multiple repos.'),
});

const RecallContextSchema = z.object({
  session_id: z.string().describe('Session ID to get context from'),
  include_turns: z.boolean().optional().default(false)
    .describe('Append an in-order turn-by-turn dump (user/assistant/tool calls/tool results) for full reasoning visibility.'),
  turns_limit: z.number().optional().default(60)
    .describe('Maximum turns to include when include_turns is true.'),
});

const RecallSummarySchema = z.object({
  session_id: z.string().describe('Session ID to get summary for'),
  rich: z.boolean().optional().default(true)
    .describe('Include the structured outcome (decisions, blockers, claim vs reaction, status). Set false for the legacy short summary only.'),
});

const RecallDiffSchema = z.object({
  session_id: z.string().describe('Session ID to replay edits for'),
  file: z.string().optional().describe('Only return the diff for this absolute file path'),
  context_only: z.boolean().optional().default(false)
    .describe('Skip the full unified diff bodies and return only file-level stats (lines added/removed, reverted flag)'),
  max_diff_chars: z.number().optional().default(4000)
    .describe('Truncate each per-file unified diff at this many characters in the rendered output'),
});

const RecallCommitsSchema = z.object({
  session_id: z.string().describe('Session ID whose edit window to look up commits for'),
  buffer_minutes: z.number().optional().default(30)
    .describe('Pad the session window by this many minutes on each side to catch commits made just after edits'),
});

const RecallOutcomeSchema = z.object({
  session_id: z.string().describe('Session ID to classify'),
});

const RecallMarkersSchema = z.object({
  session_id: z.string().describe('Session ID to mark prompts in'),
  limit: z.number().optional().default(200).describe('Maximum prompts to mark'),
});

const RecallSuggestResumeSchema = z.object({
  current_task: z.string().describe('What you\'re working on now'),
  top_k: z.number().optional().default(3).describe('Number of suggestions'),
  provider: z.enum(['ollama', 'gemini']).optional().default('ollama'),
});

const RecallMemorySearchSchema = z.object({
  query: z.string().describe('What you\'re looking for across all memory types'),
  top_k: z.number().optional().default(10).describe('Number of results'),
  source_types: z.array(z.enum(['session', 'plan', 'task', 'claude_md', 'paste', 'history', 'diary'])).optional()
    .describe('Filter by source types (default: all)'),
  project_filter: z.string().optional().describe('Filter by project path'),
  provider: z.enum(['ollama', 'gemini']).optional().default('ollama'),
  scope: z.enum(['local', 'server']).optional().default('local')
    .describe('local = this machine (default). server = the synced chat-recall server (needs `chat-recall login`).'),
});

const RecallMemoryStatusSchema = z.object({});

const RecallSmartResumeSchema = z.object({
  session_id: z.string().describe('Session ID to get smart resume context for'),
});

const RecallProjectContextSchema = z.object({
  project_path: z.string().describe('Project path or substring (e.g., "munbot", "chat-recall", "/home/user/code/personal/poly")'),
  limit: z.number().optional().default(5).describe('Number of recent sessions to include'),
});

const RecallProjectDossierSchema = z.object({
  project: z.string().describe('project_id (e.g. "git:github.com/me/repo", "ws:inco") OR an absolute path that resolves to one'),
  sessions: z.number().optional().default(10).describe('Max sessions to enumerate'),
  tasks: z.number().optional().default(20).describe('Max open tasks to list'),
  plans: z.number().optional().default(20).describe('Max plans to list'),
});

const RecallWeeklyDigestSchema = z.object({
  weeks_back: z.number().optional().default(0).describe('0 = current week, 1 = last week, etc.'),
});

const RecallPlansSchema = z.object({
  limit: z.number().optional().default(20).describe('Number of plans to list'),
});

const RecallPlanShowSchema = z.object({
  plan_id: z.string().describe('Plan ID (the filename without .md)'),
});

const RecallTasksSchema = z.object({
  limit: z.number().optional().default(20).describe('Number of task groups to list'),
});

// ── Knowledge Graph Schemas ──────────────────────────────────────

const RecallKGQuerySchema = z.object({
  entity: z.string().describe('Entity name to query (e.g., "Alice", "chat-recall", "PostgreSQL")'),
  as_of: z.string().optional().describe('Date filter — only facts valid at this date (YYYY-MM-DD)'),
  direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('both'),
});

const RecallKGAddSchema = z.object({
  subject: z.string().describe('The entity doing/being something'),
  predicate: z.string().describe('Relationship type (e.g., "uses", "works_on", "prefers")'),
  object: z.string().describe('The entity being connected to'),
  valid_from: z.string().optional().describe('When this became true (YYYY-MM-DD)'),
  source_session: z.string().optional().describe('Session ID where this was learned'),
});

const RecallKGInvalidateSchema = z.object({
  subject: z.string().describe('Entity'),
  predicate: z.string().describe('Relationship'),
  object: z.string().describe('Connected entity'),
  ended: z.string().optional().describe('When it stopped being true (YYYY-MM-DD, default: today)'),
});

const RecallKGTimelineSchema = z.object({
  entity: z.string().optional().describe('Entity to get timeline for (omit for full timeline)'),
  limit: z.number().optional().default(50),
});

const RecallKGStatsSchema = z.object({});

// ── Diary Schemas ────────────────────────────────────────────────

const RecallDiaryWriteSchema = z.object({
  agent_name: z.string().describe('Your name — each agent gets their own diary'),
  entry: z.string().describe('What happened, what you learned, what matters'),
  topic: z.string().optional().default('general').describe('Topic tag'),
  session_id: z.string().optional().describe('Current session ID (for linking)'),
  project_path: z.string().optional().describe('Project path (for context)'),
});

const RecallDiaryReadSchema = z.object({
  agent_name: z.string().describe('Agent name to read diary for'),
  last_n: z.number().optional().default(10).describe('Number of recent entries'),
});

// ── New tools (subagents, files-touched, user-prompts, decision-record) ──

const RecallSubagentSearchSchema = z.object({
  query: z.string().describe('Substring to search for inside subagent conversations'),
  session_id: z.string().optional().describe('Restrict to subagents of this session'),
  kind: z.enum(['explore', 'compact', 'aside', 'other']).optional()
    .describe('Filter by subagent kind. Compact subagents hold prior compacted history.'),
  limit: z.number().optional().default(20).describe('Maximum subagent files to inspect'),
});

const RecallFilesTouchedSchema = z.object({
  pattern: z.string().describe('File path or substring to look for (e.g., "auth.rs" or "src/api/")'),
  since_days: z.number().optional().default(30).describe('Only include sessions modified in the last N days'),
  limit: z.number().optional().default(20).describe('Maximum sessions to return'),
});

const RecallUserPromptsSchema = z.object({
  session_id: z.string().optional().describe('If set, only that session\'s prompts'),
  since_days: z.number().optional().default(7).describe('When session_id is omitted, look back this many days'),
  limit: z.number().optional().default(50).describe('Maximum prompts to return'),
  with_markers: z.boolean().optional().default(true)
    .describe('Tag each prompt with sentiment / corrective markers (interrupt, frustrated, correction, approval, …). Set false to revert to legacy text-only output.'),
});

const RecallDecisionRecordSchema = z.object({
  subject: z.string().describe('What the decision is about (e.g., "chat-recall", "auth strategy")'),
  decision: z.string().describe('The decision itself in plain words (e.g., "use SQLite FTS5 as the default search backend")'),
  reason: z.string().optional().describe('Why this was decided — short rationale'),
  importance: z.number().min(1).max(5).optional().default(4)
    .describe('1–5; the classifier surfaces 4+ in wake-up context'),
  session_id: z.string().optional().describe('Session this decision was made in (for traceability)'),
  agent_name: z.string().optional().default('agent').describe('Who recorded the decision (for diary linkage)'),
});

// ── Analytics summary + wake-up ────────────────────────────────────────────

const RecallAnalyticsSummarySchema = z.object({
  // No required inputs — returns the same summary the dashboard renders.
});

const RecallWakeUpSchema = z.object({
  max_facts: z.number().optional().default(10)
    .describe('How many high-importance classifier hits to include'),
  max_kg_facts: z.number().optional().default(15)
    .describe('How many current knowledge-graph facts to include'),
  identity: z.string().optional()
    .describe('Optional override for the identity blurb. Defaults to <data dir>/identity.txt or "AI coding assistant"'),
  project_filter: z.string().optional()
    .describe('Scope facts and KG entities to a project (substring match against project_path / entity name). Without this, facts are global and bleed across unrelated projects.'),
});

// ── Cross-session pattern detection ────────────────────────────────────────

const RecallSimilarSessionsSchema = z.object({
  query: z.string().optional()
    .describe('Free-text query (e.g. "implement OAuth login"). Mutually exclusive with session_id.'),
  session_id: z.string().optional()
    .describe('Find sessions similar to this one. Uses the session\'s first user prompt as the search text.'),
  top_k: z.number().optional().default(5).describe('Max sessions to return'),
  project_filter: z.string().optional().describe('Optional project path substring filter'),
}).refine(d => !!d.query !== !!d.session_id, {
  message: 'Provide exactly one of `query` or `session_id`.',
});

// ── Files-touched per session ───────────────────────────────────────────────

const RecallSessionFilesSchema = z.object({
  session_id: z.string().describe('Session whose file activity you want to inspect'),
});

// ── Redundancy detection (filename-level) ──────────────────────────────────

const RecallRedundantFilesSchema = z.object({
  filename: z.string().describe('File path or basename you\'re about to create (e.g. "src/auth/validator.ts")'),
  project_path: z.string().optional()
    .describe('Restrict the search to sessions in this project. Recommended.'),
  limit: z.number().optional().default(5).describe('Max similar files to return'),
});

// ── KV (third memory primitive) ────────────────────────────────────────────

const RecallSetSchema = z.object({
  key: z.string().describe('Key name (e.g. "current-pr", "default-test-runner")'),
  value: z.string().describe('Value to store. Plain string. JSON-encode if you need structure.'),
  scope: z.string().optional().default('default')
    .describe('Namespace. Use a project path or "global" / "session-<id>" to avoid collisions across contexts.'),
});

const RecallGetSchema = z.object({
  key: z.string().describe('Key name'),
  scope: z.string().optional().default('default'),
});

const RecallKvListSchema = z.object({
  scope: z.string().optional()
    .describe('Filter by scope. Omit to list across all scopes.'),
  limit: z.number().optional().default(50),
});

const server = new Server(
  {
    name: 'chat-recall',
    // Resolves to packages/cli/package.json from both src/ and the bundled dist/
    version: JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
    ).version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'recall_search',
        description: `Search for relevant Claude Code sessions to resume.

Find past conversations that are semantically similar to your current task.
Returns session IDs that can be used with \`claude --resume <session_id>\`.

Pass \`scope: "server"\` to search the synced chat-recall server instead —
your history across every logged-in device (and your team's, when on a team
plan). Needs a prior \`chat-recall login\`.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you\'re looking for (e.g., "OAuth implementation", "React hooks")' },
            top_k: { type: 'number', default: 5, description: 'Number of results to return' },
            project_filter: { type: 'string', description: 'Optional filter by project path substring' },
            skip_ranking: { type: 'boolean', default: false, description: 'Skip Claude ranking for faster results' },
            provider: { type: 'string', enum: ['ollama', 'gemini'], default: 'ollama', description: 'Embedding provider' },
            scope: { type: 'string', enum: ['local', 'server'], default: 'local', description: 'local = this machine (default, offline). server = synced cross-device history.' },
          },
          required: ['query'],
        },
      },
      {
        name: 'recall_index',
        description: `Index all Claude Code sessions for semantic search.

Scans ~/.claude/projects/ and creates embeddings for all sessions.
By default, only indexes new or changed sessions.`,
        inputSchema: {
          type: 'object',
          properties: {
            force: { type: 'boolean', default: false, description: 'Force re-index all sessions' },
            provider: { type: 'string', enum: ['ollama', 'gemini'], default: 'ollama', description: 'Embedding provider' },
          },
        },
      },
      {
        name: 'recall_status',
        description: 'Show index status and statistics.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'recall_show',
        description: `Get conversation content from a specific session.

Use this after recall_search to get full context from a session.

Set \`from_end: N\` to fetch the last N messages (no line-number guessing).
Set \`include_code: true\` to keep code blocks instead of redacting them — useful
when the user is asking "what did we change?" and the diffs/SQL/commands matter.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id:    { type: 'string', description: 'Session ID from search results' },
            around_line:   { type: 'number', description: 'Optional line number to show context around' },
            max_messages:  { type: 'number', default: 10, description: 'Maximum messages to return' },
            from_end:      { type: 'number', description: 'Return the last N messages (alternative to around_line).' },
            include_code:  { type: 'boolean', default: false, description: 'Keep code blocks in assistant messages.' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_recent',
        description: `List recent Claude Code sessions.

Shows your most recent conversations across all projects or filtered by project.
Use this when the user says "continue our last conversation" or wants to see recent work.

Pass \`since_hours: N\` to restrict to sessions modified in the last N hours.`,
        inputSchema: {
          type: 'object',
          properties: {
            project_filter: { type: 'string', description: 'Filter by project name (e.g., "inco", "poly")' },
            limit:          { type: 'number', default: 10, description: 'Number of recent sessions to show' },
            since_hours:    { type: 'number', description: 'Only include sessions modified in the last N hours.' },
            scope:          { type: 'string', enum: ['local', 'server'], default: 'local', description: 'server = synced cross-device history (needs chat-recall login).' },
          },
        },
      },
      {
        name: 'recall_edits_timeline',
        description: `Chronological list of file edits across recent sessions, spanning Claude Code,
Gemini CLI, and OpenCode.

Returns rows shaped like (timestamp, tool, session_id, project, file, op) sorted newest
first. Pulls live from each tool's native session store — Claude JSONL, Gemini chat
JSON, OpenCode SQLite — so the active session is included even though its metadata
hasn't been re-indexed yet.

Great for "what were we just changing?" — call with \`since_hours: 2\` to see the last
two hours of edits across every session and every AI tool.`,
        inputSchema: {
          type: 'object',
          properties: {
            since_hours:    { type: 'number', default: 24, description: 'Time window in hours' },
            limit:          { type: 'number', default: 100, description: 'Maximum edit rows to return' },
            pattern:        { type: 'string', description: 'Optional substring filter on file path' },
            project_filter: { type: 'string', description: 'Filter by encoded project directory name' },
            include_reads:  { type: 'boolean', default: false, description: 'Include Read tool_uses too' },
            tools:          {
              type: 'array',
              items: { type: 'string', enum: ['claude', 'gemini', 'opencode', 'codex'] },
              description: 'Restrict to specific AI tools. Default: all four.',
            },
            group_by_repo:  { type: 'boolean', default: false, description: 'Group results by detected git repo root.' },
          },
        },
      },
      {
        name: 'recall_context',
        description: `Get structured context from a session for continuation.

Returns:
- Your requests/inputs
- Claude's work/decisions
- Key topics discussed
- Tools used and files changed
- Summary if available

Use this to understand what happened in a session before resuming.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID to get context from' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_summary',
        description: `Get the summary for a session.

By default returns a *rich* summary that combines the AI summary (when available)
with a structured breakdown derived from the transcript itself: status (shipped /
interrupted / abandoned / in_progress), decisions the agent announced, blockers
hit (tool errors, interrupts), and the last assistant claim paired with the
user's reaction to it. Pass \`rich: false\` to fall back to the legacy
single-line AI summary only.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID to get summary for' },
            rich:       { type: 'boolean', default: true, description: 'Include structured outcome alongside AI summary' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_diff',
        description: `Replay a session's Edit/Write/MultiEdit/NotebookEdit tool calls into a unified
diff per file. Lets you see what the agent actually changed — not just that it
edited, but how — without grepping the raw transcript.

Detects reverts: when a file was edited but the final state matches the initial
state, the file is reported with \`reverted: true\` and a zero-line diff.

Pass \`file\` to focus on a single absolute path. Pass \`context_only: true\` for
just the per-file stats (lines added/removed) when you don't need the diff body.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id:     { type: 'string', description: 'Session ID to replay' },
            file:           { type: 'string', description: 'Absolute file path to focus on (optional)' },
            context_only:   { type: 'boolean', default: false, description: 'Skip diff bodies, return stats only' },
            max_diff_chars: { type: 'number', default: 4000, description: 'Truncate each per-file unified diff' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_commits',
        description: `Find git commits that landed during a session's edit window, grouped by repo.

Multi-repo aware: a session that touched ~/code/personal/k8s_gpu and
~/code/personal/munbot returns commits from each repo, with overlap shown
between commit-files and session-touched-files.

Use this to verify "shipped" claims — if the session edited 18 files but no
matching commit exists, work probably stayed local.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id:     { type: 'string', description: 'Session ID to look up commits for' },
            buffer_minutes: { type: 'number', default: 30, description: 'Window padding on each side' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_outcome',
        description: `Classify a session as shipped / interrupted / abandoned / in_progress / unknown,
with the supporting evidence: decisions the agent announced, blockers it hit,
and the final claim paired with the user's reaction (so you can see whether
"done!" was actually accepted or was met with "wtf").

This is the single most useful triage call when scanning a session list — it
answers the question the AI summary doesn't: did this work actually land?`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID to classify' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_markers',
        description: `Tag every user prompt in a session with sentiment / corrective markers:

  • interrupt              — user hit ESC mid-response
  • frustrated             — caps, profanity, "wtf", "ffs"
  • correction             — "no", "stop", "don't" — negating the last action
  • approval               — "yes", "do it", "i approve"
  • question               — "why", "what", ends with ?
  • directive              — "use X", "implement Y", "build Z"
  • clarification_request  — "wdym", "explain", "what is"

Returns per-prompt markers + a session-level summary count. Use this to spot
sessions where things went sideways before reading the whole transcript.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID to mark prompts in' },
            limit:      { type: 'number', default: 200, description: 'Maximum prompts to return' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_suggest_resume',
        description: `Suggest past conversations to resume based on your current task.

Given what you're working on, finds the most relevant past conversations
and provides summaries + resume commands.

Perfect for: "I'm working on X, what past work is relevant?"`,
        inputSchema: {
          type: 'object',
          properties: {
            current_task: { type: 'string', description: 'What you\'re working on now' },
            top_k: { type: 'number', default: 3, description: 'Number of suggestions' },
            provider: { type: 'string', enum: ['ollama', 'gemini'], default: 'ollama' },
          },
          required: ['current_task'],
        },
      },
      {
        name: 'recall_memory_search',
        description: `Search across all memory types: sessions, plans, tasks, CLAUDE.md files, history, paste cache, and agent diaries.

Returns results from any memory source, ranked by relevance. Use source_types to filter.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you\'re looking for across all memory types' },
            top_k: { type: 'number', default: 10, description: 'Number of results' },
            source_types: {
              type: 'array',
              items: { type: 'string', enum: ['session', 'plan', 'task', 'claude_md', 'paste', 'history', 'diary'] },
              description: 'Filter by source types (default: all)',
            },
            project_filter: { type: 'string', description: 'Filter by project path' },
            provider: { type: 'string', enum: ['ollama', 'gemini'], default: 'ollama' },
            scope: { type: 'string', enum: ['local', 'server'], default: 'local', description: 'server = synced cross-device history (needs chat-recall login).' },
          },
          required: ['query'],
        },
      },
      {
        name: 'recall_memory_status',
        description: 'Show memory system status across all source types (sessions, plans, tasks, etc).',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'recall_smart_resume',
        description: `Get structured resume context for a session.

Returns:
- What was done (completed work, decisions made)
- What's pending (unfinished tasks, TODOs mentioned)
- Files modified with change summary
- Token/cost budget used
- Resume command

Use this instead of recall_context for a more actionable summary when resuming work.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID to resume' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_project_context',
        description: `Get rich project context for a project path.

Returns:
- Recent sessions with summaries
- Open tasks
- Related plans
- Recent git commits (if git repo)
- Cost and token usage
- Files modified recently

Use at the START of a new session to understand what's been happening in a project.`,
        inputSchema: {
          type: 'object',
          properties: {
            project_path: { type: 'string', description: 'Project path or substring (e.g., "munbot", "chat-recall")' },
            limit: { type: 'number', default: 5, description: 'Number of recent sessions to include' },
          },
          required: ['project_path'],
        },
      },
      {
        name: 'recall_project_dossier',
        description: `Generate a full project dossier as markdown.

Aggregates everything the index knows about one project into a single report:
overview (from CLAUDE.md), tech stack (KG uses), architecture / deployment / security
sections (from CLAUDE.md), decisions log (KG chose/rejected), recent session activity,
open tasks, plans, agent diary conclusions, and cost rollup.

Input MUST be a logical project_id (one of:
  - "git:<host>/<owner>/<repo>"   (e.g. "git:github.com/me/munbot")
  - "ws:<name>"                   (workspace rollup)
  - "git-local:<sha1>"            (local-only git repo)
  - "user:<custom>"               (declared in ~/.chat-recall/projects.json)

Get the list of valid ids from \`recall_project_context\` or the web UI's
sidebar (each leaf has its project_id). Path inputs are no longer accepted
— pass the id, not the folder.`,
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'project_id — must start with git:, ws:, git-local:, or user:' },
            sessions: { type: 'number', default: 10 },
            tasks: { type: 'number', default: 20 },
            plans: { type: 'number', default: 20 },
          },
          required: ['project'],
        },
      },
      {
        name: 'recall_weekly_digest',
        description: `Get a weekly activity digest across all projects.

Returns:
- Session count, total cost, coding time
- Top projects by activity
- Cost trend vs previous week
- Open tasks across projects
- Git activity summary

Use to understand overall productivity and spending.`,
        inputSchema: {
          type: 'object',
          properties: {
            weeks_back: { type: 'number', default: 0, description: '0 = current week, 1 = last week' },
          },
        },
      },
      {
        name: 'recall_plans',
        description: `List indexed plans from ~/.claude/plans/.

Shows plan titles and metadata. Use recall_memory_search to search plan content.`,
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', default: 20, description: 'Number of plans to list' },
          },
        },
      },
      {
        name: 'recall_plan_show',
        description: `Show the full content of a specific plan by ID.

Use this to view or edit the complete plan text. Pass the plan_id from recall_plans results.`,
        inputSchema: {
          type: 'object',
          properties: {
            plan_id: { type: 'string', description: 'Plan ID (filename without .md extension)' },
          },
          required: ['plan_id'],
        },
      },
      {
        name: 'recall_tasks',
        description: `List indexed task groups from ~/.claude/tasks/.

Each task group corresponds to a session. Shows task subjects and status.`,
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', default: 20, description: 'Number of task groups to list' },
          },
        },
      },
      // ── Knowledge Graph Tools ──────────────────────────────────
      {
        name: 'recall_kg_query',
        description: `Query the knowledge graph for an entity's relationships.

Returns typed facts with temporal validity. E.g. "chat-recall" → uses TypeScript, has source FTS5.
Filter by date with as_of to see what was true at a specific point in time.
Use this to VERIFY facts before asserting them.`,
        inputSchema: {
          type: 'object',
          properties: {
            entity: { type: 'string', description: 'Entity to query (e.g., "Alice", "chat-recall")' },
            as_of: { type: 'string', description: 'Date filter (YYYY-MM-DD, optional)' },
            direction: { type: 'string', enum: ['outgoing', 'incoming', 'both'], default: 'both' },
          },
          required: ['entity'],
        },
      },
      {
        name: 'recall_kg_add',
        description: `Add a fact to the knowledge graph. Subject → predicate → object with optional time window.

E.g. ("chat-recall", "uses", "LanceDB", valid_from="2024-01-15")`,
        inputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'The entity doing/being something' },
            predicate: { type: 'string', description: 'Relationship type (e.g., "uses", "works_on", "prefers")' },
            object: { type: 'string', description: 'The entity being connected to' },
            valid_from: { type: 'string', description: 'When this became true (YYYY-MM-DD, optional)' },
            source_session: { type: 'string', description: 'Session ID where this was learned (optional)' },
          },
          required: ['subject', 'predicate', 'object'],
        },
      },
      {
        name: 'recall_kg_invalidate',
        description: `Mark a fact as no longer true. Use when things change — tools replaced, decisions reversed, people leave.`,
        inputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Entity' },
            predicate: { type: 'string', description: 'Relationship' },
            object: { type: 'string', description: 'Connected entity' },
            ended: { type: 'string', description: 'When it stopped being true (YYYY-MM-DD, default: today)' },
          },
          required: ['subject', 'predicate', 'object'],
        },
      },
      {
        name: 'recall_kg_timeline',
        description: `Get chronological timeline of facts. Shows the story of an entity (or everything) in order.`,
        inputSchema: {
          type: 'object',
          properties: {
            entity: { type: 'string', description: 'Entity to get timeline for (optional)' },
            limit: { type: 'number', default: 50 },
          },
        },
      },
      {
        name: 'recall_kg_stats',
        description: 'Knowledge graph overview: entities, triples, current vs expired facts, relationship types.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      // ── Diary Tools ────────────────────────────────────────────
      {
        name: 'recall_diary_write',
        description: `Write to your agent diary. Record observations, decisions, what you worked on, what matters.

Each agent gets their own persistent diary across sessions. Use this at the end of sessions
or when you learn something important that should persist.`,
        inputSchema: {
          type: 'object',
          properties: {
            agent_name: { type: 'string', description: 'Your name — each agent gets their own diary' },
            entry: { type: 'string', description: 'What happened, what you learned, what matters' },
            topic: { type: 'string', default: 'general', description: 'Topic tag' },
            session_id: { type: 'string', description: 'Current session ID (for linking)' },
            project_path: { type: 'string', description: 'Project path (for context)' },
          },
          required: ['agent_name', 'entry'],
        },
      },
      {
        name: 'recall_diary_read',
        description: `Read your recent diary entries. See what past versions of yourself recorded across sessions.`,
        inputSchema: {
          type: 'object',
          properties: {
            agent_name: { type: 'string', description: 'Agent name to read diary for' },
            last_n: { type: 'number', default: 10, description: 'Number of recent entries' },
          },
          required: ['agent_name'],
        },
      },
      // ── Subagent / files-touched / user-prompts / decision-record ──
      {
        name: 'recall_subagent_search',
        description: `Search inside hidden subagent conversations (Explore, aside_question, compact summaries).
Claude Code stores subagent work in <session-dir>/<session-id>/subagents/*.jsonl with no reference
from the parent JSONL. This tool reads those files and returns matching sessions + which subagents hit.

Especially useful for finding orphaned compacted history (kind: compact).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Substring to search for' },
            session_id: { type: 'string', description: 'Restrict to subagents of this session' },
            kind: { type: 'string', enum: ['explore', 'compact', 'aside', 'other'], description: 'Filter by subagent kind' },
            limit: { type: 'number', default: 20 },
          },
          required: ['query'],
        },
      },
      {
        name: 'recall_files_touched',
        description: `List sessions that touched a file path or pattern. Uses indexed session metadata
(filesModified) so it returns quickly without re-reading transcripts. Great for "which sessions
edited auth.rs in the last month?" — productivity recall.`,
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'File path or substring' },
            since_days: { type: 'number', default: 30 },
            limit: { type: 'number', default: 20 },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'recall_user_prompts',
        description: `List the human-typed prompts from a session (or recent sessions). Tool results
and system banners are stripped — you get only what the user actually wrote. Useful for "what was
I asking yesterday?" or "what did I tell the agent in this session?".`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'If set, only that session\'s prompts' },
            since_days: { type: 'number', default: 7 },
            limit: { type: 'number', default: 50 },
          },
        },
      },
      {
        name: 'recall_decision_record',
        description: `Record an explicit decision so it shows up in wake-up context. Writes a KG triple
(subject → decided → decision) plus a diary entry. Use this when you and the user agree on
something non-obvious that future sessions should remember.`,
        inputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'What the decision is about' },
            decision: { type: 'string', description: 'The decision itself' },
            reason: { type: 'string', description: 'Why this was decided' },
            importance: { type: 'number', minimum: 1, maximum: 5, default: 4 },
            session_id: { type: 'string' },
            agent_name: { type: 'string', default: 'agent' },
          },
          required: ['subject', 'decision'],
        },
      },
      {
        name: 'recall_analytics_summary',
        description: `Cross-tool spend & activity overview. Returns total sessions, total cost,
weekly delta, top tools/projects/models, and how many sessions had unknown pricing
(Gemini/Ollama/custom). Same data as the web Dashboard, available to the agent so it
can answer "how much have I spent this week" without you opening the UI.`,
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'recall_wake_up',
        description: `Build startup context for an AI session: identity blurb + the top
classifier-flagged facts (decisions/preferences/milestones at importance >=4) +
current knowledge-graph facts. Replaces a manual context dump. Call this once at
the start of a session to "remember who you are and what's true right now".`,
        inputSchema: {
          type: 'object',
          properties: {
            max_facts: { type: 'number', default: 10 },
            max_kg_facts: { type: 'number', default: 15 },
            identity: { type: 'string' },
          },
        },
      },
      {
        name: 'recall_similar_sessions',
        description: `Find past sessions semantically similar to a query (or to another session).
Use this when the user asks for something that "feels familiar" — chat-recall will surface earlier
work on the same topic, grouped by project so you can see "you've done this 5 times across 3 projects".
With an embedder configured this is real semantic clustering; without one it falls back to FTS5 keyword
match (still useful, just less fuzzy).

Pair with codeindex's find_symbol/search to also check whether matching code already exists.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you\'re about to do' },
            session_id: { type: 'string', description: 'Or compare against an existing session' },
            top_k: { type: 'number', default: 5 },
            project_filter: { type: 'string' },
          },
        },
      },
      {
        name: 'recall_session_files',
        description: `List the files a session created, edited, or read — pulled from the session's
indexed metadata (extra_json.filesModified) plus per-message tool_calls. Use to answer
"which files did session X actually touch?" without scanning the transcript.`,
        inputSchema: {
          type: 'object',
          properties: { session_id: { type: 'string' } },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_redundant_files',
        description: `Filename-level redundancy detector — call this before creating a new file.
Searches the indexed filesModified history of all past sessions in the project for filenames
similar to the one you're about to create. Surfaces "you (or a past session) already touched
src/lib/validators.ts" so the agent can read it before redoing work.

For *content*-level redundancy (semantic match against existing code), call codeindex's
find_symbol or search instead. The two checks compose: chat-recall sees what's been touched,
codeindex sees what currently exists.`,
        inputSchema: {
          type: 'object',
          properties: {
            filename:     { type: 'string', description: 'Path or basename you\'re about to create' },
            project_path: { type: 'string', description: 'Project to search in' },
            limit:        { type: 'number', default: 5 },
          },
          required: ['filename'],
        },
      },
      {
        name: 'recall_set',
        description: `Persist a small key/value pair across sessions. Use this for
state that doesn't fit the diary (narrative) or knowledge graph (entity-relationship facts) —
things like "current PR url", "branch I'm working on", "user's preferred test runner".
Scope namespaces keys so per-project state doesn't collide.`,
        inputSchema: {
          type: 'object',
          properties: {
            key:   { type: 'string', description: 'Key name' },
            value: { type: 'string', description: 'Value to store. JSON-encode if structured.' },
            scope: { type: 'string', default: 'default', description: 'Namespace' },
          },
          required: ['key', 'value'],
        },
      },
      {
        name: 'recall_get',
        description: `Read a key/value pair previously written with recall_set.`,
        inputSchema: {
          type: 'object',
          properties: {
            key:   { type: 'string' },
            scope: { type: 'string', default: 'default' },
          },
          required: ['key'],
        },
      },
      {
        name: 'recall_help',
        description: `Catalog of recall options grouped by intent.

Call this first when you need to remember something but aren't sure which recall_*
tool fits. Returns the full menu of available tools, what each one is for, and
which one to reach for in common situations (resume work, search past sessions,
inspect a session, see recent edits, query the knowledge graph, etc.).

No arguments — just call it.`,
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'recall_kv_list',
        description: `List keys in a scope (or across all scopes). Useful for the agent to
discover what state has been recorded without remembering specific keys.`,
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string', description: 'Filter by scope. Omit for all.' },
            limit: { type: 'number', default: 50 },
          },
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'recall_search': {
        const params = RecallSearchSchema.parse(args);

        // Sanitize query to prevent prompt injection
        const sanitized = sanitizeQuery(params.query);
        const searchQuery = sanitized.cleanQuery;

        // Remote scope: query the synced chat-recall server (cross-device /
        // team history). Falls back to a clear error rather than silently
        // searching local — the user asked for the server view specifically.
        if (params.scope === 'server') {
          const remote = await remotePost<{ results: Array<{ sessionId: string; score: number; projectPath: string; firstPrompt: string; summary?: string; matchedChunks?: Array<{ chunkType: string; text: string }> }>; count: number }>(
            '/api/search', { query: searchQuery, topK: params.top_k, projectFilter: params.project_filter },
          );
          if (!remote.results?.length) {
            return { content: [{ type: 'text', text: `No matching sessions on the server for "${params.query}".` }] };
          }
          const lines = [`# Server results for: "${params.query}"`, '_(synced history across your devices)_', ''];
          for (let i = 0; i < remote.results.length; i++) {
            const r = remote.results[i];
            const title = (r.firstPrompt || '(no prompt)').replace(/\n/g, ' ').slice(0, 100);
            lines.push(`## #${i + 1}: ${title}`);
            lines.push(`**Project:** ${r.projectPath || '(hashed)'}  ·  **Session:** \`${r.sessionId}\``);
            if (r.summary) lines.push(`**Summary:** ${r.summary.slice(0, 300)}`);
            const snippet = r.matchedChunks?.[0]?.text?.replace(/\n/g, ' ').slice(0, 240);
            if (snippet) lines.push(`> ${snippet}`);
            lines.push('');
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // Use provided param, env var, or default to ollama (local)
        const provider = (params.provider || process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider;

        let embedder: Awaited<ReturnType<typeof getEmbedder>> | null;
        try {
          embedder = getEmbedder(provider);
        } catch {
          // No embedder available — will use FTS5 fallback
          embedder = null;
        }

        let results;
        try {
          const searchTopK = params.skip_ranking ? params.top_k : params.top_k * 4;
          const memoryIndex = await createVectorStore(embedder);
          const memResults = await memoryIndex.search(searchQuery, {
            topK: searchTopK,
            sourceTypes: ['session'],
            projectIdFilter: params.project_filter,
          });
          // Transform MemorySearchResult to the legacy format used below
          const cache = await createMetadataCache();
          const cachedList = await Promise.all(memResults.map(r => cache.get(r.itemId)));
          results = memResults.map((r, i) => {
            const cached = cachedList[i];
            return {
              sessionId: r.itemId,
              score: r.score,
              chunkType: r.matchedChunks[0]?.chunkType || 'unknown',
              text: r.matchedChunks[0]?.text || r.title,
              projectPath: r.projectPath,
              created: '',
              modified: '',
              firstPrompt: cached?.firstPrompt || r.title,
              summary: cached?.summary,
              matchedChunks: r.matchedChunks,
            };
          });
          await cache.close();
        } catch (err) {
          if (err instanceof Error && err.message.includes('not found')) {
            return { content: [{ type: 'text', text: 'Error: Index not found. Run \'chat-recall memory index\' first.' }] };
          }
          throw err;
        }
        
        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No matching sessions found.' }] };
        }

        // Truncate results
        const displayResults = results.slice(0, params.top_k);

        // Score normalization: BM25 ranks and vector L2 distances live in
        // wildly different absolute ranges, so `score * 100` rounded to 0/100
        // for vectors. We tier within *this* result set instead — see
        // `core/score-tier.ts` for the rationale.
        const topScore = displayResults[0]?.score ?? 0;

        // Format results with rich context
        const lines = [`# Results for: "${params.query}"\n`];

        for (let i = 0; i < displayResults.length; i++) {
          const result = displayResults[i];

          let projectPath = result.projectPath;
          if (projectPath.length > 50) {
            projectPath = '...' + projectPath.slice(-47);
          }

          // Title from first prompt
          let title = result.firstPrompt.replace(/\n/g, ' ').trim();
          if (title.length > 100) {
            title = title.slice(0, 100) + '...';
          }

          lines.push(`## #${i + 1}: ${title}`);
          lines.push(`**Project:** ${projectPath}`);
          lines.push(`**Created:** ${result.created.slice(0, 10)} | **Match:** ${tierFor(result.score, topScore)} (#${i + 1} of ${displayResults.length})`);
          lines.push(`**Resume:** \`claude --resume ${result.sessionId}\``);

          // Show summary if available
          if (result.summary) {
            lines.push('');
            lines.push('**Summary:**');
            let summary = result.summary;
            if (summary.length > 500) {
              summary = summary.slice(0, 500) + '...';
            }
            lines.push(summary);
          }

          // Show matched context (what was discussed/decided)
          if (result.matchedChunks && result.matchedChunks.length > 0) {
            lines.push('');
            lines.push('**Relevant Context:**');
            for (const chunk of result.matchedChunks.slice(0, 2)) {
              const chunkLabel = chunk.chunkType === 'assistant' ? 'Claude said' :
                                 chunk.chunkType === 'user_context' ? 'User asked' :
                                 chunk.chunkType === 'tool_result' ? 'Tool output' :
                                 chunk.chunkType === 'web_search' ? 'Web search' :
                                 chunk.chunkType;
              let text = chunk.text.replace(/\n/g, ' ').trim();
              if (text.length > 300) {
                text = text.slice(0, 300) + '...';
              }
              if (chunk.chunkType !== 'summary') { // Don't repeat summary
                lines.push(`- *${chunkLabel}:* ${text}`);
              }
            }
          }

          lines.push('');
          lines.push('---');
          lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      
      case 'recall_index': {
        const params = RecallIndexSchema.parse(args);
        const wal = getWAL();
        wal.log('index', { force: params.force, provider: params.provider });
        const provider = (params.provider || process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider;

        let embedder: Awaited<ReturnType<typeof getEmbedder>> | null;
        try {
          embedder = getEmbedder(provider);
        } catch {
          // No embedder — index FTS5 only
          embedder = null;
        }

        // Use unified memory indexing with all source types
        const memoryIndex = await createVectorStore(embedder);
        const store = await createStore();
        const registry = new SourceRegistry();
        registry.register(new SessionSource());
        registry.register(new PlanSource());
        registry.register(new TaskSource());
        registry.register(new ClaudeMdSource());
        registry.register(new HistorySource());
        registry.register(new PasteSource());
        registry.register(new GeminiSessionSource());
        registry.register(new GeminiBrainSource());
        registry.register(new OpenCodeSource());
        registry.register(new OpenCodeTodoSource());
        registry.register(new CodexSessionSource());
        registry.register(new DiarySource());
        registry.register(new SkillsSource());
        registry.register(new McpsSource());
        registry.register(new SlashCommandsSource());
        registry.register(new SubagentsSource());
        registry.register(new HooksSource());
        registry.register(new PluginsSource());

        // Open KG for entity extraction during indexing
        const kg = await createKnowledgeGraph();
        let totalItems = 0, totalChunks = 0, totalErrors = 0, totalKGTriples = 0;
        for (const sourceType of registry.getRegisteredTypes()) {
          const sources = registry.getAll(sourceType);
          if (sources.length === 0) continue;
          for (const source of sources) {
          for await (const item of source.discover()) {
            try {
              if (!params.force && !(await memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime))) continue;
              await memoryIndex.deleteItem(item.sourceType, item.id);
              const chunks = await source.parse(item);
              // Classify chunks and enrich chunkType with memory type + importance
              for (const chunk of chunks) {
                const classification = classifyChunk(chunk.text);
                if (classification.memoryType !== 'general') {
                  chunk.chunkType = `${chunk.chunkType}:${classification.memoryType}:imp${classification.importance}`;
                }
                // Auto-extract entities into KG
                totalKGTriples += await extractAndPopulateKG(kg, chunk.text, {
                  projectPath: item.projectPath,
                  sourceType: item.sourceType,
                  sessionId: item.id,
                });
              }
              if (chunks.length > 0) {
                await memoryIndex.bufferChunks(chunks);
                totalChunks += chunks.length;
              }
              await store.setItem(item);
              const links = await source.extractLinks(item);
              if (links.length > 0) await store.addLinks(links);
              totalItems++;
            } catch { totalErrors++; }
          }
          }
        }
        await memoryIndex.flushBuffer();
        await kg.close();
        // Note: optimize() removed from auto flows — run `chat-recall optimize` manually
        await store.close();

        return {
          content: [{
            type: 'text',
            text: `Indexing complete!\nItems processed: ${totalItems}\nChunks indexed: ${totalChunks}\nKG triples extracted: ${totalKGTriples}\nErrors: ${totalErrors}`,
          }],
        };
      }
      
      case 'recall_status': {
        requireRemote();
        // Two cheap server reads: /api/status (chunks + per-project session
        // counts) and /api/status/sync (the trust-panel coverage: synced
        // sessions, raw archives, freshness). Local index-path / vector
        // fields don't exist server-side and are dropped.
        const status = await remoteGet<{ totalChunks: number; totalSessions: number; projects: Record<string, number> }>('/api/status');
        const sync = await remoteGet<{ sessions: number; sourceTypes: Record<string, number>; rawArchived: number; newestSessionAgeMs: number | null }>('/api/status/sync');

        const lines = [
          'Chat-Recall Server Status',
          `Synced sessions: ${sync.sessions}`,
          `FTS5 chunks: ${status.totalChunks}`,
          `Raw archives: ${sync.rawArchived}`,
        ];
        if (sync.newestSessionAgeMs !== null) {
          const mins = Math.round(sync.newestSessionAgeMs / 60000);
          lines.push(`Freshness: newest synced session ${mins} min ago`);
        }

        const types = Object.entries(sync.sourceTypes).filter(([, n]) => Number(n) > 0);
        if (types.length > 0) {
          lines.push('\nBy source type:');
          for (const [type, n] of types) {
            lines.push(`  ${type}: ${n} items`);
          }
        }

        const projects = Object.entries(status.projects || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
        if (projects.length > 0) {
          lines.push('\nTop projects:');
          for (const [proj, n] of projects) {
            lines.push(`  ${proj}: ${n} sessions`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      
      case 'recall_show': {
        const params = RecallShowSchema.parse(args);

        // Server holds the full message list (rebuilt from synced chunks in
        // server mode, parsed transcript in local mode). limit=0 = whole
        // session; the server's `content` field is already display text.
        const soft = await remoteGetSoft<{ sessionId: string; messages: Array<{ line: number; role: string; content: string }>; total: number }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}`, { limit: 0 });
        if (!soft.data || soft.data.messages.length === 0) {
          return { content: [{ type: 'text', text: soft.message || `Session not found: ${params.session_id}` }] };
        }
        const messagesList = soft.data.messages;

        // Filter messages
        let displayMessages = messagesList;

        if (params.from_end !== undefined) {
          // Last N messages — no line-number guessing required.
          const n = Math.max(1, Math.min(params.from_end, messagesList.length));
          displayMessages = messagesList.slice(-n);
        } else if (params.around_line) {
          const window = Math.floor(params.max_messages / 2);
          const filtered = messagesList.filter(msg => Math.abs(msg.line - params.around_line!) <= window * 10);
          if (filtered.length > 0) {
            displayMessages = filtered.slice(0, params.max_messages);
          } else {
            displayMessages = messagesList.filter(msg => msg.line <= params.around_line! + 50).slice(-params.max_messages);
          }
        } else {
          displayMessages = messagesList.slice(0, params.max_messages);
        }

        // Format output. Per-message truncation grows when code blocks are
        // requested — diffs/SQL routinely overshoot 1500 chars.
        const truncAt = params.include_code ? 8000 : 1500;
        const output = [`Session: ${params.session_id}`];
        const lastMsg = messagesList[messagesList.length - 1];
        output.push(`Total messages: ${messagesList.length} (max line: ${lastMsg ? lastMsg.line : 0})`);
        if (params.from_end !== undefined) {
          output.push(`Showing last ${displayMessages.length} message(s).`);
        } else if (params.around_line) {
          output.push(`Showing ${displayMessages.length} around line ${params.around_line}.`);
        }
        output.push('');

        for (const msg of displayMessages) {
          output.push(`**${msg.role}** (line ${msg.line})`);
          let text = msg.content;
          if (text.length > truncAt) {
            text = text.slice(0, truncAt) + '...';
          }
          output.push(text);
          output.push('');
        }

        output.push(`Resume: claude --resume ${params.session_id}`);

        return { content: [{ type: 'text', text: output.join('\n') }] };
      }

      case 'recall_recent': {
        const params = RecallRecentSchema.parse(args);

        if (params.scope === 'server') {
          const qs = new URLSearchParams({ limit: String(params.limit) });
          if (params.since_hours) qs.set('since_hours', String(params.since_hours));
          const remote = await remoteGet<{ sessions: Array<{ sessionId: string; projectPath: string; modified: string; firstPrompt: string; summary?: string; tool?: string }>; total: number }>(
            `/api/conversations/recent?${qs.toString()}`,
          );
          if (!remote.sessions?.length) {
            return { content: [{ type: 'text', text: 'No sessions on the server yet — run `chat-recall sync` on your machines.' }] };
          }
          const lines = [`# Recent sessions (server — ${remote.total} total synced)\n`];
          for (let i = 0; i < remote.sessions.length; i++) {
            const s = remote.sessions[i];
            const display = (s.summary || s.firstPrompt || '(no prompt)').replace(/\n/g, ' ').slice(0, 120);
            lines.push(`## #${i + 1}: ${display}`);
            lines.push(`**Tool:** ${s.tool || 'claude'}  ·  **Project:** ${s.projectPath || '(hashed)'}  ·  **Modified:** ${(s.modified || '').slice(0, 16).replace('T', ' ')}`);
            lines.push(`**Session ID:** \`${s.sessionId}\``);
            lines.push('');
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // When since_hours is set, pull a wider pool first and time-filter
        // before applying the limit — otherwise a small limit could miss
        // sessions inside the window that happen to be older than the top-N.
        const pool = params.since_hours !== undefined
          ? getRecentSessions(params.project_filter, Math.max(params.limit, 200))
          : getRecentSessions(params.project_filter, params.limit);

        let sessions = pool;
        if (params.since_hours !== undefined) {
          const cutoff = Date.now() - params.since_hours * 3600 * 1000;
          sessions = pool.filter(s => s.mtime >= cutoff).slice(0, params.limit);
        }

        if (sessions.length === 0) {
          const window = params.since_hours !== undefined
            ? ` in the last ${params.since_hours}h`
            : '';
          return { content: [{ type: 'text', text: `No recent sessions found${window}.` }] };
        }

        // Get summaries from metadata cache
        const metaCache = await createMetadataCache();

        const lines = ['# Recent Sessions\n'];

        if (params.project_filter) {
          lines.push(`Filtered by: "${params.project_filter}"\n`);
        }

        try {
          for (let i = 0; i < sessions.length; i++) {
            const session = sessions[i];

            let projectPath = session.projectPath;
            if (projectPath.length > 50) {
              projectPath = '...' + projectPath.slice(-47);
            }

            // Try to get Gemini summary
            const row = await metaCache.get(session.sessionId);

            let displayText: string;
            if (row && row.summary) {
              // Show first 150 chars of Gemini summary
              displayText = row.summary.length > 150 ? row.summary.substring(0, 150) + '...' : row.summary;
            } else {
              // Fallback to first prompt
              displayText = session.firstPrompt.replace(/\n/g, ' ').trim();
              if (displayText.length > 80) {
                displayText = displayText.substring(0, 80) + '...';
              }
              if (!displayText) {
                displayText = '(no prompt captured)';
              }
            }

            const modified = session.modified ? session.modified.slice(0, 16).replace('T', ' ') : 'unknown';

            lines.push(`## #${i + 1}: ${displayText}`);
            lines.push(`**Project:** ${projectPath}`);
            lines.push(`**Modified:** ${modified}`);
            lines.push(`**Messages:** ${session.messageCount || 'unknown'}`);
            lines.push(`**Session ID:** \`${session.sessionId}\``);
            lines.push(`**Resume:** \`claude --resume ${session.sessionId}\``);
            if (row && row.summary) {
              lines.push(`**Full Summary:** Use \`recall_summary\` for complete Gemini summary`);
            }
            lines.push('');
          }
        } finally {
          await metaCache.close();
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_context': {
        const params = RecallContextSchema.parse(args);

        // Server-backed: the message list + session metadata are enough to
        // rebuild the ConversationContext dump. Live-FS-only bits
        // (liveScanModifiedFiles) don't exist server-side — filesModified
        // comes from the metadata telemetry instead.
        const convo = await remoteGetSoft<{ sessionId: string; messages: Array<{ line: number; role: string; content: string }>; total: number }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}`, { limit: 0 });
        if (!convo.data || convo.data.messages.length === 0) {
          return { content: [{ type: 'text', text: convo.message || `Session not found: ${params.session_id}` }] };
        }

        interface SessionMeta {
          tool: string; slug: string; durationMs: number; messageCount: number;
          filesModified: string[]; modelsUsed: string[]; toolsUsed: string[];
          inputTokens: number; outputTokens: number; cacheReadTokens: number; peakContextTokens: number;
          contentPreview: string;
        }
        let meta: SessionMeta | null = null;
        try {
          const m = await remoteGetSoft<SessionMeta>(`/api/conversations/${encodeURIComponent(params.session_id)}/metadata`);
          meta = m.data;
        } catch { /* metadata optional */ }

        // Decisions come from the synced structured outcome (not a live scan).
        let decisions: string[] = [];
        try {
          const o = await remoteGetSoft<{ decisions?: Array<{ text: string }> }>(`/api/conversations/${encodeURIComponent(params.session_id)}/outcome`);
          if (o.data?.decisions) decisions = o.data.decisions.map(d => d.text);
        } catch { /* outcome optional */ }

        const userInputs: string[] = [];
        const assistantWork: string[] = [];
        for (const msg of convo.data.messages) {
          const clipped = msg.content.length > 240 ? msg.content.slice(0, 240) + '…' : msg.content;
          if (msg.role === 'user') {
            userInputs.push(clipped.replace(/\n/g, ' '));
          } else {
            assistantWork.push(clipped.replace(/\n/g, ' '));
          }
        }

        let formatted = formatContext({
          sessionId: params.session_id,
          projectPath: '',
          created: '',
          modified: '',
          userInputs: userInputs.slice(0, 50),
          claudeWork: assistantWork.slice(0, 20),
          decisions,
          toolsUsed: meta?.toolsUsed ?? [],
          filesChanged: meta?.filesModified ?? [],
        });

        // Append token/cost metadata from the server's session telemetry.
        // Tools without comparable per-session counters report inputTokens=0,
        // so the section is skipped silently for them.
        if (meta && meta.inputTokens > 0) {
          const lines: string[] = ['## Context Budget'];
          if (meta.slug) lines.push(`Session: ${meta.slug}`);
          if (meta.durationMs > 0) {
            const mins = Math.round(meta.durationMs / 60000);
            lines.push(`Duration: ~${mins} min | ${meta.messageCount} messages`);
          }
          lines.push(`Input: ${(meta.inputTokens / 1_000_000).toFixed(1)}M tokens | Output: ${(meta.outputTokens / 1000).toFixed(1)}k tokens`);
          lines.push(`Cache reads: ${(meta.cacheReadTokens / 1_000_000).toFixed(1)}M | Peak context: ${(meta.peakContextTokens / 1000).toFixed(0)}k`);
          if (meta.filesModified.length > 0) {
            lines.push(`Files modified: ${meta.filesModified.length}`);
          }
          if (meta.modelsUsed.length > 0) {
            lines.push(`Models: ${meta.modelsUsed.filter(x => x !== '<synthetic>').join(', ')}`);
          }
          formatted += '\n\n' + lines.join('\n');
        }

        // Optional: append an in-order message dump (server doesn't expose the
        // tool_use/tool_result granularity, so this is a user/assistant view).
        if (params.include_turns) {
          const lines: string[] = ['', '## Turn-by-turn'];
          for (const msg of convo.data.messages.slice(0, params.turns_limit)) {
            const role = msg.role === 'user' ? 'user' : 'assistant';
            const trimmed = msg.content.length > 400 ? msg.content.slice(0, 400) + '…' : msg.content;
            lines.push(`- **${role}** — ${trimmed.replace(/\n/g, ' ')}`);
          }
          formatted += '\n' + lines.join('\n');
        }

        return { content: [{ type: 'text', text: formatted }] };
      }

      case 'recall_summary': {
        const params = RecallSummarySchema.parse(args);

        // Server-backed: the structured outcome (status, decisions, blockers,
        // claim/reaction, prompt markers) plus the free-form AI summary, both
        // synced and served from the store. The AI narrative comes from the
        // metadata endpoint (`summary`, populated when the session's machine
        // shipped a generated summary); the structured part from /outcome.
        const aiSummary = await remoteGetSoft<{ summary?: string }>(`/api/conversations/${encodeURIComponent(params.session_id)}/metadata`)
          .then(r => r.data?.summary?.trim() || '')
          .catch(() => '');
        type Outcome = {
          found?: boolean; status: string; reason: string;
          fileCount: number; totalLinesAdded: number; totalLinesRemoved: number;
          commits: { totalCommits: number; repos: Array<{ repoName: string; commits: unknown[] }> };
          decisions: Array<{ text: string }>;
          blockers: Array<{ kind: string; text: string }>;
          claimReaction: { claim?: { text: string }; reaction?: { text: string; markers: string[] } };
          promptMarkers: { total: number; frustrated?: number; correction?: number; interrupt?: number; approval?: number; directive?: number; question?: number };
        };
        const soft = await remoteGetSoft<Outcome>(`/api/conversations/${encodeURIComponent(params.session_id)}/outcome`);
        if (!soft.data) {
          return { content: [{ type: 'text', text: soft.message || (soft.status === 404 ? `Session not found: ${params.session_id}` : `Summary not synced yet for ${params.session_id}.`) }] };
        }
        const outcome = soft.data;

        const statusEmoji =
          outcome.status === 'shipped' ? '🚢' :
          outcome.status === 'interrupted' ? '⏸' :
          outcome.status === 'abandoned' ? '🪦' :
          outcome.status === 'in_progress' ? '🟡' : '❔';

        // Legacy short mode: the AI summary if we have one, else the headline.
        if (!params.rich) {
          return { content: [{ type: 'text', text: [
            `# 📋 Summary`,
            '',
            `**Session:** ${params.session_id.substring(0, 8)}...`,
            aiSummary ? `\n${aiSummary}\n` : `**Status:** ${statusEmoji} ${outcome.status} — ${outcome.reason}`,
            '',
            '---',
            '',
            `**🔄 Resume:** \`claude --resume ${params.session_id}\``,
          ].join('\n') }] };
        }

        const lines: string[] = [];
        lines.push(`# 📋 Summary — ${params.session_id.substring(0, 8)}…`);
        lines.push('');
        if (aiSummary) { lines.push(aiSummary); lines.push(''); }

        // Status header line — most useful single signal.
        lines.push(`**Status:** ${statusEmoji} ${outcome.status} — ${outcome.reason}`);
        if (outcome.fileCount > 0) {
          lines.push(`**Edits:** ${outcome.fileCount} file(s) · +${outcome.totalLinesAdded} / −${outcome.totalLinesRemoved} lines`);
        }
        if (outcome.commits.totalCommits > 0) {
          const repoNames = outcome.commits.repos.map(r => `${r.repoName} (${r.commits.length})`).join(', ');
          lines.push(`**Commits:** ${outcome.commits.totalCommits} across ${outcome.commits.repos.length} repo(s) — ${repoNames}`);
        }
        lines.push('');

        if (outcome.decisions.length > 0) {
          lines.push('## Decisions');
          for (const d of outcome.decisions.slice(0, 8)) {
            lines.push(`- ${d.text}`);
          }
          lines.push('');
        }
        if (outcome.blockers.length > 0) {
          lines.push('## Blockers');
          for (const b of outcome.blockers.slice(0, 8)) {
            const tag = b.kind === 'tool_error' ? '⚠ tool error' : b.kind === 'interrupt' ? '⏸ interrupt' : '⚠';
            lines.push(`- ${tag}: ${b.text}`);
          }
          lines.push('');
        }
        if (outcome.claimReaction.claim) {
          lines.push('## Last claim vs user reaction');
          lines.push(`- **claim:** ${outcome.claimReaction.claim.text.slice(0, 240)}`);
          if (outcome.claimReaction.reaction) {
            const r = outcome.claimReaction.reaction;
            const markers = r.markers.length ? ` _[${r.markers.join(', ')}]_` : '';
            lines.push(`- **reaction:** ${r.text.slice(0, 240)}${markers}`);
          } else {
            lines.push(`- **reaction:** _(no follow-up — session ended on this claim)_`);
          }
          lines.push('');
        }
        if (outcome.promptMarkers.total > 0) {
          const m = outcome.promptMarkers;
          const parts: string[] = [];
          if (m.frustrated) parts.push(`⚠ ${m.frustrated} frustrated`);
          if (m.correction) parts.push(`↩ ${m.correction} correction`);
          if (m.interrupt) parts.push(`⏸ ${m.interrupt} interrupt`);
          if (m.approval) parts.push(`✓ ${m.approval} approval`);
          if (m.directive) parts.push(`▸ ${m.directive} directive`);
          if (m.question) parts.push(`? ${m.question} question`);
          if (parts.length) {
            lines.push('## Prompt markers');
            lines.push(parts.join(' · '));
            lines.push('');
          }
        }

        lines.push('---');
        lines.push('');
        lines.push(`**🔄 Resume:** \`claude --resume ${params.session_id}\``);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_diff': {
        const params = RecallDiffSchema.parse(args);
        const soft = await remoteGetSoft<{ totalLinesAdded: number; totalLinesRemoved: number; files: Array<{ file: string; diff: string; linesAdded: number; linesRemoved: number; reverted: boolean; succeededEvents: number; failedEvents: number; initialKnown: boolean; events: unknown[] }> }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}/diff`, { file: params.file });
        if (!soft.data) {
          return { content: [{ type: 'text', text: soft.message || (soft.status === 404 ? `Session not found: ${params.session_id}` : `Diff not synced yet for ${params.session_id}.`) }] };
        }
        const result = soft.data;
        const files = result.files;
        if (files.length === 0) {
          return { content: [{ type: 'text', text: `No edits found${params.file ? ` for file ${params.file}` : ''} in session ${params.session_id}.` }] };
        }
        const lines: string[] = [];
        lines.push(`# 🧾 Diff — ${params.session_id.substring(0, 8)}…`);
        lines.push(`Total: ${files.length} file(s) · +${result.totalLinesAdded} / −${result.totalLinesRemoved} lines`);
        lines.push('');
        for (const f of files) {
          const flags: string[] = [];
          if (f.reverted) flags.push('🔁 reverted');
          if (!f.initialKnown) flags.push('⚠ initial content unknown');
          if (f.failedEvents > 0) flags.push(`✗ ${f.failedEvents} failed`);
          lines.push(`## \`${f.file}\``);
          lines.push(`+${f.linesAdded} / −${f.linesRemoved} · ${f.events.length} event(s) · ${f.succeededEvents} succeeded${flags.length ? ' · ' + flags.join(' · ') : ''}`);
          if (!params.context_only && f.diff) {
            const diff = f.diff.length > params.max_diff_chars
              ? f.diff.slice(0, params.max_diff_chars) + '\n…(truncated)'
              : f.diff;
            lines.push('');
            lines.push('```diff');
            lines.push(diff);
            lines.push('```');
          }
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_commits': {
        const params = RecallCommitsSchema.parse(args);
        const soft = await remoteGetSoft<{ totalCommits: number; repos: Array<{ repoName: string; commits: Array<{ shortSha: string; authorIso: string; subject: string; matchedSessionFiles: string[]; linesAdded: number; linesRemoved: number; files: unknown[] }> }> }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}/commits`, { buffer_minutes: params.buffer_minutes });
        if (!soft.data) {
          return { content: [{ type: 'text', text: soft.message || (soft.status === 404 ? `Session not found: ${params.session_id}` : `Commits not synced yet for ${params.session_id}.`) }] };
        }
        const result = soft.data;
        if (result.totalCommits === 0) {
          return { content: [{ type: 'text', text: `No commits in window for ${params.session_id} across ${result.repos.length} repo(s).\n\n_Edits stayed local or window was off — try increasing buffer_minutes._` }] };
        }
        const lines: string[] = [];
        lines.push(`# 🔖 Commits — ${params.session_id.substring(0, 8)}…`);
        lines.push(`${result.totalCommits} commit(s) across ${result.repos.length} repo(s) within window`);
        lines.push('');
        for (const r of result.repos) {
          lines.push(`## ${r.repoName} (${r.commits.length})`);
          for (const c of r.commits) {
            lines.push(`- \`${c.shortSha}\` ${c.authorIso.slice(0, 16).replace('T', ' ')} — ${c.subject}`);
            if (c.matchedSessionFiles.length > 0) {
              lines.push(`  _matches ${c.matchedSessionFiles.length} session file(s)_`);
            }
            lines.push(`  +${c.linesAdded} / −${c.linesRemoved} · ${c.files.length} file(s)`);
          }
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_outcome': {
        const params = RecallOutcomeSchema.parse(args);
        const soft = await remoteGetSoft<{ status: string; reason: string; startMs?: number; endMs?: number; fileCount: number; totalLinesAdded: number; totalLinesRemoved: number; commits: { totalCommits: number; repos: Array<{ repoName: string; commits: unknown[] }> }; decisions: Array<{ text: string }>; blockers: Array<{ kind: string; text: string }>; claimReaction: { claim?: { text: string }; reaction?: { text: string; markers: string[] } } }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}/outcome`);
        if (!soft.data) {
          return { content: [{ type: 'text', text: soft.message || (soft.status === 404 ? `Session not found: ${params.session_id}` : `Outcome not synced yet for ${params.session_id}.`) }] };
        }
        const o = soft.data;
        const statusEmoji =
          o.status === 'shipped' ? '🚢' :
          o.status === 'interrupted' ? '⏸' :
          o.status === 'abandoned' ? '🪦' :
          o.status === 'in_progress' ? '🟡' : '❔';
        const lines: string[] = [];
        lines.push(`# ${statusEmoji} Outcome — ${o.status}`);
        lines.push(`**Session:** ${params.session_id.substring(0, 8)}…`);
        lines.push(`**Reason:** ${o.reason}`);
        if (o.startMs && o.endMs) {
          const mins = Math.round((o.endMs - o.startMs) / 60000);
          lines.push(`**Window:** ${new Date(o.startMs).toISOString().slice(0, 16).replace('T', ' ')} → ${new Date(o.endMs).toISOString().slice(0, 16).replace('T', ' ')} (${mins} min)`);
        }
        lines.push(`**Edits:** ${o.fileCount} file(s) · +${o.totalLinesAdded} / −${o.totalLinesRemoved} lines`);
        if (o.commits.totalCommits > 0) {
          lines.push(`**Commits:** ${o.commits.totalCommits} (${o.commits.repos.map(r => `${r.repoName}:${r.commits.length}`).join(', ')})`);
        }
        if (o.decisions.length) {
          lines.push('');
          lines.push('## Decisions');
          for (const d of o.decisions.slice(0, 10)) lines.push(`- ${d.text}`);
        }
        if (o.blockers.length) {
          lines.push('');
          lines.push('## Blockers');
          for (const b of o.blockers.slice(0, 10)) lines.push(`- _${b.kind}_: ${b.text}`);
        }
        if (o.claimReaction.claim) {
          lines.push('');
          lines.push('## Final claim vs reaction');
          lines.push(`- **claim:** ${o.claimReaction.claim.text.slice(0, 240)}`);
          if (o.claimReaction.reaction) {
            const r = o.claimReaction.reaction;
            const m = r.markers.length ? ` _[${r.markers.join(', ')}]_` : '';
            lines.push(`- **reaction:** ${r.text.slice(0, 240)}${m}`);
          } else {
            lines.push(`- **reaction:** _none — session ended on this claim_`);
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_markers': {
        const params = RecallMarkersSchema.parse(args);
        type MarkerPrompt = { ts?: number; tsIso?: string; line: number; markers: string[]; text: string };
        type MarkerSummary = { total: number; peakIntensity: number; frustrated?: number; correction?: number; interrupt?: number; approval?: number; directive?: number; question?: number; clarification_request?: number };
        const soft = await remoteGetSoft<{ prompts: MarkerPrompt[]; summary: MarkerSummary }>(
          `/api/conversations/${encodeURIComponent(params.session_id)}/markers`);
        if (!soft.data) {
          return { content: [{ type: 'text', text: soft.message || (soft.status === 404 ? `Session not found: ${params.session_id}` : `Markers not synced yet for ${params.session_id}.`) }] };
        }
        const prompts = soft.data.prompts.slice(0, params.limit);
        const summary = soft.data.summary;
        const lines: string[] = [];
        lines.push(`# 🎚 Prompt markers — ${params.session_id.substring(0, 8)}…`);
        lines.push(`${summary.total} prompt(s) · peak intensity ${summary.peakIntensity.toFixed(2)}`);
        const tally: string[] = [];
        if (summary.frustrated) tally.push(`⚠ ${summary.frustrated} frustrated`);
        if (summary.correction) tally.push(`↩ ${summary.correction} correction`);
        if (summary.interrupt) tally.push(`⏸ ${summary.interrupt} interrupt`);
        if (summary.approval) tally.push(`✓ ${summary.approval} approval`);
        if (summary.directive) tally.push(`▸ ${summary.directive} directive`);
        if (summary.question) tally.push(`? ${summary.question} question`);
        if (summary.clarification_request) tally.push(`◇ ${summary.clarification_request} clarify`);
        if (tally.length) lines.push(tally.join(' · '));
        lines.push('');
        for (const p of prompts) {
          const stamp = p.tsIso ? p.tsIso.slice(11, 19) : '';
          const tags = p.markers.length ? ` _[${p.markers.join(', ')}]_` : '';
          const snippet = p.text.length > 180 ? p.text.slice(0, 180) + '…' : p.text;
          lines.push(`- ${stamp} L${p.line}${tags}`);
          lines.push(`  ${snippet.replace(/\n/g, ' ')}`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_suggest_resume': {
        const params = RecallSuggestResumeSchema.parse(args);

        // Server-backed: POST /api/search (FTS) using the current task text as
        // the query — a keyword degrade of the local vector match (noted in the
        // header). Per-result outcome one-liners come from the synced
        // /outcome endpoint (best-effort; skipped when not synced yet).
        const cleaned = sanitizeQuery(params.current_task).cleanQuery;
        type SearchResp = {
          results: Array<{ sessionId: string; score: number; projectPath: string; summary?: string; firstPrompt?: string; text?: string }>;
        };
        const search = await remotePost<SearchResp>('/api/search', {
          query: cleaned,
          topK: params.top_k,
        });
        const results = search.results || [];

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No relevant past conversations found.' }] };
        }

        const output = [
          `# Suggested Conversations to Resume`,
          `Based on: "${params.current_task}"`,
          '_Keyword (FTS) match against the synced server index._',
          '',
        ];

        // Outcome shape (subset) — same endpoint recall_outcome consumes.
        type Outcome = { status: string; reason: string; fileCount: number; totalLinesAdded: number; totalLinesRemoved: number };
        const statusEmoji = (s: string) =>
          s === 'shipped' ? '🚢' : s === 'interrupted' ? '⏸' : s === 'abandoned' ? '🪦' : s === 'in_progress' ? '🟡' : '❔';

        for (let i = 0; i < results.length; i++) {
          const result = results[i];

          output.push(`## ${i + 1}. Session ${result.sessionId.substring(0, 8)}...`);
          output.push(`**Project:** ${(result.projectPath || '').replace(homedir(), '~')}`);
          output.push(`**Relevance:** ${(result.score * 100).toFixed(1)}%`);
          output.push('');

          if (result.summary) {
            const shortSummary = result.summary.length > 300 ? result.summary.substring(0, 300) + '...' : result.summary;
            output.push(shortSummary);
          } else {
            output.push((result.text || result.firstPrompt || '').substring(0, 200) + '...');
          }

          // Outcome one-liner — status tells you at a glance whether resuming
          // this session is worth it. Best-effort: skip on 202/404.
          try {
            const soft = await remoteGetSoft<Outcome>(`/api/conversations/${encodeURIComponent(result.sessionId)}/outcome`);
            if (soft.data) {
              const o = soft.data;
              output.push(`**Outcome:** ${statusEmoji(o.status)} ${o.status} — ${o.reason} · ${o.fileCount} file(s) +${o.totalLinesAdded}/−${o.totalLinesRemoved}`);
            }
          } catch { /* outcome best-effort */ }

          output.push('');
          output.push(`**Resume:** \`claude --resume ${result.sessionId}\``);
          output.push('');
        }

        return { content: [{ type: 'text', text: output.join('\n') }] };
      }

      case 'recall_memory_search': {
        const params = RecallMemorySearchSchema.parse(args);

        // Sanitize query to prevent prompt injection
        const sanitizedMem = sanitizeQuery(params.query);
        const memSearchQuery = sanitizedMem.cleanQuery;

        if (params.scope === 'server') {
          const remote = await remotePost<{ results: Array<{ itemId: string; sourceType: string; title: string; text: string; score: number; projectPath?: string }>; count: number }>(
            '/api/memory/search', { query: memSearchQuery, topK: params.top_k, sourceTypes: params.source_types, projectIdFilter: params.project_filter },
          );
          if (!remote.results?.length) {
            return { content: [{ type: 'text', text: `No server-side matches for "${params.query}".` }] };
          }
          const lines = [`# Server memory search: "${params.query}"`, '_(synced history across your devices)_', ''];
          for (let i = 0; i < remote.results.length; i++) {
            const r = remote.results[i];
            lines.push(`## #${i + 1} [${r.sourceType}] ${(r.title || r.itemId).slice(0, 90)}`);
            if (r.projectPath) lines.push(`**Project:** ${r.projectPath}`);
            lines.push((r.text || '').replace(/\n/g, ' ').slice(0, 300));
            lines.push('');
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const provider = (params.provider || process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider;

        let embedder: Awaited<ReturnType<typeof getEmbedder>> | null;
        try {
          embedder = getEmbedder(provider);
        } catch {
          embedder = null;
        }

        const memoryIndex = await createVectorStore(embedder);
        const results = await memoryIndex.search(memSearchQuery, {
          topK: params.top_k,
          sourceTypes: params.source_types as SourceType[] | undefined,
          projectIdFilter: params.project_filter,
        });

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No matching results found across any memory type.' }] };
        }

        const lines = [`# Memory Search: "${params.query}"\n`];

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const scorePct = Math.round(r.score * 100);

          lines.push(`## #${i + 1} [${r.sourceType}] ${r.title}`);
          if (r.projectPath) {
            let pp = r.projectPath;
            if (pp.length > 50) pp = '...' + pp.slice(-47);
            lines.push(`**Project:** ${pp}`);
          }
          lines.push(`**Score:** ${scorePct}/100 | **Type:** ${r.chunkType}`);

          let text = r.text.replace(/\n/g, ' ').trim();
          if (text.length > 400) text = text.slice(0, 400) + '...';
          lines.push('');
          lines.push(text);

          if (r.sourceType === 'session') {
            lines.push(`\n**Resume:** \`claude --resume ${r.itemId}\``);
          }

          lines.push('\n---\n');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_memory_status': {
        requireRemote();
        // Server's aggregate memory stats. Vector/index-path fields are
        // local-only and dropped; FTS5 chunk count and per-(source,tool)
        // breakdown come straight from the server.
        const status = await remoteGet<{
          totalChunks: number;
          totalItems: number;
          linkCount: number;
          bySourceType: Record<string, { items: number; chunks: number }>;
          bySourceAndTool: Record<string, Record<string, number>>;
        }>('/api/memory/status');

        const lines = [
          '# Memory System Status\n',
          `Total items: ${status.totalItems}`,
          `FTS5 chunks: ${status.totalChunks}`,
          `Total links: ${status.linkCount}`,
          '',
        ];

        const bySource = Object.entries(status.bySourceType || {});
        if (bySource.length > 0) {
          lines.push('**By source type:**');
          for (const [type, data] of bySource) {
            lines.push(`- ${type}: ${data.items} items, ${data.chunks} chunks`);
          }
          lines.push('');
        }

        const byTool = Object.entries(status.bySourceAndTool || {});
        if (byTool.length > 0) {
          lines.push('**By source type and tool:**');
          for (const [type, tools] of byTool) {
            const parts = Object.entries(tools).map(([t, n]) => `${t}: ${n}`).join(', ');
            lines.push(`- ${type}: ${parts}`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_plans': {
        const params = RecallPlansSchema.parse(args);
        requireRemote();
        const { items } = await remoteGetQS<{ items: Array<{ id: string; title: string; mtime: number; content_preview: string }> }>(
          '/api/memory/browse/plan', { limit: params.limit });

        if (items.length === 0) {
          return { content: [{ type: 'text', text: 'No plans synced yet.' }] };
        }

        const lines = [`# Plans (${items.length})\n`];
        for (const item of items) {
          const date = new Date(item.mtime).toISOString().slice(0, 10);
          lines.push(`- **${item.title}** (${date})`);
          if (item.content_preview) lines.push(`  ${item.content_preview.slice(0, 120)}...`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_plan_show': {
        const params = RecallPlanShowSchema.parse(args);
        const filePath = join(claudeBackend.plansDir(), `${params.plan_id}.md`);

        if (!existsSync(filePath)) {
          return { content: [{ type: 'text', text: `Plan not found: ${params.plan_id}` }] };
        }

        const content = readFileSync(filePath, 'utf-8');
        return { content: [{ type: 'text', text: content }] };
      }

      case 'recall_tasks': {
        const params = RecallTasksSchema.parse(args);
        requireRemote();
        const { items } = await remoteGetQS<{ items: Array<{ id: string; title: string; extra_json: string }> }>(
          '/api/memory/browse/task', { limit: params.limit });

        if (items.length === 0) {
          return { content: [{ type: 'text', text: 'No tasks synced yet.' }] };
        }

        const lines = [`# Task Groups (${items.length})\n`];
        for (const item of items) {
          const extra = JSON.parse(item.extra_json || '{}');
          const taskCount = extra.taskCount || '?';
          const completedCount = extra.completedCount || 0;
          lines.push(`## Session ${item.id.slice(0, 8)}...`);
          lines.push(`**Tasks:** ${completedCount}/${taskCount} completed`);
          lines.push(`**Subjects:** ${item.title}`);
          lines.push(`**Resume:** \`claude --resume ${item.id.replace(/^[a-z]+_/, '')}\``);
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_smart_resume': {
        const params = RecallSmartResumeSchema.parse(args);

        // Find the session file (Claude only — gemini/opencode/codex take
        // the memory_metadata fallback below).
        let sessionFileSR: string | null = null;
        let projectPathSR = '';

        if (detectTool(params.session_id) === 'claude') {
          const located = claudeBackend.findSession(params.session_id);
          if (located) {
            sessionFileSR = located.path;
            projectPathSR = located.projectPath;
          }
        }

        // Fallback: session may be a Gemini or OpenCode item indexed in the
        // memory store rather than a Claude .jsonl on disk. Return a minimal
        // resume dossier built from memory_metadata + cached summary so the
        // tool is useful across all three backends.
        if (!sessionFileSR) {
          const fbStore = await createStore();
          try {
            // Accept either raw id ("<uuid>") or any backend's prefixed
            // form. Driven off the registry so a new tool added later
            // works automatically.
            const seen = new Set<string>([params.session_id]);
            const candidates: string[] = [params.session_id];
            for (const b of listAvailableBackends()) {
              const candidate = b.toPrefixedId(params.session_id);
              if (!seen.has(candidate)) { candidates.push(candidate); seen.add(candidate); }
            }
            let item: any = null;
            for (const id of candidates) {
              item = await fbStore.getItem(id, 'session' as SourceType);
              if (item) break;
            }
            if (!item) {
              return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
            }
            let extra: any = {};
            try { extra = JSON.parse(item.extra_json || '{}'); } catch {}
            const metaCacheFB = await (await import('@chat-recall/engine/core/store/caches.js')).createMetadataCache();
            const mFB = await metaCacheFB.get(item.id);
            await metaCacheFB.close();
            const row = mFB ? { summary: mFB.summary, first_prompt: mFB.firstPrompt } : undefined;
            const lines: string[] = [];
            lines.push(`# Resume — ${item.title || item.id}`);
            lines.push(`Tool: ${extra.tool || 'unknown'}   Project: ${item.project_path || '(unknown)'}`);
            if (row?.summary) {
              lines.push('');
              lines.push('## Summary');
              lines.push(row.summary);
            } else {
              lines.push('');
              lines.push('(No AI summary yet — run `npm run generate-summaries` to produce one.)');
            }
            if (row?.first_prompt || item.content_preview) {
              lines.push('');
              lines.push('## First prompt');
              lines.push(row?.first_prompt || item.content_preview);
            }
            return { content: [{ type: 'text', text: lines.join('\n') }] };
          } finally {
            await fbStore.close();
          }
        }

        // Parse the session for structured resume data
        const sessionContent = await parseSessionFile(sessionFileSR);
        const meta = sessionContent.metadata;

        // Get summary
        const metaCacheSR = await (await import('@chat-recall/engine/core/store/caches.js')).createMetadataCache();
        const summaryRow = await metaCacheSR.get(params.session_id);
        await metaCacheSR.close();

        // Get tasks for this session
        const storeSR = await createStore();
        const taskLinks = await storeSR.getLinksTo('session' as SourceType, params.session_id);
        const taskItems: Array<{ title: string; completed: number; total: number; subjects: string[] }> = [];
        for (const link of taskLinks) {
          if (link.source_type === 'task') {
            const taskMeta = await storeSR.getItem(link.source_id, 'task' as SourceType);
            if (taskMeta) {
              const extra = JSON.parse(taskMeta.extra_json || '{}');
              taskItems.push({
                title: taskMeta.title,
                completed: extra.completedCount || 0,
                total: extra.taskCount || 0,
                subjects: (extra.subjects as string[]) || [],
              });
            }
          }
        }
        await storeSR.close();

        // Extract context
        const context = extractConversationContext(sessionFileSR);

        // Build output
        const lines: string[] = [];
        const slug = meta.slug || params.session_id.slice(0, 8);
        const projName = projectPathSR.split('/').pop() || projectPathSR;
        const durationMin = meta.durationMs > 0 ? Math.round(meta.durationMs / 60000) : 0;
        const peakK = Math.round(meta.peakContextTokens / 1000);
        const peakPct = Math.round(meta.peakContextTokens / 200000 * 100); // Assume 200k context

        lines.push(`# Resume: ${slug}`);
        lines.push(`**Project:** ${projName} | **Duration:** ${durationMin}min | **Messages:** ${meta.messageCount}`);
        lines.push('');

        // Summary
        if (summaryRow?.summary) {
          lines.push('## What Happened');
          lines.push(summaryRow.summary);
          lines.push('');
        }

        // Outcome status — uses the same heuristic as `recall_outcome` so
        // smart_resume and outcome agree on whether work shipped. Replaces
        // the older `context.claudeWork` extraction which surfaced raw
        // assistant fragments ("Let me check what's done…") as if they were
        // milestones.
        let outcomeStatus: string | null = null;
        try {
          const outcome = computeOutcome(params.session_id);
          if (outcome.found) {
            outcomeStatus = `${statusEmoji(outcome.status)} **${outcome.status}** — ${outcome.reason}`;
            lines.push('## Outcome');
            lines.push(outcomeOneLiner(outcome));
            lines.push('');

            if (outcome.decisions.length > 0) {
              lines.push('## Decisions');
              for (const d of outcome.decisions.slice(0, 8)) {
                lines.push(`- ${d.text.slice(0, 200)}`);
              }
              lines.push('');
            }

            if (outcome.blockers.length > 0) {
              lines.push('## Blockers');
              for (const b of outcome.blockers.slice(0, 6)) {
                lines.push(`- _${b.kind}_: ${b.text.slice(0, 200)}`);
              }
              lines.push('');
            }

            if (outcome.claimReaction.claim) {
              lines.push('## Final claim vs reaction');
              lines.push(`- **claim:** ${outcome.claimReaction.claim.text.slice(0, 240)}`);
              if (outcome.claimReaction.reaction) {
                const r = outcome.claimReaction.reaction;
                const m = r.markers.length ? ` _[${r.markers.join(', ')}]_` : '';
                lines.push(`- **reaction:** ${r.text.slice(0, 240)}${m}`);
              } else {
                lines.push(`- **reaction:** _none — session ended on this claim_`);
              }
              lines.push('');
            }
          }
        } catch { /* outcome is best-effort; fall through to legacy fields */ }

        // Fall back to the older claudeWork extraction only when the outcome
        // classifier returned nothing usable — keeps legacy callers working.
        if (!outcomeStatus && context.claudeWork.length > 0) {
          lines.push('## Completed Work');
          for (const work of context.claudeWork.slice(0, 8)) {
            lines.push(`- ${work}`);
          }
          lines.push('');
        }

        // Known facts from knowledge graph about this project
        if (projName) {
          try {
            const kgResume = await createKnowledgeGraph();
            const projFacts = await kgResume.queryEntity(projName);
            const currentFacts = projFacts.filter(f => f.current);
            if (currentFacts.length > 0) {
              lines.push('## Known Facts (Knowledge Graph)');
              for (const fact of currentFacts.slice(0, 15)) {
                const arrow = fact.direction === 'outgoing' ? '→' : '←';
                lines.push(`- ${fact.subject} ${arrow} **${fact.predicate}** ${arrow} ${fact.object}`);
              }
              lines.push('');
            }
            await kgResume.close();
          } catch { /* KG not available, skip */ }
        }

        // What's pending (tasks, TODOs)
        const pendingItems: string[] = [];
        for (const task of taskItems) {
          const pending = task.total - task.completed;
          if (pending > 0) {
            pendingItems.push(`${task.title} (${task.completed}/${task.total} done)`);
          }
        }

        // Also scan for TODO/FIXME in assistant messages
        const sessionLines = readFileSync(sessionFileSR, 'utf-8').split('\n');
        const todoPattern = /(?:TODO|FIXME|HACK|PENDING|still need to|not yet|haven't|remaining)[:. ]+([^.!?\n]{10,100})/gi;
        const todos = new Set<string>();
        for (const line of sessionLines.slice(-200)) {
          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            if (obj.type === 'assistant') {
              const msg = obj.message as Record<string, unknown>;
              if (msg && Array.isArray(msg.content)) {
                for (const item of msg.content) {
                  if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text') {
                    const text = (item as Record<string, unknown>).text as string;
                    if (text) {
                      const matches = text.matchAll(todoPattern);
                      for (const match of matches) {
                        const todo = match[1].trim();
                        if (todo.length > 10) todos.add(todo);
                      }
                    }
                  }
                }
              }
            }
          } catch { /* skip */ }
        }
        for (const todo of todos) pendingItems.push(todo);

        if (pendingItems.length > 0) {
          lines.push('## Pending / Unfinished');
          for (const item of pendingItems.slice(0, 10)) {
            lines.push(`- ${item}`);
          }
          lines.push('');
        }

        // Files modified
        if (meta.filesModified.length > 0) {
          lines.push('## Files Modified');
          for (const f of meta.filesModified.slice(0, 15)) {
            lines.push(`- ${f}`);
          }
          lines.push('');
        }

        // Context budget
        lines.push('## Context Budget');
        lines.push(`Input: ${(meta.inputTokens / 1_000_000).toFixed(1)}M | Output: ${(meta.outputTokens / 1000).toFixed(0)}k | Peak: ${peakK}k`);
        if (meta.modelsUsed.length > 0) {
          lines.push(`Models: ${meta.modelsUsed.filter(m => m !== '<synthetic>').join(', ')}`);
        }
        if (peakPct > 80) {
          lines.push(`**Warning:** Session used ${peakPct}% of context window`);
        }
        lines.push('');

        // Git commits made during this session
        try {
          if (projectPathSR && existsSync(projectPathSR)) {
            const { execSync } = await import('child_process');
            // Find the session start/end times
            const firstLine = sessionLines[0];
            const lastLine = sessionLines[sessionLines.length - 1] || sessionLines[sessionLines.length - 2];
            let startTime = '', endTime = '';
            try {
              const first = JSON.parse(firstLine);
              const last = JSON.parse(lastLine || '{}');
              startTime = first.timestamp || '';
              endTime = last.timestamp || '';
            } catch { /* skip */ }

            if (startTime && endTime) {
              const gitLog = execSync(
                `git -C "${projectPathSR}" log --oneline --after="${startTime}" --before="${endTime}" 2>/dev/null`,
                { encoding: 'utf-8', timeout: 5000 }
              ).trim();
              if (gitLog) {
                const commitLines = gitLog.split('\n');
                lines.push('## Git Commits During Session');
                lines.push(`${commitLines.length} commits:`);
                lines.push('```');
                lines.push(gitLog);
                lines.push('```');
                lines.push('');
              }
            }
          }
        } catch { /* no git or not a repo */ }

        lines.push(`**Resume:** \`claude --resume ${params.session_id}\``);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_project_dossier': {
        const params = RecallProjectDossierSchema.parse(args);
        // Reject absolute paths and other non-id inputs. Resolving a path
        // here used to silently produce empty/orphan dossiers when the cwd
        // no longer existed (PR-bot worktrees, /tmp). Force the caller to
        // pass a stable identifier they got from `recall_project_context`
        // or the web sidebar.
        if (!/^(git:|git-local:|ws:|user:)/.test(params.project)) {
          return {
            content: [{
              type: 'text',
              text:
                `Invalid project id: \`${params.project}\`.\n\n` +
                `Use a project_id from \`recall_project_context\` or the web UI sidebar.\n` +
                `Examples:\n  - git:github.com/me/munbot\n  - ws:personal\n  - git-local:26ccc83b2b1b\n`,
            }],
            isError: true,
          };
        }
        const dossier = await remoteGetQS<{ project_id: string; markdown: string }>(
          `/api/projects/${encodeURIComponent(params.project)}/dossier`,
          { sessions: params.sessions, tasks: params.tasks, plans: params.plans },
        );
        return { content: [{ type: 'text', text: dossier.markdown }] };
      }

      case 'recall_project_context': {
        const params = RecallProjectContextSchema.parse(args);

        // Server-backed: the dossier route resolves a path/id into a
        // project_id (via the engine's resolveProjectId) and aggregates
        // everything the synced index knows — recent sessions w/ summaries,
        // cost/token rollup, open tasks, plans, and current knowledge-graph
        // facts (decisions + tech stack). That is the substance of the old
        // local project_context. Two of the old extras are intentionally NOT
        // reproduced because no server endpoint exposes them:
        //   - "Recent Git Commits": came from shelling out to `git log` on the
        //     local repo; the server has no checkout of the producer's repo.
        //   - "Related Work in Other Projects": a cross-project FTS sweep over
        //     the local index; the dossier endpoint is single-project scoped.
        const dossier = await remoteGetQS<{ project_id: string; markdown: string }>(
          `/api/projects/${encodeURIComponent(params.project_path)}/dossier`,
          { sessions: params.limit },
        );
        return { content: [{ type: 'text', text: dossier.markdown }] };
      }

      case 'recall_weekly_digest': {
        const params = RecallWeeklyDigestSchema.parse(args);
        requireRemote();

        // Server-backed digest off the same analytics aggregate the dashboard
        // renders. The server computes per-week (Sunday-start, UTC) trends; we
        // pick the requested week from `weeklyTrends` / `periodComparison`.
        // Project / model breakdowns aren't week-scoped server-side, so they
        // are shown as overall-fleet context (clearly labelled). KG stats and
        // open-task scans are local-only and dropped.
        type Analytics = {
          summary: { totalSessions: number; totalCostUsd: number; totalDurationMin: number; totalCacheReadTokens: number; totalInputTokens: number };
          projects: Array<{ name: string; sessions: number; totalCost: number; description?: string }>;
          models: Array<{ model: string; sessions: number }>;
          weeklyTrends: Array<{ week: string; cost: number; sessions: number; cacheRate: number }>;
          periodComparison: {
            thisWeek: { sessions: number; cost: number; cacheRate: number };
            lastWeek: { sessions: number; cost: number; cacheRate: number };
          };
        };
        const a = await remoteGet<Analytics>('/api/analytics');

        // Resolve which week the caller asked for. weeks_back 0/1 map directly
        // to periodComparison; older weeks come from the weeklyTrends series
        // (which is sorted ascending and capped at the last 12 weeks).
        const trendsDesc = [...(a.weeklyTrends || [])].reverse(); // newest first
        const weekLabel = params.weeks_back === 0
          ? 'This Week'
          : params.weeks_back === 1
            ? 'Last Week'
            : `${params.weeks_back} Weeks Ago`;

        let weekSessions = 0, weekCost = 0, weekCacheRate = 0, weekLabelDate = '';
        let prevSessions = 0, prevCost = 0;
        if (params.weeks_back === 0) {
          weekSessions = a.periodComparison.thisWeek.sessions;
          weekCost = a.periodComparison.thisWeek.cost;
          weekCacheRate = a.periodComparison.thisWeek.cacheRate;
          prevSessions = a.periodComparison.lastWeek.sessions;
          prevCost = a.periodComparison.lastWeek.cost;
          weekLabelDate = trendsDesc[0]?.week || '';
        } else if (params.weeks_back === 1) {
          weekSessions = a.periodComparison.lastWeek.sessions;
          weekCost = a.periodComparison.lastWeek.cost;
          weekCacheRate = a.periodComparison.lastWeek.cacheRate;
          const wk = trendsDesc[2];
          prevSessions = wk?.sessions || 0;
          prevCost = wk?.cost || 0;
          weekLabelDate = trendsDesc[1]?.week || '';
        } else {
          const wk = trendsDesc[params.weeks_back];
          const prev = trendsDesc[params.weeks_back + 1];
          weekSessions = wk?.sessions || 0;
          weekCost = wk?.cost || 0;
          weekCacheRate = wk?.cacheRate || 0;
          weekLabelDate = wk?.week || '';
          prevSessions = prev?.sessions || 0;
          prevCost = prev?.cost || 0;
        }

        const dateRange = weekLabelDate ? `week of ${weekLabelDate}` : '';
        const lines = [`# ${weekLabel}${dateRange ? `: ${dateRange}` : ''}\n`];

        if (weekSessions === 0 && weekCost === 0) {
          lines.push('No sessions found for this period.');
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // Overview
        lines.push(`**${weekSessions} sessions** · **$${weekCost.toFixed(0)}**`);
        if (weekCacheRate > 0) lines.push(`Cache hit rate: ${weekCacheRate}%`);
        lines.push('');

        // vs previous week
        const pctChange = prevCost > 0 ? Math.round(((weekCost - prevCost) / prevCost) * 100) : 0;
        const arrow = pctChange > 0 ? '+' : '';
        lines.push('## vs Previous Week\n');
        lines.push(`This period: ${weekSessions} sessions, $${weekCost.toFixed(0)}`);
        lines.push(`Prior period: ${prevSessions} sessions, $${prevCost.toFixed(0)}`);
        lines.push(`Change: ${arrow}${pctChange}%`);
        lines.push('');

        // Top projects (overall fleet — analytics doesn't expose per-week
        // project slices).
        if (a.projects.length > 0) {
          lines.push('## Top Projects (overall)\n');
          for (const p of a.projects.slice(0, 8)) {
            const desc = p.description ? ` — ${p.description.slice(0, 80)}` : '';
            lines.push(`**${p.name}** · ${p.sessions} sessions · $${p.totalCost.toFixed(0)}${desc}`);
          }
          lines.push('');
        }

        // Models used (overall)
        if (a.models.length > 0) {
          lines.push('## Models Used (overall)\n');
          for (const m of a.models) {
            const shortModel = m.model.replace(/^claude-/, '').replace(/^models\//, '');
            lines.push(`- ${shortModel}: ${m.sessions} sessions`);
          }
          lines.push('');
        }

        // Knowledge-graph snapshot (server-side) — re-added from the local digest.
        try {
          const kg = await remoteGet<{ entities: number; current_facts: number; relationship_types: string[] }>('/api/kg/stats');
          if (kg.entities > 0) {
            lines.push('## Knowledge Graph\n');
            lines.push(`${kg.entities} entities · ${kg.current_facts} current facts · ${kg.relationship_types.length} relationship types`);
            lines.push('');
          }
        } catch { /* kg optional */ }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── Knowledge Graph Handlers ─────────────────────────────────

      case 'recall_kg_query': {
        const params = RecallKGQuerySchema.parse(args);
        requireRemote();
        const { facts } = await remotePost<{ facts: Array<{ subject: string; predicate: string; object: string; direction: string; current: boolean; valid_from?: string; valid_to?: string }> }>(
          '/api/kg/query', { entity: params.entity, as_of: params.as_of, direction: params.direction });

        if (facts.length === 0) {
          return { content: [{ type: 'text', text: `No facts found for entity: "${params.entity}"${params.as_of ? ` as of ${params.as_of}` : ''}` }] };
        }

        const lines = [`# Knowledge Graph: "${params.entity}"${params.as_of ? ` (as of ${params.as_of})` : ''}\n`];
        lines.push(`**Facts:** ${facts.length} (${facts.filter(f => f.current).length} current)\n`);

        for (const fact of facts) {
          const arrow = fact.direction === 'outgoing' ? '→' : '←';
          const status = fact.current ? '' : ' [expired]';
          const validity = fact.valid_from ? ` (${fact.valid_from}${fact.valid_to ? ' → ' + fact.valid_to : ' → now'})` : '';
          lines.push(`- ${fact.subject} ${arrow} **${fact.predicate}** ${arrow} ${fact.object}${validity}${status}`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_kg_add': {
        const params = RecallKGAddSchema.parse(args);
        const wal = getWAL();
        wal.log('kg_add', { subject: params.subject, predicate: params.predicate, object: params.object, valid_from: params.valid_from });

        requireRemote();
        const { id: tripleId } = await remotePost<{ id: string }>('/api/kg/add', {
          subject: params.subject, predicate: params.predicate, object: params.object,
          valid_from: params.valid_from, source_session: params.source_session,
        });

        return { content: [{ type: 'text', text: `Added: ${params.subject} → ${params.predicate} → ${params.object} (id: ${tripleId})` }] };
      }

      case 'recall_kg_invalidate': {
        const params = RecallKGInvalidateSchema.parse(args);
        const wal = getWAL();
        wal.log('kg_invalidate', { subject: params.subject, predicate: params.predicate, object: params.object, ended: params.ended });

        requireRemote();
        const { invalidated: count } = await remotePost<{ invalidated: number }>('/api/kg/invalidate', {
          subject: params.subject, predicate: params.predicate, object: params.object, ended: params.ended,
        });

        const endDate = params.ended || new Date().toISOString().split('T')[0];
        return { content: [{ type: 'text', text: `Invalidated ${count} fact(s): ${params.subject} → ${params.predicate} → ${params.object} (ended: ${endDate})` }] };
      }

      case 'recall_kg_timeline': {
        const params = RecallKGTimelineSchema.parse(args);
        requireRemote();
        const { entries } = await remoteGetQS<{ entries: Array<{ subject: string; predicate: string; object: string; current: boolean; valid_from?: string }> }>(
          '/api/kg/timeline', { entity: params.entity, limit: params.limit });

        if (entries.length === 0) {
          return { content: [{ type: 'text', text: `No timeline entries found${params.entity ? ` for "${params.entity}"` : ''}.` }] };
        }

        const lines = [`# Timeline${params.entity ? `: ${params.entity}` : ''}\n`];
        for (const entry of entries) {
          const status = entry.current ? '' : ' [ended]';
          const from = entry.valid_from || '?';
          lines.push(`- **${from}** ${entry.subject} → ${entry.predicate} → ${entry.object}${status}`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_kg_stats': {
        requireRemote();
        const s = await remoteGet<{ entities: number; triples: number; current_facts: number; expired_facts: number; relationship_types: string[] }>('/api/kg/stats');

        const lines = [
          '# Knowledge Graph Stats\n',
          `**Entities:** ${s.entities}`,
          `**Triples:** ${s.triples} (${s.current_facts} current, ${s.expired_facts} expired)`,
          '',
          `**Relationship types:** ${s.relationship_types.length > 0 ? s.relationship_types.join(', ') : 'none yet'}`,
        ];

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── Diary Handlers ─────────────────────────────────────────

      case 'recall_diary_write': {
        const params = RecallDiaryWriteSchema.parse(args);
        const wal = getWAL();
        wal.log('diary_write', { agent: params.agent_name, topic: params.topic });

        requireRemote();
        const { id: entryId } = await remotePost<{ id: string }>('/api/diary/write', {
          agent_name: params.agent_name,
          topic: params.topic,
          entry: params.entry,
          session_id: params.session_id,
          project_path: params.project_path,
        });

        return { content: [{ type: 'text', text: `Diary entry saved: ${entryId}` }] };
      }

      case 'recall_diary_read': {
        const params = RecallDiaryReadSchema.parse(args);
        requireRemote();
        const { entries } = await remoteGetQS<{ entries: Array<{ timestamp?: string; topic: string; content: string }> }>(
          '/api/diary/read', { agent: params.agent_name, last_n: params.last_n });

        if (entries.length === 0) {
          return { content: [{ type: 'text', text: `No diary entries for agent "${params.agent_name}".` }] };
        }

        const lines = [`# Diary: ${params.agent_name} (${entries.length} entries)\n`];
        for (const entry of entries) {
          const date = entry.timestamp?.slice(0, 16).replace('T', ' ') || '?';
          lines.push(`## ${date} [${entry.topic}]`);
          lines.push(entry.content);
          lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── Subagent search ────────────────────────────────────────
      case 'recall_subagent_search': {
        // Subagents are a Claude-CLI-specific concept (the .jsonl-per-subtask
        // tree under <session>/subagents/), so this handler is intentionally
        // bound to ClaudeBackend.
        const params = RecallSubagentSearchSchema.parse(args);
        const { readdirSync: rd, readFileSync: rf, statSync: st } = await import('fs');
        const projectsRoot = claudeBackend.projectsDir();

        // Collect candidate session directories. If session_id given, narrow to that.
        const sessionDirs: string[] = [];
        try {
          for (const proj of rd(projectsRoot, { withFileTypes: true })) {
            if (!proj.isDirectory()) continue;
            const projPath = join(projectsRoot, proj.name);
            for (const entry of rd(projPath, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue;
              if (params.session_id && !entry.name.startsWith(params.session_id)) continue;
              const subDir = join(projPath, entry.name, 'subagents');
              if (existsSync(subDir)) sessionDirs.push(subDir);
            }
          }
        } catch { /* projects dir missing */ }

        const needle = params.query.toLowerCase();
        type Hit = { sessionDir: string; subagent: string; kind: string; lineHits: number; sample: string };
        const hits: Hit[] = [];

        for (const dir of sessionDirs) {
          let files: string[] = [];
          try { files = rd(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
          for (const f of files) {
            const id = f.replace(/\.jsonl$/i, '');
            const kind: string = id.includes('acompact')
              ? 'compact'
              : id.includes('aside_question')
                ? 'aside'
                : 'explore';
            if (params.kind && kind !== params.kind) continue;

            const filePath = join(dir, f);
            try {
              if (st(filePath).size > 50 * 1024 * 1024) continue; // skip files >50MB
              const text = rf(filePath, 'utf-8');
              const lower = text.toLowerCase();
              if (!lower.includes(needle)) continue;

              const lineHits = (lower.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
              const idx = lower.indexOf(needle);
              const sample = text.slice(Math.max(0, idx - 60), idx + 140).replace(/\s+/g, ' ').trim();
              hits.push({ sessionDir: dir, subagent: id, kind, lineHits, sample });
              if (hits.length >= params.limit) break;
            } catch { /* unreadable */ }
          }
          if (hits.length >= params.limit) break;
        }

        if (hits.length === 0) {
          return { content: [{ type: 'text', text: `No subagent matches for "${params.query}".` }] };
        }

        const lines = [`# Subagent search: "${params.query}" (${hits.length} hits)\n`];
        for (const h of hits) {
          const sessionId = h.sessionDir.split('/').slice(-2, -1)[0];
          lines.push(`- **${sessionId}** / ${h.subagent} [${h.kind}] (${h.lineHits} match${h.lineHits === 1 ? '' : 'es'})`);
          lines.push(`  …${h.sample}…`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── Files touched ──────────────────────────────────────────
      case 'recall_files_touched': {
        const params = RecallFilesTouchedSchema.parse(args);

        // Server-backed: /api/edits/timeline with a pattern filter returns the
        // edit rows (file/session/project/ts) across recent sessions, sourced
        // from synced diff rows (cache-first). We group them by session to get
        // the "which sessions touched files matching X" view. Edits are
        // returned newest-first and capped at 1000 server-side; for a normal
        // pattern that comfortably covers `limit` sessions.
        const sinceHours = params.since_days * 24;
        type Edit = { sessionId: string; projectPath: string; file: string; ts: number };
        type TimelineResp = { total: number; edits: Edit[] };
        const resp = await remoteGetQS<TimelineResp>('/api/edits/timeline', {
          since_hours: sinceHours,
          pattern: params.pattern,
          limit: 1000,
          include_reads: false,
        });

        type Match = { sessionId: string; project: string; mtime: number; matchedFiles: string[] };
        const matchesById = new Map<string, Match>();
        for (const e of resp.edits || []) {
          const existing = matchesById.get(e.sessionId);
          if (existing) {
            if (!existing.matchedFiles.includes(e.file)) existing.matchedFiles.push(e.file);
            if (e.ts > existing.mtime) existing.mtime = e.ts;
            continue;
          }
          matchesById.set(e.sessionId, {
            sessionId: e.sessionId,
            project: e.projectPath || '(unknown)',
            mtime: e.ts,
            matchedFiles: [e.file],
          });
        }

        const matches = [...matchesById.values()].sort((a, b) => b.mtime - a.mtime);
        const trimmed = matches.slice(0, params.limit);

        if (trimmed.length === 0) {
          return { content: [{ type: 'text', text: `No sessions in the last ${params.since_days} days touched files matching "${params.pattern}".` }] };
        }

        const lines = [`# Files touched: "${params.pattern}" (${matches.length} session${matches.length === 1 ? '' : 's'} in last ${params.since_days}d)\n`];
        for (const m of trimmed) {
          const date = new Date(m.mtime).toISOString().slice(0, 10);
          lines.push(`- **${m.sessionId}** ${date} — ${m.project}`);
          for (const f of m.matchedFiles.slice(0, 5)) lines.push(`  · ${f}`);
          if (m.matchedFiles.length > 5) lines.push(`  · …and ${m.matchedFiles.length - 5} more`);
        }
        return { content: [{ type: 'text', text: withCodeindexHint(lines.join('\n'), 'files') }] };
      }

      // ── Edits timeline (chronological tool_use list across recent sessions) ──
      case 'recall_edits_timeline': {
        const params = RecallEditsTimelineSchema.parse(args);

        // Server-backed: /api/edits/timeline runs the same cached/live edit
        // scan the Activity panel uses (cache-first from synced diff rows,
        // live-fallback only in local mode). It applies include_reads,
        // tool/project/pattern filters, the limit cap, and group_by_repo
        // tallies server-side, so we just format its response.
        type Edit = {
          ts: number; tsIso?: string; sessionId: string; projectPath: string;
          repoRoot: string | null; repoName: string | null; file: string;
          op: string; toolName: string; tool: string; line?: number;
        };
        type TimelineResp = {
          sinceHours: number; total: number; truncated: boolean;
          byTool: Record<string, number>;
          byProject: Record<string, number>;
          byRepo?: Record<string, { name: string; count: number; sample: string }>;
          edits: Edit[];
        };
        const resp = await remoteGetQS<TimelineResp>('/api/edits/timeline', {
          since_hours: params.since_hours,
          limit: params.limit,
          pattern: params.pattern,
          project: params.project_filter,
          include_reads: params.include_reads,
          tools: params.tools?.join(','),
          group_by_repo: params.group_by_repo,
        });

        if (resp.total === 0) {
          return {
            content: [{
              type: 'text',
              text: `No file edits in the last ${params.since_hours}h` +
                    (params.pattern ? ` matching "${params.pattern}"` : '') +
                    (params.project_filter ? ` in project "${params.project_filter}"` : '') + '.',
            }],
          };
        }

        // Header tool tally — comes straight off the server (computed over
        // the full filtered set, not just the returned page).
        const toolSummary = Object.entries(resp.byTool)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${n} ${k}`).join(' · ');

        const sid = (sessionId: string) =>
          (getBackendForId(sessionId)?.toRawId(sessionId) ?? sessionId).slice(0, 8);
        const fmtTs = (e: Edit) =>
          (e.tsIso || new Date(e.ts).toISOString()).replace('T', ' ').slice(0, 19);

        if (params.group_by_repo) {
          // The server returns the authoritative per-repo counts (over the full
          // filtered set) in `byRepo`; the actual edit rows are the returned
          // page (`edits`, already limit-capped server-side). Group the page by
          // repoRoot for the table bodies, fall back to byRepo counts for the
          // true per-repo totals.
          const byRepo = resp.byRepo || {};
          const rowsByRepo = new Map<string, Edit[]>();
          let unmatched = 0;
          for (const e of resp.edits) {
            if (!e.repoRoot) { unmatched++; continue; }
            if (!rowsByRepo.has(e.repoRoot)) rowsByRepo.set(e.repoRoot, []);
            rowsByRepo.get(e.repoRoot)!.push(e);
          }
          const repoOrder = Object.entries(byRepo)
            .sort((a, b) => b[1].count - a[1].count)
            .map(([repo]) => repo);
          // Include any repo present in the page but missing from byRepo (defensive).
          for (const repo of rowsByRepo.keys()) if (!repoOrder.includes(repo)) repoOrder.push(repo);

          const lines = [
            `# Edits timeline — last ${params.since_hours}h (${resp.total} edit${resp.total === 1 ? '' : 's'})`,
            `_${toolSummary}_`,
            `_${repoOrder.length} repo(s)${unmatched ? ` · ${unmatched} edit(s) outside any git repo` : ''}_`,
            '',
          ];
          for (const repo of repoOrder) {
            const repoName = byRepo[repo]?.name || repo.split('/').filter(Boolean).pop() || repo;
            const total = byRepo[repo]?.count ?? (rowsByRepo.get(repo)?.length ?? 0);
            const rows = rowsByRepo.get(repo) || [];
            lines.push(`## ${repoName}  \`${repo}\` — ${total} edit(s)`);
            lines.push('| Time (UTC) | Tool | Session | Op | File |');
            lines.push('|---|---|---|---|---|');
            for (const e of rows) {
              const rel = e.file.startsWith(repo + '/') ? e.file.slice(repo.length + 1) : e.file;
              lines.push(`| ${fmtTs(e)} | ${e.tool} | \`${sid(e.sessionId)}\` | ${e.op} | ${rel} |`);
            }
            if (total > rows.length) {
              lines.push('');
              lines.push(`…${total - rows.length} more in this repo (raise \`limit\`).`);
            }
            lines.push('');
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const lines = [
          `# Edits timeline — last ${params.since_hours}h (${resp.total} edit${resp.total === 1 ? '' : 's'})`,
          `_${toolSummary}_`,
          '',
          '| Time (UTC) | Tool | Session | Op | File | Project |',
          '|---|---|---|---|---|---|',
        ];
        for (const e of resp.edits) {
          lines.push(`| ${fmtTs(e)} | ${e.tool} | \`${sid(e.sessionId)}\` | ${e.op} | ${e.file} | ${e.projectPath} |`);
        }
        if (resp.total > resp.edits.length) {
          lines.push('');
          lines.push(`…${resp.total - resp.edits.length} more edits truncated (raise \`limit\`).`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── User prompts only ─────────────────────────────────────
      case 'recall_user_prompts': {
        const params = RecallUserPromptsSchema.parse(args);
        requireRemote();

        // There's no dedicated user-prompts endpoint server-side — the user
        // prompts are derived from the markers compute, which the session's
        // machine ships at sync time. Each prompt already carries its
        // sentiment `markers`, so `with_markers` is rendered from the server's
        // data (no local markPrompt re-run needed).
        type MarkerPrompt = { line: number; ts?: number; tsIso?: string; markers: string[]; text: string };
        type MarkersResp = { prompts: MarkerPrompt[]; summary: unknown };

        const renderPrompts = (rows: Array<{ sessionId: string; line: number; tsIso?: string; markers: string[]; text: string }>): string => {
          const lines = [`# User prompts (${rows.length})\n`];
          for (const p of rows) {
            const t = p.tsIso?.slice(0, 16).replace('T', ' ') || '';
            const snippet = p.text.length > 240 ? p.text.slice(0, 240) + '…' : p.text;
            const markerSuffix = params.with_markers && p.markers.length ? ` _[${p.markers.join(', ')}]_` : '';
            lines.push(`- **${p.sessionId}** L${p.line}${t ? ` · ${t}` : ''}${markerSuffix}`);
            lines.push(`  ${snippet.replace(/\n/g, ' ')}`);
          }
          return lines.join('\n');
        };

        // Single-session lookup — one markers call.
        if (params.session_id) {
          const soft = await remoteGetSoft<MarkersResp>(`/api/conversations/${encodeURIComponent(params.session_id)}/markers`);
          if (!soft.data) {
            return { content: [{ type: 'text', text: soft.message || (soft.status === 404 ? `Session ${params.session_id} not found.` : `Prompts not synced yet for ${params.session_id}.`) }] };
          }
          const rows = soft.data.prompts
            .filter(p => p.text && p.text.trim())
            .slice(0, params.limit)
            .map(p => ({ sessionId: params.session_id!, line: p.line, tsIso: p.tsIso, markers: p.markers || [], text: p.text }));
          if (rows.length === 0) {
            return { content: [{ type: 'text', text: 'No user prompts found.' }] };
          }
          return { content: [{ type: 'text', text: renderPrompts(rows) }] };
        }

        // Cross-session mode — pull the recent feed inside the time window,
        // then fan markers per session (newest first) until we hit the limit.
        const sinceHours = params.since_days * 24;
        const recent = await remoteGetQS<{ sessions: Array<{ sessionId: string }> }>(
          '/api/conversations/recent', { limit: 200, since_hours: sinceHours });
        const sessionIds = (recent.sessions || []).map(s => s.sessionId);
        if (sessionIds.length === 0) {
          return { content: [{ type: 'text', text: 'No user prompts found.' }] };
        }

        const collected: Array<{ sessionId: string; line: number; tsIso?: string; markers: string[]; text: string }> = [];
        for (const sid of sessionIds) {
          if (collected.length >= params.limit) break;
          const soft = await remoteGetSoft<MarkersResp>(`/api/conversations/${encodeURIComponent(sid)}/markers`);
          if (!soft.data) continue; // not synced yet / 404 — skip
          for (const p of soft.data.prompts) {
            if (!p.text || !p.text.trim()) continue;
            collected.push({ sessionId: sid, line: p.line, tsIso: p.tsIso, markers: p.markers || [], text: p.text });
            if (collected.length >= params.limit) break;
          }
        }

        if (collected.length === 0) {
          return { content: [{ type: 'text', text: 'No user prompts found (none of the recent sessions have synced markers yet).' }] };
        }
        return { content: [{ type: 'text', text: renderPrompts(collected) }] };
      }

      // ── Decision recording ────────────────────────────────────
      case 'recall_decision_record': {
        const params = RecallDecisionRecordSchema.parse(args);
        const wal = getWAL();
        wal.log('decision_record', { subject: params.subject, importance: params.importance });

        const confidence = Math.min(1, params.importance / 5);

        // 1) Knowledge-graph triple — durable, queryable, time-validated.
        // Server-backed via POST /api/kg/add (tenant-scoped on the server).
        await remotePost<{ id: string }>('/api/kg/add', {
          subject: params.subject,
          predicate: 'decided',
          object: params.decision,
          confidence,
          source_session: params.session_id,
        });
        if (params.reason) {
          await remotePost<{ id: string }>('/api/kg/add', {
            subject: params.subject,
            predicate: 'because',
            object: params.reason,
            confidence,
            source_session: params.session_id,
          });
        }

        // 2) Diary entry — readable narrative for the agent's own future reads.
        // Server-backed via POST /api/diary/write (stored as a synced diary
        // memory item, read back through recall_diary_read).
        const diaryText = params.reason
          ? `Decided: ${params.decision}\nSubject: ${params.subject}\nWhy: ${params.reason}`
          : `Decided: ${params.decision}\nSubject: ${params.subject}`;
        const diary = await remotePost<{ id: string }>('/api/diary/write', {
          agent_name: params.agent_name,
          topic: 'decision',
          entry: diaryText,
          session_id: params.session_id,
        });

        return {
          content: [{
            type: 'text',
            text: `Decision recorded.\n- KG: ${params.subject} → decided → ${params.decision}\n- Diary entry: ${diary.id} (importance ${params.importance})`,
          }],
        };
      }

      // ── Analytics summary ──────────────────────────────────────
      case 'recall_analytics_summary': {
        RecallAnalyticsSummarySchema.parse(args);
        requireRemote();

        // Same analytics aggregate the dashboard renders. The server already
        // computed all per-project / per-tool / per-model rollups (single
        // engine pricing source), so we just format its fields.
        type Analytics = {
          summary: { totalSessions: number; totalCostUsd: number; avgCostPerSession: number; sessionsWithoutPricing: number };
          projects: Array<{ name: string; sessions: number; totalCost: number }>;
          tools: Array<{ tool: string; sessions: number }>;
          models: Array<{ model: string; sessions: number }>;
          periodComparison: {
            thisWeek: { sessions: number; cost: number };
            lastWeek: { sessions: number; cost: number };
          };
        };
        const a = await remoteGet<Analytics>('/api/analytics');
        const s = a.summary;

        const topByCost = [...a.projects]
          .sort((x, y) => y.totalCost - x.totalCost).slice(0, 5)
          .map(p => `  ${p.name.padEnd(28)} $${p.totalCost.toFixed(2).padStart(8)}  (${p.sessions} sessions)`);
        const topTools = a.tools.slice(0, 5)
          .map(t => `  ${t.tool.padEnd(15)} ${t.sessions}`);
        const topModels = a.models.slice(0, 5)
          .map(m => `  ${m.model.padEnd(35)} ${m.sessions} sessions`);

        const weekNow = a.periodComparison.thisWeek.cost;
        const weekPrev = a.periodComparison.lastWeek.cost;
        const delta = weekPrev > 0 ? ((weekNow - weekPrev) / weekPrev) * 100 : null;
        const deltaStr = delta === null
          ? '(no prior-week data)'
          : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% vs last week`;

        const lines = [
          '# Analytics Summary',
          '',
          `**Total sessions:** ${s.totalSessions}`,
          `**Total cost (priced):** $${s.totalCostUsd.toFixed(2)}`,
          `**Avg / priced session:** $${s.avgCostPerSession.toFixed(2)}`,
          `**Sessions without pricing:** ${s.sessionsWithoutPricing} (Gemini / Ollama / custom — cost not estimated)`,
          '',
          `**This week:** $${weekNow.toFixed(2)} · ${deltaStr}`,
          '',
          '## Top projects by cost',
          ...(topByCost.length ? topByCost : ['  (none)']),
          '',
          '## Top tools used',
          ...(topTools.length ? topTools : ['  (none)']),
          '',
          '## Top models',
          ...(topModels.length ? topModels : ['  (none)']),
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── Similar sessions ───────────────────────────────────────
      case 'recall_similar_sessions': {
        const params = RecallSimilarSessionsSchema.parse(args);

        // Resolve search text: either the explicit query, or the source
        // session's first-prompt/preview pulled from its metadata on the
        // server (the synced session's content preview).
        let searchText = params.query ?? '';
        let excludeSessionId: string | undefined;
        if (params.session_id) {
          excludeSessionId = params.session_id;
          const meta = await remoteGetSoft<{ contentPreview?: string; slug?: string }>(
            `/api/conversations/${encodeURIComponent(params.session_id)}/metadata`);
          if (!meta.data) {
            return { content: [{ type: 'text', text: meta.message || (meta.status === 404 ? `Session not found: ${params.session_id}` : `Session ${params.session_id} not synced yet.`) }] };
          }
          searchText = meta.data.contentPreview || meta.data.slug || '';
        }
        if (!searchText.trim()) {
          return { content: [{ type: 'text', text: 'No search text could be derived. Provide `query` or a session_id with prompt content.' }] };
        }

        // Sanitize then search across sessions only. Server search is FTS —
        // a keyword degrade of the local vector clustering (noted below).
        const cleaned = sanitizeQuery(searchText).cleanQuery;
        type SearchResp = {
          results: Array<{ sessionId: string; score: number; projectPath: string; modified: string; title?: string; firstPrompt?: string; text?: string; matchedChunks?: Array<{ text: string }> }>;
        };
        const search = await remotePost<SearchResp>('/api/search', {
          query: cleaned,
          topK: params.top_k * 4,
          projectFilter: params.project_filter,
        });

        const filtered = (search.results || []).filter(r => r.sessionId !== excludeSessionId);
        const trimmed = filtered.slice(0, params.top_k);

        if (trimmed.length === 0) {
          return { content: [{ type: 'text', text: `No similar sessions found for "${cleaned.slice(0, 80)}".` }] };
        }

        // Group by project so the "5 projects, 3 of them did this" frame surfaces.
        const byProject = new Map<string, number>();
        for (const r of filtered) {
          const p = r.projectPath || '(unknown)';
          byProject.set(p, (byProject.get(p) || 0) + 1);
        }

        const lines = [
          `# Similar past work (${trimmed.length} session${trimmed.length === 1 ? '' : 's'} returned, ${filtered.length} total matches across ${byProject.size} project${byProject.size === 1 ? '' : 's'})`,
          '',
          '_Keyword (FTS) match against the synced server index — server search is keyword-based, not vector clustering._',
          '',
        ];
        for (const r of trimmed) {
          const date = (r.modified || '').slice(0, 10) || '?';
          const proj = (r.projectPath || '').split('/').slice(-2).join('/') || '(unknown)';
          const snippet = (r.matchedChunks?.[0]?.text || r.text || r.firstPrompt || r.title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
          lines.push(`- **${r.sessionId.slice(0, 8)}** · ${proj} · ${date} · score ${r.score.toFixed(3)}`);
          if (snippet) lines.push(`  ${snippet}…`);
        }

        if (byProject.size > 1) {
          lines.push('', '## Project distribution');
          const sortedProjects = [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
          for (const [proj, n] of sortedProjects) {
            const short = proj.split('/').slice(-2).join('/') || proj;
            lines.push(`- ${short} — ${n} session${n === 1 ? '' : 's'}`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── Session files ──────────────────────────────────────────
      case 'recall_session_files': {
        const params = RecallSessionFilesSchema.parse(args);

        // Server-backed: the per-session diff endpoint replays the session's
        // Edit/Write/MultiEdit/NotebookEdit tool calls into a per-file diff.
        // The set of modified files is `files[].file`; the tools used come from
        // each file's `events[].toolName`. Served from the synced compute cache
        // (202 "pending-sync" until the session's machine ships its diff).
        type DiffFile = { file: string; events?: Array<{ toolName: string }> };
        type DiffResp = { projectPath: string; files: DiffFile[] };
        const soft = await remoteGetSoft<DiffResp>(`/api/conversations/${encodeURIComponent(params.session_id)}/diff`);
        if (!soft.data) {
          return { content: [{ type: 'text', text: soft.message || (soft.status === 404 ? `Session not found: ${params.session_id}` : `Files not synced yet for ${params.session_id}.`) }] };
        }

        const projectPath = soft.data.projectPath || '';
        const files = soft.data.files.map(f => f.file);
        const tools = [...new Set(soft.data.files.flatMap(f => (f.events || []).map(e => e.toolName)))];

        if (files.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `Session ${params.session_id} exists but no file activity is recorded ` +
                    `(no Edit/Write/MultiEdit/NotebookEdit tool_uses found).`,
            }],
          };
        }

        // Bucket by extension to give the agent a quick "what kind of work was this".
        const byExt = new Map<string, string[]>();
        for (const f of files) {
          const ext = f.includes('.') ? f.split('.').pop()!.toLowerCase() : '(no ext)';
          if (!byExt.has(ext)) byExt.set(ext, []);
          byExt.get(ext)!.push(f);
        }

        const lines = [
          `# Files touched in session ${params.session_id.slice(0, 8)}`,
          '',
          `**Project:** ${projectPath || '(unknown)'}`,
          `**Files modified:** ${files.length}`,
          `**Tools used:** ${tools.join(', ') || '(none recorded)'}`,
          `**Source:** synced diff replay`,
          '',
          '## By extension',
        ];
        const sortedExts = [...byExt.entries()].sort((a, b) => b[1].length - a[1].length);
        for (const [ext, fs] of sortedExts) {
          lines.push(`### .${ext} (${fs.length})`);
          for (const f of fs.slice(0, 12)) lines.push(`- ${f}`);
          if (fs.length > 12) lines.push(`- …and ${fs.length - 12} more`);
        }

        return { content: [{ type: 'text', text: withCodeindexHint(lines.join('\n'), 'session') }] };
      }

      // ── Redundancy detection (filename-level) ──────────────────
      case 'recall_redundant_files': {
        const params = RecallRedundantFilesSchema.parse(args);
        const target = params.filename.trim();
        requireRemote();
        const { hits: ranked } = await remoteGetQS<{ hits: Array<{ file: string; sessionId: string; project: string; mtime: number; score: number; reason: string }> }>(
          '/api/files/redundant', { filename: target, project: params.project_path, limit: params.limit });

        if (ranked.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No similar filenames found in synced sessions for "${target}".\n\n` +
                    `For *code-level* redundancy (existing symbols/functions matching what you're about to write), ` +
                    `call codeindex's \`find_symbol\` or \`search\` against the same project.`,
            }],
          };
        }

        const lines = [
          `# Filename redundancy check: "${target}"`,
          '',
          `Found **${ranked.length}** similar file${ranked.length === 1 ? '' : 's'} touched by past sessions.`,
          params.project_path ? `Scoped to project: \`${params.project_path}\`` : '_Searched across all projects._',
          '',
        ];
        for (const h of ranked) {
          const date = new Date(h.mtime).toISOString().slice(0, 10);
          lines.push(`- **${h.file}**`);
          lines.push(`  ${h.reason} · session ${h.sessionId.slice(0, 8)} · ${h.project} · ${date} · score ${h.score.toFixed(2)}`);
        }
        lines.push('');
        lines.push('_Tip: read the matching file before creating new code that may duplicate it._');

        return { content: [{ type: 'text', text: withCodeindexHint(lines.join('\n'), 'redundancy') }] };
      }

      // ── KV store ───────────────────────────────────────────────
      case 'recall_set': {
        const params = RecallSetSchema.parse(args);
        const wal = getWAL();
        wal.log('kv_set', { scope: params.scope, key: params.key });

        requireRemote();
        await remotePost('/api/kv/set', { scope: params.scope, key: params.key, value: params.value });

        return { content: [{ type: 'text', text: `Set ${params.scope}:${params.key} (${params.value.length} chars)` }] };
      }

      case 'recall_get': {
        const params = RecallGetSchema.parse(args);
        requireRemote();
        const { entry: row } = await remoteGetQS<{ entry: { value: string; updated_at: number } | null }>(
          '/api/kv/get', { scope: params.scope, key: params.key });
        if (!row) return { content: [{ type: 'text', text: `(no value at ${params.scope}:${params.key})` }] };
        const ago = Math.floor((Date.now() - row.updated_at) / 1000);
        return {
          content: [{
            type: 'text',
            text: `${params.scope}:${params.key} (set ${ago}s ago)\n\n${row.value}`,
          }],
        };
      }

      case 'recall_kv_list': {
        const params = RecallKvListSchema.parse(args);
        requireRemote();
        const { entries: rows } = await remoteGetQS<{ entries: Array<{ scope: string; key: string; value: string; updated_at: number }> }>(
          '/api/kv/list', { scope: params.scope, limit: params.limit });
        if (rows.length === 0) {
          return {
            content: [{
              type: 'text',
              text: params.scope ? `No keys in scope "${params.scope}".` : 'No KV entries yet.',
            }],
          };
        }
        const lines = [`# KV entries (${rows.length})\n`];
        for (const r of rows) {
          const preview = r.value.length > 80 ? r.value.slice(0, 80) + '…' : r.value;
          const ago = Math.floor((Date.now() - r.updated_at) / 1000);
          lines.push(`- **${r.scope}:${r.key}** — ${preview}  _(${ago}s ago)_`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── Wake-up context ────────────────────────────────────────
      case 'recall_wake_up': {
        const params = RecallWakeUpSchema.parse(args);

        // Identity: param > file > default. The file lets users seed a stable
        // self-description that survives across sessions ("I'm Adi's coding agent…").
        let identity = params.identity ?? 'AI coding assistant';
        if (!params.identity) {
          const idFile = getIdentityFilePath();
          if (existsSync(idFile)) {
            try { identity = readFileSync(idFile, 'utf-8').trim() || identity; } catch {}
          }
        }

        const lines = [
          '# Wake-Up Context',
          '',
          '## Identity',
          identity,
          '',
        ];
        if (params.project_filter) {
          lines.push(`_Scoped to project filter: \`${params.project_filter}\`_`);
          lines.push('');
        }

        // High-importance facts (classifier-tagged) + current KG snapshot, both
        // computed server-side from the synced store (the collector has no local
        // index). Identity stays local above — it's a tiny per-machine file.
        requireRemote();
        const wake = await remoteGetQS<{
          highFacts: Array<{ type: string; text: string }>;
          kg: { stats: { entities?: number; current_facts?: number }; facts: Array<{ subject: string; predicate: string; object: string }> };
        }>('/api/memory/wake-up', {
          project_filter: params.project_filter, max_facts: params.max_facts, max_kg_facts: params.max_kg_facts,
        });

        if (wake.highFacts.length > 0) {
          lines.push('## High-importance facts');
          for (const c of wake.highFacts) lines.push(`  [${c.type}] ${c.text}`);
          lines.push('');
        } else if (params.project_filter) {
          lines.push('## High-importance facts');
          lines.push(`  _no classifier hits for project filter \`${params.project_filter}\`_`);
          lines.push('');
        }

        if (wake.kg.facts.length > 0) {
          lines.push('## Knowledge graph (current facts)');
          lines.push(`  ${wake.kg.stats.entities ?? 0} entities, ${wake.kg.stats.current_facts ?? 0} current facts`);
          for (const f of wake.kg.facts) lines.push(`  ${f.subject} → ${f.predicate} → ${f.object}`);
          lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_help': {
        const text = [
          '# chat-recall: how to recall',
          '',
          'Pick a tool by what you actually want to do. Most flows start with one of the first three.',
          '',
          '## I want to pick up where I left off',
          '- `recall_smart_resume` — structured resume bundle (completed work, pending items, files, budget, KG facts). Best default for "continue".',
          '- `recall_suggest_resume` — finds the most relevant past session for a free-text current task.',
          '- `recall_recent` — list latest sessions (optionally `project_filter`, `since_hours`). Use when you just want the list.',
          '- `recall_wake_up` — high-importance classifier facts + current KG snapshot. Fast cold-start identity/context.',
          '',
          '## I want to search past conversations',
          '- `recall_search` — semantic + FTS5 over sessions. Returns session IDs to drill into.',
          '- `recall_memory_search` — search across ALL memory types (sessions, plans, tasks, CLAUDE.md, paste, history, diary).',
          '- `recall_similar_sessions` — given a session id, find sessions like it.',
          '- `recall_subagent_search` — search subagent transcripts specifically.',
          '- `recall_user_prompts` — search what the user actually typed (not assistant output).',
          '',
          '## I want details on one specific session',
          '- `recall_context` — structured context dump for a session id.',
          '- `recall_summary` — AI-generated summary.',
          '- `recall_show` — raw conversation slice (`from_end: N`, `around_line`, `include_code`).',
          '- `recall_diff` — what files changed in that session.',
          '- `recall_commits` — git commits associated with the session window.',
          '- `recall_outcome` — success/failure/abandonment classification.',
          '- `recall_markers` — milestone/decision markers extracted from the session.',
          '- `recall_session_files` — files touched in a session.',
          '',
          '## I want to know what was changed recently',
          '- `recall_edits_timeline` — chronological file edits across Claude/Gemini/OpenCode/Codex. Try `since_hours: 2`.',
          '- `recall_files_touched` — aggregate file activity over a window.',
          '- `recall_redundant_files` — detect about-to-create-duplicate before writing a new file.',
          '',
          '## Project-level context',
          '- `recall_project_context` — rich dump for a project (sessions, tasks, plans, commits, cost, KG).',
          '- `recall_weekly_digest` — weekly activity digest.',
          '- `recall_analytics_summary` — token/cost/tool analytics.',
          '- `recall_plans` / `recall_plan_show` — list and inspect plans.',
          '- `recall_tasks` — list tasks (optionally per session).',
          '',
          '## Temporal knowledge graph (facts with validity windows)',
          '- `recall_kg_query` — query entity relationships (`as_of` for time-travel).',
          '- `recall_kg_timeline` — chronological facts.',
          '- `recall_kg_stats` — graph overview.',
          '- `recall_kg_add` — assert a new fact triple.',
          '- `recall_kg_invalidate` — mark a fact no longer true.',
          '',
          '## Persistent agent notes',
          '- `recall_diary_write` / `recall_diary_read` — per-agent diary across sessions.',
          '- `recall_decision_record` — record an architectural decision.',
          '- `recall_set` / `recall_get` / `recall_kv_list` — scoped KV store for arbitrary state.',
          '',
          '## Index management',
          '- `recall_index` — re-index sources (incremental by default; `force: true` for full).',
          '- `recall_status` — index stats (counts by source type, FTS5/vector).',
          '- `recall_memory_status` — memory-system stats.',
          '',
          '## Decision shortcuts',
          '- "continue our last conversation" → `recall_recent` then `recall_context`/`recall_show`.',
          '- "remember when we discussed X" → `recall_memory_search`.',
          '- "what was I doing 2h ago" → `recall_edits_timeline` `since_hours: 2`.',
          '- "what do you know about me/this project" → `recall_wake_up` (+ `project_filter`).',
          '- "did we already decide on X" → `recall_kg_query` then `recall_decision_record`.',
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err}` }] };
  }
});

/**
 * Background freshness loop — the architecture's writer. The binary IS the
 * MCP + indexer + sync; there is no separate daemon to install on any OS.
 * Claude Code spawns this process for every session (Windows/macOS/Linux
 * alike, via mcp.json), so it runs exactly while the user works — which is
 * exactly when transcripts change. Each tick pushes the incremental delta
 * via syncIncremental(); the index-lock elects ONE writer among concurrent
 * sessions' MCP processes; the settings watermark makes ticks idempotent.
 * Not logged in → no-op. The 15s startup tick flushes whatever the
 * previous session left behind.
 */
const SYNC_TICK_MS = 3 * 60_000;
function startBackgroundSync(): void {
  const tick = async () => {
    let lock: ReturnType<typeof acquireIndexLock> = null;
    try {
      lock = acquireIndexLock({ kind: 'mcp-background-sync', staleAfterMs: SYNC_TICK_MS * 3 });
      if (!lock) return; // another session's MCP is the writer this tick
      const { syncIncremental } = await import('./sync-client.js');
      await syncIncremental();
    } catch (err) {
      console.error('[mcp] background sync tick failed:', err instanceof Error ? err.message : err);
    } finally {
      lock?.release();
    }
  };
  setInterval(() => { void tick(); }, SYNC_TICK_MS).unref();
  setTimeout(() => { void tick(); }, 15_000).unref();
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  startBackgroundSync();
}

main().catch(console.error);
