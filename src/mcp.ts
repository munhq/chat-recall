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

import { getEmbedder, type EmbedderProvider } from './core/embedder.js';
import { getRecentSessions, extractConversationContext, formatContext } from './core/context.js';
import { parseSessionFile } from './parsers/session.js';
import {
  liveScanModifiedFiles,
  liveScanRecentEdits,
  liveScanSessionEdits,
  type SessionEdit,
} from './core/live-session-scan.js';
import { replaySession, findRepoRoot } from './core/session-replay.js';
import { getSessionCommits } from './core/session-git.js';
import { extractTurns } from './core/session-turns.js';
import { markPrompt, summarizeMarkers } from './core/session-sentiment.js';
import { computeOutcome } from './core/session-outcome.js';
import { MemoryIndex } from './core/memory-index.js';
import { MemoryStore } from './core/memory-store.js';
import { SourceRegistry } from './core/source-registry.js';
import { SessionSource } from './parsers/session-source.js';
import { PlanSource } from './parsers/plan-source.js';
import { TaskSource } from './parsers/task-source.js';
import { ClaudeMdSource } from './parsers/claude-md-source.js';
import { HistorySource } from './parsers/history-source.js';
import { PasteSource } from './parsers/paste-source.js';
import { GeminiSessionSource } from './parsers/gemini-source.js';
import { GeminiBrainSource } from './parsers/gemini-brain-source.js';
import { OpenCodeSource } from './parsers/opencode-source.js';
import { OpenCodeTodoSource } from './parsers/opencode-todo-source.js';
import { CodexSessionSource } from './parsers/codex-session-source.js';
import { MetadataCache } from './core/metadata-cache.js';
import { KnowledgeGraph } from './core/knowledge-graph.js';
import { classifyChunk } from './core/memory-classifier.js';
import { extractAndPopulateKG } from './core/entity-extractor.js';
import { sanitizeQuery } from './core/query-sanitizer.js';
import { getWAL } from './core/write-ahead-log.js';
import { DiarySource } from './parsers/diary-source.js';
import { SkillsSource } from './parsers/skills-source.js';
import { McpsSource } from './parsers/mcps-source.js';
import { SlashCommandsSource } from './parsers/slash-commands-source.js';
import { SubagentsSource } from './parsers/subagents-source.js';
import { HooksSource } from './parsers/hooks-source.js';
import { PluginsSource } from './parsers/plugins-source.js';
import type { SourceType } from './types/memory.js';

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

// Tool schemas
const RecallSearchSchema = z.object({
  query: z.string().describe('What you\'re looking for (e.g., "OAuth implementation", "React hooks")'),
  top_k: z.number().optional().default(5).describe('Number of results to return'),
  project_filter: z.string().optional().describe('Optional filter by project path substring'),
  skip_ranking: z.boolean().optional().default(false).describe('Skip Claude ranking for faster results'),
  provider: z.enum(['ollama', 'gemini']).optional().default('ollama').describe('Embedding provider'),
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
});

const RecallMemoryStatusSchema = z.object({});

const RecallSmartResumeSchema = z.object({
  session_id: z.string().describe('Session ID to get smart resume context for'),
});

