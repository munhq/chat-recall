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

import { getEmbedder, type EmbedderProvider } from './core/embedder.js';
import { getRecentSessions, extractConversationContext, formatContext } from './core/context.js';
import { parseSessionFile } from './parsers/session.js';
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
import { MetadataCache } from './core/metadata-cache.js';
import { KnowledgeGraph } from './core/knowledge-graph.js';
import { classifyChunk } from './core/memory-classifier.js';
import { extractAndPopulateKG } from './core/entity-extractor.js';
import { sanitizeQuery } from './core/query-sanitizer.js';
import { getWAL } from './core/write-ahead-log.js';
import { DiarySource } from './parsers/diary-source.js';
import type { SourceType } from './types/memory.js';

// Load .env configuration
config();

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
});

const RecallRecentSchema = z.object({
  project_filter: z.string().optional().describe('Filter by project name (e.g., "acme", "poly")'),
  limit: z.number().optional().default(10).describe('Number of recent sessions to show'),
});

const RecallContextSchema = z.object({
  session_id: z.string().describe('Session ID to get context from'),
});

const RecallSummarySchema = z.object({
  session_id: z.string().describe('Session ID to get summary for'),
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

Use this after recall_search to get full context from a session.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from search results' },
            around_line: { type: 'number', description: 'Optional line number to show context around' },
            max_messages: { type: 'number', default: 10, description: 'Maximum messages to return' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'recall_recent',
        description: `List recent Claude Code sessions.

Shows your most recent conversations across all projects or filtered by project.
Use this when the user says "continue our last conversation" or wants to see recent work.`,
        inputSchema: {
          type: 'object',
          properties: {
            project_filter: { type: 'string', description: 'Filter by project name (e.g., "acme", "poly")' },
            limit: { type: 'number', default: 10, description: 'Number of recent sessions to show' },
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
        description: `Get the AI-generated summary for a specific session.

Returns the Gemini-generated summary that includes:
- What was requested
- The plan/approach
- What was accomplished
- What remains to be done

Use this for a quick overview before deciding to resume a conversation.`,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID to get summary for' },
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
        registry.register(new DiarySource());

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
                        text = text.replace(/```[\s\S]*?```/g, '[code block]');
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
        
        if (params.around_line) {
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
        
        // Format output
        const output = [`Session: ${params.session_id}\n`];
        
        for (const msg of displayMessages) {
          output.push(`**${msg.role}** (line ${msg.line})`);
          let text = msg.text;
          if (text.length > 1500) {
            text = text.slice(0, 1500) + '...';
          }
          output.push(text);
          output.push('');
        }
        
        output.push(`Resume: claude --resume ${params.session_id}`);
        
        return { content: [{ type: 'text', text: output.join('\n') }] };
      }

      case 'recall_recent': {
        const params = RecallRecentSchema.parse(args);

        const sessions = getRecentSessions(params.project_filter, params.limit);

        if (sessions.length === 0) {
          return { content: [{ type: 'text', text: 'No recent sessions found.' }] };
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

        return { content: [{ type: 'text', text: formatted }] };
      }

      case 'recall_summary': {
        const params = RecallSummarySchema.parse(args);

        // Try to get summary from metadata cache
        const Database = (await import('better-sqlite3')).default;
        const cacheDb = new Database(join(homedir(), '.claude', 'chat-recall-cache.db'), { readonly: true });

        try {
          const row = cacheDb.prepare('SELECT summary, summary_source FROM session_metadata WHERE session_id = ?').get(params.session_id) as { summary: string; summary_source: string } | undefined;

          if (!row) {
            return { content: [{ type: 'text', text: `No summary found for session: ${params.session_id}\n\nRun 'npm run generate-summaries' to generate summaries.` }] };
          }

          const output = [
            `# 📋 Summary`,
            '',
            `**Session:** ${params.session_id.substring(0, 8)}...`,
            `**Source:** ${row.summary_source}`,
            '',
            '---',
            '',
            row.summary,
            '',
            '---',
            '',
            `**🔄 Resume:** \`claude --resume ${params.session_id}\``,
          ];

          return { content: [{ type: 'text', text: output.join('\n') }] };
        } finally {
          cacheDb.close();
        }
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