const RecallProjectContextSchema = z.object({
  project_path: z.string().describe('Project path or substring (e.g., "munbot", "chat-recall", "/home/user/code/personal/poly")'),
  limit: z.number().optional().default(5).describe('Number of recent sessions to include'),
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
    .describe('Optional override for the identity blurb. Defaults to ~/.claude/chat-recall-identity.txt or "AI coding assistant"'),
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
    version: '0.1.0',
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
Returns session IDs that can be used with \`claude --resume <session_id>\`.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you\'re looking for (e.g., "OAuth implementation", "React hooks")' },
            top_k: { type: 'number', default: 5, description: 'Number of results to return' },
            project_filter: { type: 'string', description: 'Optional filter by project path substring' },
            skip_ranking: { type: 'boolean', default: false, description: 'Skip Claude ranking for faster results' },
            provider: { type: 'string', enum: ['ollama', 'gemini'], default: 'ollama', description: 'Embedding provider' },
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
          const memoryIndex = new MemoryIndex(embedder);
          const memResults = await memoryIndex.search(searchQuery, {
            topK: searchTopK,
            sourceTypes: ['session'],
            projectFilter: params.project_filter,
          });
          // Transform MemorySearchResult to the legacy format used below
          const cache = new MetadataCache();
          results = memResults.map(r => {
            const cached = cache.get(r.itemId);
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
          cache.close();
        } catch (err) {
          if (err instanceof Error && err.message.includes('not found')) {
            return { content: [{ type: 'text', text: 'Error: Index not found. Run \'node dist/cli.js memory index\' first.' }] };
          }
          throw err;
        }
        
        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No matching sessions found.' }] };
        }

        // Truncate results
        const displayResults = results.slice(0, params.top_k);

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

          const scorePct = Math.round(result.score * 100);

          lines.push(`## #${i + 1}: ${title}`);
          lines.push(`**Project:** ${projectPath}`);
          lines.push(`**Created:** ${result.created.slice(0, 10)} | **Score:** ${scorePct}/100`);
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
        const memoryIndex = new MemoryIndex(embedder);
        const store = new MemoryStore();
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
        const kg = new KnowledgeGraph();
        let totalItems = 0, totalChunks = 0, totalErrors = 0, totalKGTriples = 0;
        for (const sourceType of registry.getRegisteredTypes()) {
          const sources = registry.getAll(sourceType);
          if (sources.length === 0) continue;
          for (const source of sources) {
          for await (const item of source.discover()) {
            try {
              if (!params.force && !memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime)) continue;
              await memoryIndex.deleteItem(item.sourceType, item.id);
              const chunks = await source.parse(item);
              // Classify chunks and enrich chunkType with memory type + importance
              for (const chunk of chunks) {
                const classification = classifyChunk(chunk.text);
                if (classification.memoryType !== 'general') {
                  chunk.chunkType = `${chunk.chunkType}:${classification.memoryType}:imp${classification.importance}`;
                }
                // Auto-extract entities into KG
                totalKGTriples += extractAndPopulateKG(kg, chunk.text, {
                  projectPath: item.projectPath,
                  sourceType: item.sourceType,
                  sessionId: item.id,
                });
              }
              if (chunks.length > 0) {
                await memoryIndex.bufferChunks(chunks);
                totalChunks += chunks.length;
              }
              store.setItem(item);
              const links = await source.extractLinks(item);
              if (links.length > 0) store.addLinks(links);
              totalItems++;
            } catch { totalErrors++; }
          }
          }
        }
        await memoryIndex.flushBuffer();
        kg.close();
        // Note: optimize() removed from auto flows — run `node dist/cli.js optimize` manually
        store.close();

        return {
          content: [{
            type: 'text',
            text: `Indexing complete!\nItems processed: ${totalItems}\nChunks indexed: ${totalChunks}\nKG triples extracted: ${totalKGTriples}\nErrors: ${totalErrors}`,
          }],
        };
      }
      
      case 'recall_status': {
        const dummyEmbedder = { embed: async () => [], embedQuery: async () => [], dimension: 768 };
        const memIdx = new MemoryIndex(dummyEmbedder as any);
        const stats = await memIdx.getStats();
        const store = new MemoryStore();
        const linkCount = store.getLinkCount();
        const ftsCount = store.getFTSCount();
        store.close();

        const lines = [
          'Chat-Recall Index Status',
          `Index path: ${stats.indexPath}`,
          `Total items: ${stats.totalItems}`,
          `Vector chunks: ${stats.totalChunks}`,
          `FTS5 chunks: ${ftsCount}`,
          `Total links: ${linkCount}`,
        ];

        if (Object.keys(stats.bySourceType).length > 0) {
          lines.push('\nBy source type:');
          for (const [type, data] of Object.entries(stats.bySourceType)) {
            lines.push(`  ${type}: ${data.items} items, ${data.chunks} chunks`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      
      case 'recall_show': {
        const params = RecallShowSchema.parse(args);

        // Find the session file
        const claudeDir = join(homedir(), '.claude', 'projects');
        let sessionFile: string | null = null;

        try {
          const entries = readdirSync(claudeDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const candidate = join(claudeDir, entry.name, `${params.session_id}.jsonl`);
            if (existsSync(candidate)) {
              sessionFile = candidate;
              break;
            }
          }
        } catch {
          return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
        }

        if (!sessionFile) {
          return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
        }

        interface Message {
          line: number;
          role: string;
          text: string;
        }

        // Parse messages
        const messagesList: Message[] = [];
        const lines = readFileSync(sessionFile, 'utf-8').split('\n');

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
          const line = lines[lineNum];
          if (!line.trim()) continue;

          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            const msgType = obj.type as string;

            if (msgType === 'user') {
              const msg = obj.message as Record<string, unknown>;
              if (msg && typeof msg === 'object') {
                const content = msg.content;
                let text = '';

                if (typeof content === 'string') {
                  text = content;
                } else if (Array.isArray(content)) {
                  const textParts: string[] = [];
                  for (const item of content) {
                    if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text') {
                      textParts.push((item as Record<string, unknown>).text as string || '');
                    }
                  }
                  text = textParts.join('\n');
                }

                if (text && !text.includes('<system-reminder>')) {
                  messagesList.push({
                    line: lineNum + 1,
                    role: 'User',
                    text,
                  });
                }
              }
            } else if (msgType === 'assistant') {
              const msg = obj.message as Record<string, unknown>;
              if (msg && typeof msg === 'object') {
                const content = msg.content;
                if (Array.isArray(content)) {
                  for (const item of content) {
                    if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text') {
                      let text = (item as Record<string, unknown>).text as string || '';
                      if (text) {
                        if (!params.include_code) {
                          text = text.replace(/```[\s\S]*?```/g, '[code block]');
                        }
                        messagesList.push({
                          line: lineNum + 1,
                          role: 'Claude',
                          text,
                        });
                        break;
                      }
                    }
                  }
                }
              }
            } else if (msgType === 'summary') {
              const summary = obj.summary as string;
              if (summary) {
                messagesList.push({
                  line: lineNum + 1,
                  role: 'Summary',
                  text: summary,
                });
              }
            }
          } catch {
            continue;
          }
        }

        if (messagesList.length === 0) {
          return { content: [{ type: 'text', text: 'No messages found in session.' }] };
        }

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
          let text = msg.text;
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
        const Database = (await import('better-sqlite3')).default;
        const cacheDb = new Database(join(homedir(), '.claude', 'chat-recall-cache.db'), { readonly: true });

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
            const row = cacheDb.prepare('SELECT summary FROM session_metadata WHERE session_id = ?').get(session.sessionId) as { summary: string } | undefined;

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
          cacheDb.close();
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_context': {
        const params = RecallContextSchema.parse(args);

        // Find the session file
        const claudeDir = join(homedir(), '.claude', 'projects');
        let sessionFile: string | null = null;

        try {
          const entries = readdirSync(claudeDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const candidate = join(claudeDir, entry.name, `${params.session_id}.jsonl`);
            if (existsSync(candidate)) {
              sessionFile = candidate;
              break;
            }
          }
        } catch {
          return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
        }

        if (!sessionFile) {
          return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
        }

        const context = extractConversationContext(sessionFile);
        let formatted = formatContext(context);

        // Append token/cost metadata
        try {
          const content = await parseSessionFile(sessionFile);
          const m = content.metadata;
          if (m.inputTokens > 0) {
            const lines: string[] = ['## Context Budget'];
            if (m.slug) lines.push(`Session: ${m.slug}`);
            if (m.durationMs > 0) {
              const mins = Math.round(m.durationMs / 60000);
              lines.push(`Duration: ~${mins} min | ${m.messageCount} messages`);
            }
            lines.push(`Input: ${(m.inputTokens / 1_000_000).toFixed(1)}M tokens | Output: ${(m.outputTokens / 1000).toFixed(1)}k tokens`);
            lines.push(`Cache reads: ${(m.cacheReadTokens / 1_000_000).toFixed(1)}M | Peak context: ${(m.peakContextTokens / 1000).toFixed(0)}k`);
            if (m.filesModified.length > 0) {
              lines.push(`Files modified: ${m.filesModified.length}`);
            }
            if (m.modelsUsed.length > 0) {
              lines.push(`Models: ${m.modelsUsed.filter(x => x !== '<synthetic>').join(', ')}`);
            }
            formatted += '\n\n' + lines.join('\n');
          }
        } catch {
          // Non-critical, continue without metadata
        }

        // Optional: append in-order turn dump so reviewers can see what the
        // agent actually said and what tool output came back.
        if (params.include_turns) {
          try {
            const turns = extractTurns(params.session_id, { maxTurns: params.turns_limit });
            if (turns.found && turns.turns.length > 0) {
              const lines: string[] = ['', '## Turn-by-turn'];
              for (const t of turns.turns.slice(0, params.turns_limit)) {
                const stamp = t.tsIso ? t.tsIso.slice(11, 19) : '';
                if (t.kind === 'user' && t.text) {
                  lines.push(`- ${stamp} **user** — ${t.text.replace(/\n/g, ' ')}`);
                } else if (t.kind === 'assistant_text' && t.text) {
                  const trimmed = t.text.length > 400 ? t.text.slice(0, 400) + '…' : t.text;
                  lines.push(`- ${stamp} **assistant** — ${trimmed.replace(/\n/g, ' ')}`);
                } else if (t.kind === 'tool_use' && t.toolName) {
                  const sum = t.toolInputSummary ? ` ${t.toolInputSummary.replace(/\n/g, ' ').slice(0, 160)}` : '';
                  lines.push(`- ${stamp} **${t.toolName}**${sum}`);
                } else if (t.kind === 'tool_result') {
                  const flag = t.resultIsError ? '❌' : '✓';
                  const exit = t.resultExitCode !== undefined ? ` exit=${t.resultExitCode}` : '';
                  const snip = t.resultSummary ? ` ${t.resultSummary.replace(/\n/g, ' ').slice(0, 200)}` : '';
                  lines.push(`  ${flag} result${exit}${snip}`);
                }
              }
              formatted += '\n' + lines.join('\n');
            }
          } catch {
            // Non-critical — keep the response usable.
          }
        }

        return { content: [{ type: 'text', text: formatted }] };
      }

      case 'recall_summary': {
        const params = RecallSummarySchema.parse(args);

        // 1. Pull the cached AI summary if one was generated.
        const Database = (await import('better-sqlite3')).default;
        const cacheDb = new Database(join(homedir(), '.claude', 'chat-recall-cache.db'), { readonly: true });
        let aiSummary: { summary: string; summary_source: string } | null = null;
        try {
          aiSummary = (cacheDb.prepare('SELECT summary, summary_source FROM session_metadata WHERE session_id = ?')
            .get(params.session_id) as { summary: string; summary_source: string } | undefined) ?? null;
        } finally {
          cacheDb.close();
        }

        // Legacy mode: just the AI summary.
        if (!params.rich) {
          if (!aiSummary) {
            return { content: [{ type: 'text', text: `No summary found for session: ${params.session_id}\n\nRun 'npm run generate-summaries' to generate summaries.` }] };
          }
          return { content: [{ type: 'text', text: [
            `# 📋 Summary`,
            '',
            `**Session:** ${params.session_id.substring(0, 8)}...`,
            `**Source:** ${aiSummary.summary_source}`,
            '',
            '---',
            '',
            aiSummary.summary,
            '',
            '---',
            '',
            `**🔄 Resume:** \`claude --resume ${params.session_id}\``,
          ].join('\n') }] };
        }

        // 2. Compute the structured outcome from the transcript.
        const outcome = computeOutcome(params.session_id);
        if (!outcome.found && !aiSummary) {
          return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
        }

        const lines: string[] = [];
        lines.push(`# 📋 Summary — ${params.session_id.substring(0, 8)}…`);
        lines.push('');

        // Status header line — most useful single signal.
        if (outcome.found) {
          const statusEmoji =
            outcome.status === 'shipped' ? '🚢' :
            outcome.status === 'interrupted' ? '⏸' :
            outcome.status === 'abandoned' ? '🪦' :
            outcome.status === 'in_progress' ? '🟡' : '❔';
          lines.push(`**Status:** ${statusEmoji} ${outcome.status} — ${outcome.reason}`);
          if (outcome.fileCount > 0) {
            lines.push(`**Edits:** ${outcome.fileCount} file(s) · +${outcome.totalLinesAdded} / −${outcome.totalLinesRemoved} lines`);
          }
          if (outcome.commits.totalCommits > 0) {
            const repoNames = outcome.commits.repos.map(r => `${r.repoName} (${r.commits.length})`).join(', ');
            lines.push(`**Commits:** ${outcome.commits.totalCommits} across ${outcome.commits.repos.length} repo(s) — ${repoNames}`);
          }
          lines.push('');
        }

        // AI summary (verbatim) — keep for narrative context.
        if (aiSummary) {
          lines.push('## AI Summary');
          lines.push(`*Source: ${aiSummary.summary_source}*`);
          lines.push('');
          lines.push(aiSummary.summary);
          lines.push('');
        }

        if (outcome.found) {
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
        }

        lines.push('---');
        lines.push('');
        lines.push(`**🔄 Resume:** \`claude --resume ${params.session_id}\``);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_diff': {
        const params = RecallDiffSchema.parse(args);
        const result = replaySession(params.session_id);
        if (!result.found) {
          return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
        }
        const files = params.file ? result.files.filter(f => f.file === params.file) : result.files;
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
        const replay = replaySession(params.session_id);
        if (!replay.found) {
          return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
        }
        const turns = extractTurns(params.session_id, { maxTurns: 50_000 });
        const result = getSessionCommits(
          params.session_id,
          replay.files.map(f => f.file),
          turns.startMs || Date.now() - 86_400_000,
          turns.endMs || Date.now(),
          params.buffer_minutes,
        );
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
        const o = computeOutcome(params.session_id);
        if (!o.found) {
          return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
        }
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
        const turns = extractTurns(params.session_id, { maxTurns: 50_000 });
        if (!turns.found) {
          return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
        }
        const prompts = turns.turns
          .filter(t => t.kind === 'user' && t.text)
          .slice(0, params.limit)
          .map(t => ({ ts: t.ts, tsIso: t.tsIso, line: t.line, ...markPrompt(t.text!) }));
        const summary = summarizeMarkers(prompts);
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

        // Use provided param, env var, or default to ollama (local)
        const provider = (params.provider || process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider;

        // Search for relevant sessions
        let embedder: Awaited<ReturnType<typeof getEmbedder>> | null;
        try {
          embedder = getEmbedder(provider);
        } catch {
          embedder = null;
        }

        let results;
        try {
          const memIdx = new MemoryIndex(embedder);
          const memResults = await memIdx.search(params.current_task, {
            topK: params.top_k,
            sourceTypes: ['session'],
          });
          const cache = new MetadataCache();
          results = memResults.map(r => {
            const cached = cache.get(r.itemId);
            return {
              sessionId: r.itemId,
              score: r.score,
              chunkType: r.matchedChunks[0]?.chunkType || 'unknown',
              text: r.matchedChunks[0]?.text || r.title,
              projectPath: r.projectPath,
              created: '', modified: '',
              firstPrompt: cached?.firstPrompt || r.title,
              summary: cached?.summary,
              matchedChunks: r.matchedChunks,
            };
          });
          cache.close();
        } catch (err) {
          if (err instanceof Error && err.message.includes('not found')) {
            return { content: [{ type: 'text', text: 'Error: Index not found. Run \'node dist/cli.js memory index\' first.' }] };
          }
          throw err;
        }

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No relevant past conversations found.' }] };
        }

        // Get summaries from metadata cache
        const Database = (await import('better-sqlite3')).default;
        const cacheDb = new Database(join(homedir(), '.claude', 'chat-recall-cache.db'), { readonly: true });

        const output = [
          `# Suggested Conversations to Resume`,
          `Based on: "${params.current_task}"`,
          '',
        ];

        try {
          for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const row = cacheDb.prepare('SELECT summary FROM session_metadata WHERE session_id = ?').get(result.sessionId) as { summary: string } | undefined;

            output.push(`## ${i + 1}. Session ${result.sessionId.substring(0, 8)}...`);
            output.push(`**Project:** ${result.projectPath.replace(homedir(), '~')}`);
            output.push(`**Relevance:** ${(result.score * 100).toFixed(1)}%`);
            output.push('');

            if (row && row.summary) {
              // Show first 300 chars of summary
              const shortSummary = row.summary.length > 300 ? row.summary.substring(0, 300) + '...' : row.summary;
              output.push(shortSummary);
            } else {
              output.push(result.text.substring(0, 200) + '...');
            }

            // KG facts for this project
            const projSlug = result.projectPath.split('/').filter(Boolean).pop() || '';
            if (projSlug) {
              try {
                const kgSuggest = new KnowledgeGraph();
                const facts = kgSuggest.queryEntity(projSlug).filter(f => f.current && f.direction === 'outgoing').slice(0, 5);
                if (facts.length > 0) {
                  output.push(`**Known:** ${facts.map(f => `${f.predicate} ${f.object}`).join(', ')}`);
                }
                kgSuggest.close();
              } catch { /* skip */ }
            }

            output.push('');
            output.push(`**Resume:** \`claude --resume ${result.sessionId}\``);
            output.push('');
          }
        } finally {
          cacheDb.close();
        }

        return { content: [{ type: 'text', text: output.join('\n') }] };
      }

      case 'recall_memory_search': {
        const params = RecallMemorySearchSchema.parse(args);

        // Sanitize query to prevent prompt injection
        const sanitizedMem = sanitizeQuery(params.query);
        const memSearchQuery = sanitizedMem.cleanQuery;

        const provider = (params.provider || process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider;

        let embedder: Awaited<ReturnType<typeof getEmbedder>> | null;
        try {
          embedder = getEmbedder(provider);
        } catch {
          embedder = null;
        }

        const memoryIndex = new MemoryIndex(embedder);
        const results = await memoryIndex.search(memSearchQuery, {
          topK: params.top_k,
          sourceTypes: params.source_types as SourceType[] | undefined,
          projectFilter: params.project_filter,
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
        const dummyEmbedder = {
          embed: async () => [] as number[][],
          embedQuery: async () => [] as number[],
          dimension: 768,
        };

        const memoryIndex = new MemoryIndex(dummyEmbedder);
        const memoryStore = new MemoryStore();

        const indexStats = await memoryIndex.getStats();
        const storeStats = memoryStore.getStats();
        const linkCount = memoryStore.getLinkCount();
        const ftsCount = memoryStore.getFTSCount();

        const lines = [
          '# Memory System Status\n',
          `Total items: ${indexStats.totalItems}`,
          `Vector chunks: ${indexStats.totalChunks}`,
          `FTS5 chunks: ${ftsCount}`,
          `Total links: ${linkCount}`,
          '',
        ];

        if (Object.keys(indexStats.bySourceType).length > 0) {
          lines.push('**By source type:**');
          for (const [type, data] of Object.entries(indexStats.bySourceType)) {
            lines.push(`- ${type}: ${data.items} items, ${data.chunks} chunks`);
          }
        }

        memoryStore.close();
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_plans': {
        const params = RecallPlansSchema.parse(args);
        const memoryStore = new MemoryStore();
        const items = memoryStore.listItems('plan', params.limit);

        if (items.length === 0) {
          memoryStore.close();
          return { content: [{ type: 'text', text: 'No plans indexed. Run `chat-recall memory index` first.' }] };
        }

        const lines = [`# Indexed Plans (${items.length})\n`];

        for (const item of items) {
          const date = new Date(item.mtime).toISOString().slice(0, 10);
          lines.push(`- **${item.title}** (${date})`);
          if (item.content_preview) {
            lines.push(`  ${item.content_preview.slice(0, 120)}...`);
          }
          const links = memoryStore.getLinksFrom('plan', item.id);
          for (const link of links) {
            if (link.target_type === 'session') {
              lines.push(`  **Session:** \`claude --resume ${link.target_id}\``);
            }
          }
        }

        memoryStore.close();
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_plan_show': {
        const params = RecallPlanShowSchema.parse(args);
        const plansDir = join(homedir(), '.claude', 'plans');
        const filePath = join(plansDir, `${params.plan_id}.md`);

        if (!existsSync(filePath)) {
          return { content: [{ type: 'text', text: `Plan not found: ${params.plan_id}` }] };
        }

        const content = readFileSync(filePath, 'utf-8');
        return { content: [{ type: 'text', text: content }] };
      }

      case 'recall_tasks': {
        const params = RecallTasksSchema.parse(args);
        const memoryStore = new MemoryStore();
        const items = memoryStore.listItems('task', params.limit);

        if (items.length === 0) {
          memoryStore.close();
          return { content: [{ type: 'text', text: 'No tasks indexed. Run `chat-recall memory index` first.' }] };
        }

        const lines = [`# Indexed Task Groups (${items.length})\n`];

        for (const item of items) {
          const extra = JSON.parse(item.extra_json || '{}');
          const taskCount = extra.taskCount || '?';
          const completedCount = extra.completedCount || 0;

          lines.push(`## Session ${item.id.slice(0, 8)}...`);
          lines.push(`**Tasks:** ${completedCount}/${taskCount} completed`);
          lines.push(`**Subjects:** ${item.title}`);

          // Show links to session
          const links = memoryStore.getLinksFrom('task', item.id);
          for (const link of links) {
            if (link.target_type === 'session') {
              lines.push(`**Resume:** \`claude --resume ${link.target_id}\``);
            }
          }

          lines.push('');
        }

        memoryStore.close();
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_smart_resume': {
        const params = RecallSmartResumeSchema.parse(args);

        // Find the session file
        const claudeDirSR = join(homedir(), '.claude', 'projects');
        let sessionFileSR: string | null = null;
        let projectPathSR = '';

        try {
          const entries = readdirSync(claudeDirSR, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const candidate = join(claudeDirSR, entry.name, `${params.session_id}.jsonl`);
            if (existsSync(candidate)) {
              sessionFileSR = candidate;
              projectPathSR = entry.name.replace(/-/g, '/').replace(/^\//, '/');
              break;
            }
          }
        } catch {
          return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
        }

        // Fallback: session may be a Gemini or OpenCode item indexed in the
        // memory store rather than a Claude .jsonl on disk. Return a minimal
        // resume dossier built from memory_metadata + cached summary so the
        // tool is useful across all three backends.
        if (!sessionFileSR) {
          const fbStore = new MemoryStore();
          try {
            // Accept either raw id ("<uuid>") or prefixed id ("gemini_<uuid>", "opencode_<uuid>").
            const candidates = [
              params.session_id,
              `gemini_${params.session_id}`,
              `opencode_${params.session_id}`,
            ];
            let item: any = null;
            for (const id of candidates) {
              item = fbStore.getItem(id, 'session' as SourceType);
              if (item) break;
            }
            if (!item) {
              return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
            }
            let extra: any = {};
            try { extra = JSON.parse(item.extra_json || '{}'); } catch {}
            const DatabaseFB = (await import('better-sqlite3')).default;
            const cacheDbFB = new DatabaseFB(join(homedir(), '.claude', 'chat-recall-cache.db'), { readonly: true });
            const row = cacheDbFB
              .prepare('SELECT summary, first_prompt FROM session_metadata WHERE session_id = ?')
              .get(item.id) as { summary: string; first_prompt: string } | undefined;
            cacheDbFB.close();
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
            fbStore.close();
          }
        }

        // Parse the session for structured resume data
        const sessionContent = await parseSessionFile(sessionFileSR);
        const meta = sessionContent.metadata;

        // Get summary
        const DatabaseSR = (await import('better-sqlite3')).default;
        const cacheDbSR = new DatabaseSR(join(homedir(), '.claude', 'chat-recall-cache.db'), { readonly: true });
        const summaryRow = cacheDbSR.prepare('SELECT summary FROM session_metadata WHERE session_id = ?')
          .get(params.session_id) as { summary: string } | undefined;
        cacheDbSR.close();

        // Get tasks for this session
        const storeSR = new MemoryStore();
        const taskLinks = storeSR.getLinksTo('session' as SourceType, params.session_id);
        const taskItems: Array<{ title: string; completed: number; total: number; subjects: string[] }> = [];
        for (const link of taskLinks) {
          if (link.source_type === 'task') {
            const taskMeta = storeSR.getItem(link.source_id, 'task' as SourceType);
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
        storeSR.close();

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

        // What was done
        if (context.claudeWork.length > 0) {
          lines.push('## Completed Work');
          for (const work of context.claudeWork.slice(0, 8)) {
            lines.push(`- ${work}`);
          }
          lines.push('');
        }

        // Known facts from knowledge graph about this project
        if (projName) {
          try {
            const kgResume = new KnowledgeGraph();
            const projFacts = kgResume.queryEntity(projName);
            const currentFacts = projFacts.filter(f => f.current);
            if (currentFacts.length > 0) {
              lines.push('## Known Facts (Knowledge Graph)');
              for (const fact of currentFacts.slice(0, 15)) {
                const arrow = fact.direction === 'outgoing' ? '→' : '←';
                lines.push(`- ${fact.subject} ${arrow} **${fact.predicate}** ${arrow} ${fact.object}`);
              }
              lines.push('');
            }
            kgResume.close();
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

      case 'recall_project_context': {
        const params = RecallProjectContextSchema.parse(args);
        const store = new MemoryStore();

        // Get recent sessions for this project
        const sessions = getRecentSessions(params.project_path, params.limit);
        const cache = new MetadataCache();

        const lines = [`# Project Context: ${params.project_path}\n`];

        if (sessions.length === 0) {
          lines.push('No sessions found for this project.');
          store.close();
          cache.close();
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // Recent sessions with summaries and metadata
        lines.push('## Recent Sessions\n');
        let totalCost = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        const allModels = new Set<string>();
        const allFilesModified = new Set<string>();

        const Database = (await import('better-sqlite3')).default;
        const cacheDb = new Database(join(homedir(), '.claude', 'chat-recall-cache.db'), { readonly: true });

        try {
          for (let i = 0; i < sessions.length; i++) {
            const session = sessions[i];
            const modified = session.modified ? session.modified.slice(0, 16).replace('T', ' ') : 'unknown';

            // Get summary
            const row = cacheDb.prepare('SELECT summary FROM session_metadata WHERE session_id = ?')
              .get(session.sessionId) as { summary: string } | undefined;

            // Get metadata from store
            const meta = store.getItem(session.sessionId, 'session' as SourceType);
            let extra: Record<string, unknown> = {};
            if (meta?.extra_json) {
              try { extra = JSON.parse(meta.extra_json); } catch { /* skip */ }
            }

            const inputTokens = (extra.inputTokens as number) || 0;
            const outputTokens = (extra.outputTokens as number) || 0;
            const cacheReadTokens = (extra.cacheReadTokens as number) || 0;
            const peakContext = (extra.peakContextTokens as number) || 0;
            const filesModified = (extra.filesModified as string[]) || [];
            const modelsUsed = (extra.modelsUsed as string[]) || [];
            const durationMs = (extra.durationMs as number) || 0;

            // Calculate cost (rough estimate)
            const costEstimate = (inputTokens * 3 / 1_000_000) + (outputTokens * 15 / 1_000_000)
              - (cacheReadTokens * 2.7 / 1_000_000);
            totalCost += costEstimate;
            totalInputTokens += inputTokens;
            totalOutputTokens += outputTokens;
            for (const m of modelsUsed) { if (m !== '<synthetic>') allModels.add(m); }
            for (const f of filesModified) allFilesModified.add(f);

            let summaryText = row?.summary
              ? (row.summary.length > 200 ? row.summary.slice(0, 200) + '...' : row.summary)
              : session.firstPrompt.replace(/\n/g, ' ').slice(0, 100) || '(no prompt)';

            const durationMin = durationMs > 0 ? `${Math.round(durationMs / 60000)}min` : '';
            const peakPct = peakContext > 0 ? `${Math.round(peakContext / 2000)}%` : '';

            lines.push(`**${i + 1}. ${modified}** ${durationMin ? `(${durationMin})` : ''}`);
            lines.push(`   ${summaryText}`);
            if (peakPct) lines.push(`   Context: ${peakPct} | Cost: ~$${costEstimate.toFixed(2)}`);
            lines.push(`   Resume: \`claude --resume ${session.sessionId}\``);
            lines.push('');
          }
        } finally {
          cacheDb.close();
        }

        // Overall stats
        lines.push('## Stats\n');
        lines.push(`Sessions: ${sessions.length} | Cost: ~$${totalCost.toFixed(2)}`);
        lines.push(`Input: ${(totalInputTokens / 1_000_000).toFixed(1)}M tokens | Output: ${(totalOutputTokens / 1000).toFixed(0)}k tokens`);
        if (allModels.size > 0) lines.push(`Models: ${Array.from(allModels).join(', ')}`);
        lines.push('');

        // Open tasks for this project
        const taskItems = store.listItemsByProject('task' as SourceType, params.project_path, 5);
        if (taskItems.length > 0) {
          lines.push('## Open Tasks\n');
          for (const task of taskItems) {
            const extra = JSON.parse(task.extra_json || '{}');
            const completed = extra.completedCount || 0;
            const total = extra.taskCount || '?';
            lines.push(`- ${task.title} (${completed}/${total} done)`);
          }
          lines.push('');
        }

        // Related plans
        const planItems = store.listItemsByProject('plan' as SourceType, params.project_path, 5);
        if (planItems.length > 0) {
          lines.push('## Related Plans\n');
          for (const plan of planItems) {
            const date = new Date(plan.mtime).toISOString().slice(0, 10);
            lines.push(`- ${plan.title} (${date})`);
          }
          lines.push('');
        }

        // Knowledge graph facts for this project
        const projectSlug = params.project_path.split('/').filter(Boolean).pop() || params.project_path;
        try {
          const kgCtx = new KnowledgeGraph();
          const projectFacts = kgCtx.queryEntity(projectSlug);
          const currentFacts = projectFacts.filter(f => f.current);
          if (currentFacts.length > 0) {
            lines.push('## Known Facts (Knowledge Graph)\n');
            for (const fact of currentFacts.slice(0, 20)) {
              const arrow = fact.direction === 'outgoing' ? '→' : '←';
              lines.push(`- ${fact.subject} ${arrow} **${fact.predicate}** ${arrow} ${fact.object}`);
            }
            lines.push('');
          }
          kgCtx.close();
        } catch { /* KG not available */ }

        // Files modified
        if (allFilesModified.size > 0) {
          lines.push('## Files Modified Recently\n');
          const sorted = Array.from(allFilesModified).slice(0, 15);
          for (const f of sorted) {
            lines.push(`- ${f}`);
          }
          lines.push('');
        }

        // Try to get recent git commits
        try {
          // Resolve the actual project path from the filter
          let actualPath = '';
          if (sessions.length > 0) {
            // Try to derive from the project directory name
            const dirName = sessions[0].projectDir;
            actualPath = dirName.replace(/-/g, '/').replace(/^\//, '/');
          }
          if (actualPath && existsSync(actualPath)) {
            const { execSync } = await import('child_process');
            const gitLog = execSync(
              `git -C "${actualPath}" log --oneline -10 --since="2 weeks ago" 2>/dev/null`,
              { encoding: 'utf-8', timeout: 5000 }
            ).trim();
            if (gitLog) {
              lines.push('## Recent Git Commits\n');
              lines.push('```');
              lines.push(gitLog);
              lines.push('```');
              lines.push('');
            }
          }
        } catch { /* no git or not a git repo */ }

        // Cross-project intelligence: find related work in other projects
        // Use the project's recent session summaries as search queries against other projects
        if (sessions.length > 0) {
          const ftsStore = new MemoryStore();
          const ftsCount = ftsStore.getFTSCount();

          if (ftsCount > 0) {
            // Extract key terms from this project's recent work
            const projectName = params.project_path.split('/').pop() || params.project_path;
            const searchTerms: string[] = [];

            // Get top topics from session summaries/titles
            for (const s of sessions.slice(0, 3)) {
              const words = (s.firstPrompt || '').split(/\s+/).filter(w => w.length > 4).slice(0, 5);
              searchTerms.push(...words);
            }

            if (searchTerms.length > 0) {
              // Search for these terms but EXCLUDE the current project
              const crossResults = ftsStore.searchFTS(
                searchTerms.slice(0, 8).join(' '),
                { topK: 20, sourceTypes: ['session'] }
              );

              // Filter out results from the same project
              const otherProjectResults = crossResults.filter(r =>
                !r.projectPath.includes(params.project_path) &&
                !params.project_path.includes(r.projectPath.split('/').pop() || '')
              );

              if (otherProjectResults.length > 0) {
                lines.push('## Related Work in Other Projects\n');
                const seen = new Set<string>();
                for (const r of otherProjectResults.slice(0, 5)) {
                  const proj = r.projectPath.split('/').pop() || r.projectPath;
                  if (seen.has(proj)) continue;
                  seen.add(proj);
                  let title = r.title.replace(/\n/g, ' ').slice(0, 80);
                  lines.push(`- **${proj}**: ${title}`);
                }
                lines.push('');
              }
            }
          }

          ftsStore.close();
        }

        store.close();
        cache.close();
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'recall_weekly_digest': {
        const params = RecallWeeklyDigestSchema.parse(args);
        const store = new MemoryStore();

        // Calculate week boundaries (Monday-based)
        const now = new Date();
        const dayOfWeek = now.getDay();
        const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - mondayOffset - (params.weeks_back * 7));
        weekStart.setHours(0, 0, 0, 0);

        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);

        const prevWeekStart = new Date(weekStart);
        prevWeekStart.setDate(prevWeekStart.getDate() - 7);

        const weekLabel = params.weeks_back === 0
          ? 'This Week'
          : params.weeks_back === 1
            ? 'Last Week'
            : `${params.weeks_back} Weeks Ago`;
        const dateRange = `${weekStart.toISOString().slice(0, 10)} — ${weekEnd.toISOString().slice(0, 10)}`;

        // Get all sessions in the time range from metadata
        const Database = (await import('better-sqlite3')).default;
        const cacheDb = new Database(join(homedir(), '.claude', 'chat-recall-cache.db'), { readonly: true });

        const allSessions = store.listItems('session' as SourceType, 1000);
        const weekSessions = allSessions.filter(s => s.mtime >= weekStart.getTime() && s.mtime < weekEnd.getTime());
        const prevWeekSessions = allSessions.filter(s => s.mtime >= prevWeekStart.getTime() && s.mtime < weekStart.getTime());

        const lines = [`# ${weekLabel}: ${dateRange}\n`];

        if (weekSessions.length === 0) {
          lines.push('No sessions found for this period.');
          store.close();
          cacheDb.close();
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // Aggregate stats
        let totalCost = 0;
        let totalDuration = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheTokens = 0;
        const projectStats = new Map<string, { sessions: number; cost: number; summaries: string[] }>();
        const modelCounts = new Map<string, number>();
        const allFiles = new Set<string>();

        for (const session of weekSessions) {
          const extra = JSON.parse(session.extra_json || '{}');
          const inputTokens = (extra.inputTokens as number) || 0;
          const outputTokens = (extra.outputTokens as number) || 0;
          const cacheReadTokens = (extra.cacheReadTokens as number) || 0;
          const durationMs = (extra.durationMs as number) || 0;
          const filesModified = (extra.filesModified as string[]) || [];
          const modelsUsed = (extra.modelsUsed as string[]) || [];

          const cost = (inputTokens * 3 / 1_000_000) + (outputTokens * 15 / 1_000_000)
            - (cacheReadTokens * 2.7 / 1_000_000);
          totalCost += cost;
          totalDuration += durationMs;
          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;
          totalCacheTokens += cacheReadTokens;
          for (const f of filesModified) allFiles.add(f);
          for (const m of modelsUsed) {
            if (m !== '<synthetic>') modelCounts.set(m, (modelCounts.get(m) || 0) + 1);
          }

          // Project aggregation
          const proj = session.project_path || 'unknown';
          const projName = proj.split('/').pop() || proj;
          if (!projectStats.has(projName)) {
            projectStats.set(projName, { sessions: 0, cost: 0, summaries: [] });
          }
          const ps = projectStats.get(projName)!;
          ps.sessions++;
          ps.cost += cost;

          // Get summary
          const row = cacheDb.prepare('SELECT summary FROM session_metadata WHERE session_id = ?')
            .get(session.id) as { summary: string } | undefined;
          if (row?.summary) {
            ps.summaries.push(row.summary.slice(0, 80));
          }
        }

        cacheDb.close();

        const durationHours = Math.round(totalDuration / 3_600_000 * 10) / 10;
        const cacheHitRate = totalInputTokens > 0
          ? Math.round((totalCacheTokens / (totalInputTokens + totalCacheTokens)) * 100)
          : 0;

        // Overview
        lines.push(`**${weekSessions.length} sessions** · **$${totalCost.toFixed(0)}** · **${durationHours}h** coding time`);
        if (cacheHitRate > 0) lines.push(`Cache hit rate: ${cacheHitRate}%`);
        lines.push('');

        // Top projects
        lines.push('## Top Projects\n');
        const sortedProjects = Array.from(projectStats.entries())
          .sort((a, b) => b[1].sessions - a[1].sessions);

        for (const [name, stats] of sortedProjects.slice(0, 8)) {
          const summaryHint = stats.summaries.length > 0
            ? ` — ${stats.summaries[0]}` : '';
          lines.push(`**${name}** · ${stats.sessions} sessions · $${stats.cost.toFixed(0)}${summaryHint}`);
        }
        lines.push('');

        // Models used
        if (modelCounts.size > 0) {
          lines.push('## Models Used\n');
          for (const [model, count] of Array.from(modelCounts.entries()).sort((a, b) => b[1] - a[1])) {
            const shortModel = model.replace(/^claude-/, '').replace(/^models\//, '');
            lines.push(`- ${shortModel}: ${count} sessions`);
          }
          lines.push('');
        }

        // Cost comparison
        if (prevWeekSessions.length > 0) {
          let prevCost = 0;
          for (const s of prevWeekSessions) {
            const extra = JSON.parse(s.extra_json || '{}');
            const inp = (extra.inputTokens as number) || 0;
            const out = (extra.outputTokens as number) || 0;
            const cache = (extra.cacheReadTokens as number) || 0;
            prevCost += (inp * 3 / 1_000_000) + (out * 15 / 1_000_000) - (cache * 2.7 / 1_000_000);
          }
          const pctChange = prevCost > 0 ? Math.round(((totalCost - prevCost) / prevCost) * 100) : 0;
          const arrow = pctChange > 0 ? '+' : '';
          lines.push('## vs Previous Week\n');
          lines.push(`This week: ${weekSessions.length} sessions, $${totalCost.toFixed(0)}`);
          lines.push(`Last week: ${prevWeekSessions.length} sessions, $${prevCost.toFixed(0)}`);
          lines.push(`Change: ${arrow}${pctChange}%`);
          lines.push('');
        }

        // Open tasks
        const taskItems = store.listItems('task' as SourceType, 20);
        const recentTasks = taskItems.filter(t => t.mtime >= weekStart.getTime());
        if (recentTasks.length > 0) {
          lines.push('## Open Tasks\n');
          for (const task of recentTasks.slice(0, 10)) {
            const extra = JSON.parse(task.extra_json || '{}');
            const completed = extra.completedCount || 0;
            const total = extra.taskCount || '?';
            lines.push(`- ${task.title} (${completed}/${total})`);
          }
          lines.push('');
        }

        // Knowledge graph stats
        try {
          const kgDigest = new KnowledgeGraph();
          const kgS = kgDigest.stats();
          if (kgS.triples > 0) {
            lines.push('## Knowledge Graph\n');
            lines.push(`Entities: ${kgS.entities} | Facts: ${kgS.current_facts} current, ${kgS.expired_facts} expired`);
            if (kgS.relationship_types.length > 0) {
              lines.push(`Relationships: ${kgS.relationship_types.join(', ')}`);
            }
            lines.push('');
          }
          kgDigest.close();
        } catch { /* KG not available */ }

        store.close();
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── Knowledge Graph Handlers ─────────────────────────────────

      case 'recall_kg_query': {
        const params = RecallKGQuerySchema.parse(args);
        const kg = new KnowledgeGraph();
        const facts = kg.queryEntity(params.entity, params.as_of, params.direction);
        kg.close();

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

        const kg = new KnowledgeGraph();
        const tripleId = kg.addTriple(params.subject, params.predicate, params.object, {
          validFrom: params.valid_from,
          sourceSession: params.source_session,
        });
        kg.close();

        return { content: [{ type: 'text', text: `Added: ${params.subject} → ${params.predicate} → ${params.object} (id: ${tripleId})` }] };
      }

      case 'recall_kg_invalidate': {
        const params = RecallKGInvalidateSchema.parse(args);
        const wal = getWAL();
        wal.log('kg_invalidate', { subject: params.subject, predicate: params.predicate, object: params.object, ended: params.ended });

        const kg = new KnowledgeGraph();
        const count = kg.invalidate(params.subject, params.predicate, params.object, params.ended);
        kg.close();

        const endDate = params.ended || new Date().toISOString().split('T')[0];
        return { content: [{ type: 'text', text: `Invalidated ${count} fact(s): ${params.subject} → ${params.predicate} → ${params.object} (ended: ${endDate})` }] };
      }

      case 'recall_kg_timeline': {
        const params = RecallKGTimelineSchema.parse(args);
        const kg = new KnowledgeGraph();
        const entries = kg.timeline(params.entity, params.limit);
        kg.close();

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
        const kg = new KnowledgeGraph();
        const s = kg.stats();
        kg.close();

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

        const entryId = DiarySource.write({
          agent: params.agent_name,
          topic: params.topic,
          content: params.entry,
          timestamp: new Date().toISOString(),
          sessionId: params.session_id,
          projectPath: params.project_path,
        });

        return { content: [{ type: 'text', text: `Diary entry saved: ${entryId}` }] };
      }

      case 'recall_diary_read': {
        const params = RecallDiaryReadSchema.parse(args);
        const entries = DiarySource.read(params.agent_name, params.last_n);

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
        const params = RecallSubagentSearchSchema.parse(args);
        const { readdirSync: rd, readFileSync: rf, statSync: st } = await import('fs');
        const projectsRoot = join(homedir(), '.claude', 'projects');

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
        const cutoff = Date.now() - params.since_days * 86400 * 1000;
        const store = new MemoryStore();
        type Match = { sessionId: string; project: string; mtime: number; matchedFiles: string[]; live?: boolean };
        const matchesById = new Map<string, Match>();

        const needle = params.pattern.toLowerCase();
        try {
          const items = store.listItems('session' as SourceType, 5000, 0);

          for (const item of items) {
            if (item.mtime < cutoff) continue;
            let extra: any = {};
            try { extra = JSON.parse(item.extra_json || '{}'); } catch { /* skip */ }
            const files: string[] = Array.isArray(extra.filesModified) ? extra.filesModified : [];
            const matched = files.filter((f: string) => typeof f === 'string' && f.toLowerCase().includes(needle));
            if (matched.length === 0) continue;
            matchesById.set(item.id, {
              sessionId: item.id,
              project: item.project_path || '(unknown)',
              mtime: item.mtime,
              matchedFiles: matched,
            });
          }
        } finally {
          store.close();
        }

        // Live-scan recent sessions so the active session (and anything else
        // not yet re-indexed) shows up. We cap the time window so we don't
        // sweep the entire archive on every call.
        const liveWindowMs = Math.min(params.since_days, 7) * 86400 * 1000;
        const liveSinceMs = Math.max(cutoff, Date.now() - liveWindowMs);
        try {
          const liveEdits = liveScanRecentEdits({
            sinceMs: liveSinceMs,
            pattern: params.pattern,
          });
          for (const e of liveEdits) {
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
              live: true,
            });
          }
        } catch { /* live scan is best-effort */ }

        const matches = [...matchesById.values()].sort((a, b) => b.mtime - a.mtime);
        const trimmed = matches.slice(0, params.limit);

        if (trimmed.length === 0) {
          return { content: [{ type: 'text', text: `No sessions in the last ${params.since_days} days touched files matching "${params.pattern}".` }] };
        }

        const lines = [`# Files touched: "${params.pattern}" (${matches.length} session${matches.length === 1 ? '' : 's'} in last ${params.since_days}d)\n`];
        for (const m of trimmed) {
          const date = new Date(m.mtime).toISOString().slice(0, 10);
          const tag = m.live ? ' (live)' : '';
          lines.push(`- **${m.sessionId}** ${date}${tag} — ${m.project}`);
          for (const f of m.matchedFiles.slice(0, 5)) lines.push(`  · ${f}`);
          if (m.matchedFiles.length > 5) lines.push(`  · …and ${m.matchedFiles.length - 5} more`);
        }
        return { content: [{ type: 'text', text: withCodeindexHint(lines.join('\n'), 'files') }] };
      }

      // ── Edits timeline (chronological tool_use list across recent sessions) ──
      case 'recall_edits_timeline': {
        const params = RecallEditsTimelineSchema.parse(args);
        const sinceMs = Date.now() - params.since_hours * 3600 * 1000;

        const allEdits = liveScanRecentEdits({
          sinceMs,
          pattern: params.pattern,
          projectFilter: params.project_filter,
          tools: params.tools,
        });

        const filtered: SessionEdit[] = params.include_reads
          ? allEdits
          : allEdits.filter(e => e.op !== 'read');

        if (filtered.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No file edits in the last ${params.since_hours}h` +
                    (params.pattern ? ` matching "${params.pattern}"` : '') +
                    (params.project_filter ? ` in project "${params.project_filter}"` : '') + '.',
            }],
          };
        }

        // Per-tool tally for the header so the agent sees the spread at a glance.
        const byTool: Record<string, number> = {};
        for (const e of filtered) byTool[e.tool] = (byTool[e.tool] || 0) + 1;
        const toolSummary = Object.entries(byTool)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${n} ${k}`).join(' · ');

        const trimmed = filtered.slice(0, params.limit);

        if (params.group_by_repo) {
          // Group every filtered edit (not just the trimmed ones) by detected
          // repo root so the agent sees the full multi-repo footprint.
          const repoCache = new Map<string, string | null>();
          const repos = new Map<string, SessionEdit[]>();
          let unmatched = 0;
          for (const e of filtered) {
            let repo = repoCache.get(e.file);
            if (repo === undefined) { repo = findRepoRoot(e.file); repoCache.set(e.file, repo); }
            if (!repo) { unmatched++; continue; }
            if (!repos.has(repo)) repos.set(repo, []);
            repos.get(repo)!.push(e);
          }
          const sortedRepos = Array.from(repos.entries())
            .sort((a, b) => b[1].length - a[1].length);

          const lines = [
            `# Edits timeline — last ${params.since_hours}h (${filtered.length} edit${filtered.length === 1 ? '' : 's'})`,
            `_${toolSummary}_`,
            `_${sortedRepos.length} repo(s)${unmatched ? ` · ${unmatched} edit(s) outside any git repo` : ''}_`,
            '',
          ];
          for (const [repo, edits] of sortedRepos) {
            const repoName = repo.split('/').filter(Boolean).pop() || repo;
            const limited = edits.slice(0, params.limit);
            lines.push(`## ${repoName}  \`${repo}\` — ${edits.length} edit(s)`);
            lines.push('| Time (UTC) | Tool | Session | Op | File |');
            lines.push('|---|---|---|---|---|');
            for (const e of limited) {
              const ts = (e.tsIso || new Date(e.ts).toISOString()).replace('T', ' ').slice(0, 19);
              const idForDisplay = e.sessionId.replace(/^(opencode_|gemini_)/, '');
              const sid = idForDisplay.slice(0, 8);
              const rel = e.file.startsWith(repo + '/') ? e.file.slice(repo.length + 1) : e.file;
              lines.push(`| ${ts} | ${e.tool} | \`${sid}\` | ${e.op} | ${rel} |`);
            }
            if (edits.length > limited.length) {
              lines.push('');
              lines.push(`…${edits.length - limited.length} more in this repo (raise \`limit\`).`);
            }
            lines.push('');
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const lines = [
          `# Edits timeline — last ${params.since_hours}h (${filtered.length} edit${filtered.length === 1 ? '' : 's'})`,
          `_${toolSummary}_`,
          '',
          '| Time (UTC) | Tool | Session | Op | File | Project |',
          '|---|---|---|---|---|---|',
        ];
        for (const e of trimmed) {
          const ts = (e.tsIso || new Date(e.ts).toISOString()).replace('T', ' ').slice(0, 19);
          // Strip the tool prefix when rendering the session id so the column
          // stays compact — the Tool column already carries that info.
          const idForDisplay = e.sessionId.replace(/^(opencode_|gemini_)/, '');
          const sid = idForDisplay.slice(0, 8);
          lines.push(`| ${ts} | ${e.tool} | \`${sid}\` | ${e.op} | ${e.file} | ${e.projectPath} |`);
        }
        if (filtered.length > trimmed.length) {
          lines.push('');
          lines.push(`…${filtered.length - trimmed.length} more edits truncated (raise \`limit\`).`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── User prompts only ─────────────────────────────────────
      case 'recall_user_prompts': {
        const params = RecallUserPromptsSchema.parse(args);
        const { readdirSync: rd, readFileSync: rf, statSync: st } = await import('fs');
        const projectsRoot = join(homedir(), '.claude', 'projects');

        // Banner stripper mirrors web parser
        const BANNERS = [
          /MCP issues detected\. ?Run \/mcp list for status\.?/g,
          /Context low[^\n]*Run \/compact[^\n]*/g,
          /API Error:[^\n]{0,120}/g,
        ];
        const stripBanners = (s: string) => {
          let out = s;
          for (const re of BANNERS) out = out.replace(re, ' ');
          return out.replace(/[ \t]{2,}/g, ' ').trim();
        };

        const cutoff = Date.now() - params.since_days * 86400 * 1000;
        const candidates: { path: string; sessionId: string; mtime: number }[] = [];
        try {
          for (const proj of rd(projectsRoot, { withFileTypes: true })) {
            if (!proj.isDirectory()) continue;
            const projPath = join(projectsRoot, proj.name);
            let files: string[] = [];
            try { files = rd(projPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }
            for (const f of files) {
              const sessionId = f.replace(/\.jsonl$/i, '');
              if (params.session_id && sessionId !== params.session_id) continue;
              const fp = join(projPath, f);
              try {
                const s = st(fp);
                if (!params.session_id && s.mtimeMs < cutoff) continue;
                candidates.push({ path: fp, sessionId, mtime: s.mtimeMs });
              } catch { /* skip */ }
            }
          }
        } catch { /* projects missing */ }

        candidates.sort((a, b) => b.mtime - a.mtime);
        if (params.session_id && candidates.length === 0) {
          return { content: [{ type: 'text', text: `Session ${params.session_id} not found.` }] };
        }

        type Prompt = { sessionId: string; line: number; ts?: string; text: string };
        const prompts: Prompt[] = [];
        outer: for (const c of candidates) {
          let lineNo = 0;
          for (const raw of rf(c.path, 'utf-8').split('\n')) {
            lineNo++;
            if (!raw.trim()) continue;
            try {
              const obj = JSON.parse(raw);
              if (obj?.type !== 'user') continue;
              const content = obj.message?.content;
              let text = '';
              if (typeof content === 'string') text = content;
              else if (Array.isArray(content)) {
                text = content
                  .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
                  .map((b: any) => b.text)
                  .join('\n');
              }
              text = stripBanners(text);
              if (!text) continue;
              prompts.push({ sessionId: c.sessionId, line: lineNo, ts: obj.timestamp, text });
              if (prompts.length >= params.limit) break outer;
            } catch { /* skip malformed line */ }
          }
        }

        if (prompts.length === 0) {
          return { content: [{ type: 'text', text: 'No user prompts found.' }] };
        }
        const lines = [`# User prompts (${prompts.length})\n`];
        for (const p of prompts) {
          const t = p.ts?.slice(0, 16).replace('T', ' ') || '';
          const snippet = p.text.length > 240 ? p.text.slice(0, 240) + '…' : p.text;
          let markerSuffix = '';
          if (params.with_markers) {
            const m = markPrompt(p.text);
            if (m.markers.length) markerSuffix = ` _[${m.markers.join(', ')}]_`;
          }
          lines.push(`- **${p.sessionId}** L${p.line}${t ? ` · ${t}` : ''}${markerSuffix}`);
          lines.push(`  ${snippet.replace(/\n/g, ' ')}`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── Decision recording ────────────────────────────────────
      case 'recall_decision_record': {
        const params = RecallDecisionRecordSchema.parse(args);
        const wal = getWAL();
        wal.log('decision_record', { subject: params.subject, importance: params.importance });

        // 1) Knowledge-graph triple — durable, queryable, time-validated
        const kg = new KnowledgeGraph();
        try {
          kg.addTriple(params.subject, 'decided', params.decision, {
            confidence: Math.min(1, params.importance / 5),
            sourceSession: params.session_id,
          });
          if (params.reason) {
            kg.addTriple(params.subject, 'because', params.reason, {
              confidence: Math.min(1, params.importance / 5),
              sourceSession: params.session_id,
            });
          }
        } finally {
          kg.close();
        }

        // 2) Diary entry — readable narrative for the agent's own future reads
        const diaryText = params.reason
          ? `Decided: ${params.decision}\nSubject: ${params.subject}\nWhy: ${params.reason}`
          : `Decided: ${params.decision}\nSubject: ${params.subject}`;
        const entryId = DiarySource.write({
          agent: params.agent_name,
          topic: 'decision',
          content: diaryText,
          timestamp: new Date().toISOString(),
          sessionId: params.session_id,
        });

        return {
          content: [{
            type: 'text',
            text: `Decision recorded.\n- KG: ${params.subject} → decided → ${params.decision}\n- Diary entry: ${entryId} (importance ${params.importance})`,
          }],
        };
      }

      // ── Analytics summary ──────────────────────────────────────
      case 'recall_analytics_summary': {
        RecallAnalyticsSummarySchema.parse(args);

        // Pricing for known Claude models. Mirrors web/server analytics.
        // Models we don't have published prices for (Gemini, Ollama, custom)
        // are tracked in `noPricing` so we never fabricate dollars.
        const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
          'claude-opus-4-6':   { input: 15,  output: 75, cacheRead: 1.5 },
          'claude-sonnet-4-6': { input: 3,   output: 15, cacheRead: 0.3 },
          'claude-haiku-4-5':  { input: 0.8, output: 4,  cacheRead: 0.08 },
          'claude-sonnet-4-5': { input: 3,   output: 15, cacheRead: 0.3 },
        };
        const priceFor = (m: string) => {
          if (!m || m === '<synthetic>') return null;
          if (PRICING[m]) return PRICING[m];
          for (const [k, v] of Object.entries(PRICING)) if (m.startsWith(k)) return v;
          return null;
        };

        const store = new MemoryStore();
        try {
          const items = store.listItems('session' as SourceType, 5000, 0);
          let totalSessions = 0;
          let totalCost = 0;
          let sessionsWithoutPricing = 0;
          const projectCost = new Map<string, number>();
          const projectSessions = new Map<string, number>();
          const toolCount = new Map<string, number>();
          const modelCount = new Map<string, number>();
          let weekNow = 0;
          let weekPrev = 0;

          const now = Date.now();
          const weekMs = 7 * 86400 * 1000;

          for (const item of items) {
            totalSessions++;
            let extra: any = {};
            try { extra = JSON.parse(item.extra_json || '{}'); } catch {}
            const models: string[] = (extra.modelsUsed || []).filter((m: string) => m && m !== '<synthetic>');
            let pricing: ReturnType<typeof priceFor> = null;
            for (const m of models) { pricing = priceFor(m); if (pricing) break; }

            let cost = 0;
            if (pricing) {
              const input = extra.inputTokens || 0;
              const output = extra.outputTokens || 0;
              const cacheRead = extra.cacheReadTokens || 0;
              const cacheCreate = extra.cacheCreationTokens || 0;
              const nonCached = Math.max(0, input - cacheRead - cacheCreate);
              cost = (nonCached / 1e6) * pricing.input
                   + (output / 1e6) * pricing.output
                   + (cacheRead / 1e6) * pricing.cacheRead
                   + (cacheCreate / 1e6) * (pricing.input * 1.25);
            } else {
              sessionsWithoutPricing++;
            }
            totalCost += cost;

            const proj = item.project_path?.split('/').pop() || item.project_path || '(unknown)';
            projectCost.set(proj, (projectCost.get(proj) || 0) + cost);
            projectSessions.set(proj, (projectSessions.get(proj) || 0) + 1);

            for (const t of (extra.toolsUsed || [])) toolCount.set(t, (toolCount.get(t) || 0) + 1);
            for (const m of models) modelCount.set(m, (modelCount.get(m) || 0) + 1);

            const age = now - item.mtime;
            if (age >= 0 && age < weekMs) weekNow += cost;
            else if (age < 2 * weekMs) weekPrev += cost;
          }
          const priced = totalSessions - sessionsWithoutPricing;

          const topByCost = [...projectCost.entries()]
            .sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([name, cost]) => `  ${name.padEnd(28)} $${cost.toFixed(2).padStart(8)}  (${projectSessions.get(name)} sessions)`);
          const topTools = [...toolCount.entries()]
            .sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([name, n]) => `  ${name.padEnd(15)} ${n}`);
          const topModels = [...modelCount.entries()]
            .sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([name, n]) => `  ${name.padEnd(35)} ${n} sessions`);

          const delta = weekPrev > 0 ? ((weekNow - weekPrev) / weekPrev) * 100 : null;
          const deltaStr = delta === null
            ? '(no prior-week data)'
            : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% vs last week`;

          const lines = [
            '# Analytics Summary',
            '',
            `**Total sessions:** ${totalSessions}`,
            `**Total cost (priced):** $${totalCost.toFixed(2)}`,
            `**Avg / priced session:** $${priced > 0 ? (totalCost / priced).toFixed(2) : '0.00'}`,
            `**Sessions without pricing:** ${sessionsWithoutPricing} (Gemini / Ollama / custom — cost not estimated)`,
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
        } finally {
          store.close();
        }
      }

      // ── Similar sessions ───────────────────────────────────────
      case 'recall_similar_sessions': {
        const params = RecallSimilarSessionsSchema.parse(args);

        // Resolve search text: either the explicit query, or the first user
        // prompt of the referenced session.
        let searchText = params.query ?? '';
        let excludeSessionId: string | undefined;
        if (params.session_id) {
          excludeSessionId = params.session_id;
          const store = new MemoryStore();
          try {
            const item = store.getItem(params.session_id, 'session' as SourceType);
            if (!item) {
              return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
            }
            try {
              const extra = JSON.parse(item.extra_json || '{}');
              searchText = extra.firstPrompt || extra.contentPreview || item.content_preview || item.title || '';
            } catch { searchText = item.content_preview || item.title || ''; }
          } finally { store.close(); }
        }
        if (!searchText.trim()) {
          return { content: [{ type: 'text', text: 'No search text could be derived. Provide `query` or a session_id with prompt content.' }] };
        }

        // Sanitize then search across sessions only.
        const cleaned = sanitizeQuery(searchText).cleanQuery;
        const provider = (process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider;
        let embedder: Awaited<ReturnType<typeof getEmbedder>> | null = null;
        try { embedder = getEmbedder(provider); } catch { embedder = null; }

        const memoryIndex = new MemoryIndex(embedder);
        const raw = await memoryIndex.search(cleaned, {
          topK: params.top_k * 4,
          sourceTypes: ['session'],
          projectFilter: params.project_filter,
        });

        const filtered = raw.filter(r => r.itemId !== excludeSessionId);
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
          embedder ? '_Vector match._' : '_Keyword match (no embedder configured — install Ollama or set OPENAI_API_KEY for semantic clustering)._',
          '',
        ];
        for (const r of trimmed) {
          const date = new Date(r.mtime).toISOString().slice(0, 10);
          const proj = (r.projectPath || '').split('/').slice(-2).join('/') || '(unknown)';
          const snippet = (r.matchedChunks?.[0]?.text || r.title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
          lines.push(`- **${r.itemId.slice(0, 8)}** · ${proj} · ${date} · score ${r.score.toFixed(3)}`);
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
        const store = new MemoryStore();
        let projectPath = '';
        let files: string[] = [];
        let tools: string[] = [];
        let source: 'index' | 'live' = 'index';

        try {
          const item = store.getItem(params.session_id, 'session' as SourceType);
          if (item) {
            projectPath = item.project_path || '';
            try {
              const extra = JSON.parse(item.extra_json || '{}');
              if (Array.isArray(extra.filesModified)) files = extra.filesModified;
              if (Array.isArray(extra.toolsUsed)) tools = extra.toolsUsed;
            } catch { /* ignore corrupt json */ }
          }
        } finally { store.close(); }

        // Fall back to a live transcript scan when the metadata is empty.
        // This is exactly the gap the user hit on an active session — the
        // indexer hasn't run yet, but the .jsonl on disk already has tool_use
        // blocks we can read.
        if (files.length === 0) {
          const live = liveScanModifiedFiles(params.session_id);
          if (!live.found) {
            return { content: [{ type: 'text', text: `Session not found: ${params.session_id}` }] };
          }
          if (live.files.length === 0 && live.reads.length === 0) {
            return {
              content: [{
                type: 'text',
                text: `Session ${params.session_id} exists but no file activity is recorded yet ` +
                      `(no Edit/Write/MultiEdit/NotebookEdit tool_uses found in the transcript).`,
              }],
            };
          }
          files = live.files;
          tools = [...new Set(live.edits.map(e => e.toolName))];
          if (!projectPath) projectPath = live.projectPath;
          source = 'live';
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
          `**Source:** ${source === 'live' ? 'live transcript scan (session not yet re-indexed)' : 'indexed metadata'}`,
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
        const targetBase = target.split('/').pop() || target;
        const targetStem = targetBase.replace(/\.[^.]+$/, '').toLowerCase();

        const store = new MemoryStore();
        try {
          const items = store.listItems('session' as SourceType, 5000, 0);
          // Score each historical filename: exact-basename > stem-match > path-overlap.
          type Hit = {
            file: string; sessionId: string; project: string; mtime: number; score: number; reason: string;
          };
          const hits: Hit[] = [];

          for (const item of items) {
            if (params.project_path && !item.project_path?.includes(params.project_path)) continue;
            let extra: any = {};
            try { extra = JSON.parse(item.extra_json || '{}'); } catch {}
            const files: string[] = Array.isArray(extra.filesModified) ? extra.filesModified : [];

            for (const f of files) {
              const fbase = f.split('/').pop() || f;
              const fstem = fbase.replace(/\.[^.]+$/, '').toLowerCase();
              let score = 0;
              let reason = '';
              // Substring matching only kicks in when both stems are at least
              // 4 chars — otherwise dotfiles like ".env" match everything via
              // `"foo".includes("")` (empty string is a substring of every string).
              const stemsMatchable = fstem.length >= 4 && targetStem.length >= 4;
              if (fbase === targetBase)        { score = 1.0; reason = 'exact basename match'; }
              else if (fstem === targetStem)   { score = 0.85; reason = 'same name, different extension'; }
              else if (stemsMatchable && (fstem.includes(targetStem) || targetStem.includes(fstem))) {
                                                 score = 0.6; reason = 'stem substring match'; }
              else if (target.includes('/') && f.includes(target.split('/').slice(0, -1).join('/'))) {
                                                 score = 0.4; reason = 'same directory'; }
              if (score > 0) {
                hits.push({
                  file: f,
                  sessionId: item.id,
                  project: item.project_path || '(unknown)',
                  mtime: item.mtime,
                  score,
                  reason,
                });
              }
            }
          }

          // Dedup by file path (we want the most-recent session that touched it).
          const byFile = new Map<string, Hit>();
          for (const h of hits) {
            const cur = byFile.get(h.file);
            if (!cur || h.mtime > cur.mtime || h.score > cur.score) byFile.set(h.file, h);
          }
          const ranked = [...byFile.values()]
            .sort((a, b) => b.score - a.score || b.mtime - a.mtime)
            .slice(0, params.limit);

          if (ranked.length === 0) {
            return {
              content: [{
                type: 'text',
                text: `No similar filenames found in indexed sessions for "${target}".\n\n` +
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

          // Append the codeindex composition hint only when it's actually
          // installed — keeps the output honest when the user has only chat-recall.
          return { content: [{ type: 'text', text: withCodeindexHint(lines.join('\n'), 'redundancy') }] };
        } finally { store.close(); }
      }

      // ── KV store ───────────────────────────────────────────────
      case 'recall_set': {
        const params = RecallSetSchema.parse(args);
        const wal = getWAL();
        wal.log('kv_set', { scope: params.scope, key: params.key });

        const store = new MemoryStore();
        try { store.kvSet(params.scope, params.key, params.value); }
        finally { store.close(); }

        return { content: [{ type: 'text', text: `Set ${params.scope}:${params.key} (${params.value.length} chars)` }] };
      }

      case 'recall_get': {
        const params = RecallGetSchema.parse(args);
        const store = new MemoryStore();
        try {
          const row = store.kvGet(params.scope, params.key);
          if (!row) return { content: [{ type: 'text', text: `(no value at ${params.scope}:${params.key})` }] };
          const ago = Math.floor((Date.now() - row.updated_at) / 1000);
          return {
            content: [{
              type: 'text',
              text: `${params.scope}:${params.key} (set ${ago}s ago)\n\n${row.value}`,
            }],
          };
        } finally { store.close(); }
      }

      case 'recall_kv_list': {
        const params = RecallKvListSchema.parse(args);
        const store = new MemoryStore();
        try {
          const rows = store.kvList(params.scope, params.limit);
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
        } finally { store.close(); }
      }

      // ── Wake-up context ────────────────────────────────────────
      case 'recall_wake_up': {
        const params = RecallWakeUpSchema.parse(args);

        // Identity: param > file > default. The file lets users seed a stable
        // self-description that survives across sessions ("I'm Adi's coding agent…").
        let identity = params.identity ?? 'AI coding assistant';
        if (!params.identity) {
          const idFile = join(homedir(), '.claude', 'chat-recall-identity.txt');
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

        // High-importance facts the classifier already tagged during indexing.
        const store = new MemoryStore();
        try {
          const hits = store.searchFTS('decision preference milestone', { topK: 60 });
          const high = hits
            .filter(r => r.chunkType.includes(':imp4') || r.chunkType.includes(':imp5'))
            .slice(0, params.max_facts);
          if (high.length > 0) {
            lines.push('## High-importance facts');
            for (const c of high) {
              const m = c.chunkType.match(/:(\w+):imp/);
              const t = c.text.replace(/\n/g, ' ').trim().slice(0, 150);
              lines.push(`  [${m?.[1] ?? 'fact'}] ${t}`);
            }
            lines.push('');
          }
        } finally {
          store.close();
        }

        // Currently-valid KG facts (temporal validity respected by KG.timeline).
        try {
          const kg = new KnowledgeGraph();
          try {
            const stats = kg.stats();
            if (stats.current_facts > 0) {
              const tl = kg.timeline(undefined, 50).filter(e => e.current).slice(0, params.max_kg_facts);
              if (tl.length > 0) {
                lines.push('## Knowledge graph (current facts)');
                lines.push(`  ${stats.entities} entities, ${stats.current_facts} current facts`);
                for (const f of tl) lines.push(`  ${f.subject} → ${f.predicate} → ${f.object}`);
                lines.push('');
              }
            }
          } finally {
            kg.close();
          }
        } catch { /* KG unavailable */ }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err}` }] };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
