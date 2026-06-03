/**
 * @chat-recall/engine — public API barrel (MIT).
 * Superset consumed by @chat-recall/cli and @chat-recall/server.
 */
// Core
export { MemoryIndex, type MemoryChunkRecord } from './core/memory-index.js';
export { MemoryStore } from './core/memory-store.js';
// Storage-flag drivers (sqlite|postgres) — routes/services should prefer these
// async factories over instantiating the concrete classes directly.
export { createStore, type StorageDriver } from './core/store/index.js';
export { createVectorStore, type VectorStore } from './core/store/vector.js';
export { createMetadataCache, createOutcomeCache, type MetadataCacheDriver, type OutcomeCacheDriver } from './core/store/caches.js';
export { createKnowledgeGraph, type KnowledgeGraphDriver } from './core/store/knowledge-graph.js';
// Re-export the row type so route files can use it without deep paths.
export {
  OllamaEmbedder,
  GeminiEmbedder,
  OpenAICompatibleEmbedder,
  OPENAI_COMPAT_PRESETS,
  getEmbedder,
  type Embedder,
  type EmbedderProvider,
} from './core/embedder.js';
export { SourceRegistry } from './core/source-registry.js';
export { MetadataCache } from './core/metadata-cache.js';
export {
  loadSettings,
  saveSettings,
  redactSettings,
  mergeSettings,
  applySettingsToEnv,
  type AppSettings,
  type EmbeddingSettings,
  type SummarySettings,
  type SummaryProvider,
} from './core/settings.js';

// Parsers
export { getAllSessions, parseSessionFile, type SessionEntry, type SessionMetadata } from './parsers/session.js';

// Cheap first-prompt extractor (used as fallback when sessions-index.json is missing)
export { extractFirstUserPromptSync } from './core/first-prompt.js';

// Display helpers shared between MCP and web
export { tierFor, tierAll, type ScoreTier } from './core/score-tier.js';
export { statusEmoji, outcomeOneLiner, outcomeBadge } from './core/outcome-display.js';
export { quickOutcomeStatus, quickStatusEmoji, quickOutcomeFromMtime, type QuickOutcomeStatus, type QuickOutcome } from './core/quick-outcome.js';
export { detectTool, type AiTool } from './core/live-session-scan.js';
export {
  OutcomeCache,
  isFresh,
  fingerprintFile,
  type CachedOutcome,
  type CachedOutcomeStatus,
} from './core/outcome-cache.js';

// Live transcript scanning (for the active session and anything not yet re-indexed)
export {
  liveScanModifiedFiles,
  liveScanRecentEdits,
  liveScanSessionEdits,
  findCodexSessionFile,
  type SessionEdit,
} from './core/live-session-scan.js';
// Cache-first timeline (Activity tab) — reads compute_cache[diff] when fresh.
export { cachedRecentEdits } from './core/cached-timeline.js';
export {
  extractTurnsAny,
  replaySessionAny,
} from './core/session-multi-tool.js';
// ToolBackend registry — single source of truth for per-tool paths,
// id prefixes, format adapters, and per-session operations.
export {
  claudeBackend,
  geminiBackend,
  opencodeBackend,
  codexBackend,
} from './core/backends/index.js';
export {
  getBackendForId,
  getBackend,
  listAllBackends,
  listAvailableBackends,
} from './core/tool-backend.js';
export {
  claudeHomeDir,
  geminiHomeDir,
  opencodeDbPath,
  codexHomeDir,
} from './core/tool-paths.js';

// Session replay / git / sentiment / outcome (per-session deep-dive).
// Use `replaySessionAny` for the registry-routed version that works
// across every backend.
export {
  findRepoRoot,
  type SessionDiffResult,
  type FileReplayResult,
  type FileEditEvent,
} from './core/session-replay.js';
export {
  getSessionCommits,
  groupFilesByRepo,
  type SessionCommit,
  type SessionCommitsResult,
} from './core/session-git.js';
export {
  markPrompt,
  summarizeMarkers,
  type PromptMarker,
  type MarkedPrompt,
  type SessionMarkerCounts,
} from './core/session-sentiment.js';
export {
  type SessionTurn,
  type TurnKind,
  type ExtractedTurns,
} from './core/session-turns.js';
export {
  computeOutcome,
  type SessionOutcome,
  type SessionStatus,
  type SessionDecision,
  type SessionBlocker,
  type ClaimReactionPair,
} from './core/session-outcome.js';
export { SessionSource } from './parsers/session-source.js';
export { PlanSource } from './parsers/plan-source.js';
export { TaskSource } from './parsers/task-source.js';
export { ClaudeMdSource } from './parsers/claude-md-source.js';
export { HistorySource } from './parsers/history-source.js';
export { PasteSource } from './parsers/paste-source.js';
export { GeminiSessionSource } from './parsers/gemini-source.js';
export { GeminiBrainSource } from './parsers/gemini-brain-source.js';
export { OpenCodeSource } from './parsers/opencode-source.js';
export { OpenCodeTodoSource } from './parsers/opencode-todo-source.js';
export { DiarySource } from './parsers/diary-source.js';
export { SkillsSource } from './parsers/skills-source.js';
export { McpsSource } from './parsers/mcps-source.js';
export { SlashCommandsSource } from './parsers/slash-commands-source.js';
export { SubagentsSource } from './parsers/subagents-source.js';
export { HooksSource } from './parsers/hooks-source.js';
export { PluginsSource } from './parsers/plugins-source.js';


// Summary
export { CLI_PRESETS as SUMMARY_CLI_PRESET_COMMANDS, SummaryGenerator, defaultApiBaseUrl } from './core/summary-generator.js';

// Core (new features)
export { KnowledgeGraph } from './core/knowledge-graph.js';
export { sanitizeQuery } from './core/query-sanitizer.js';
export { getWAL } from './core/write-ahead-log.js';
export { classifyChunk, type MemoryType, type ClassificationResult } from './core/memory-classifier.js';
export { extractEntities, extractAndPopulateKG } from './core/entity-extractor.js';
export {
  resolveProjectId,
  resolveWorkspaceId,
  loadProjectsConfig,
  getProjectsConfigPath,
  resetProjectResolverCache,
} from './core/project-resolver.js';
export { buildProjectDossier } from './core/project-dossier.js';
export type {
  DeclaredProject,
  DeclaredSubProject,
  ProjectsConfig,
  ResolvedProject,
} from './types/project.js';

// Types
export type {
  SourceType,
  MemorySearchResult,
  MemoryMetadataRow,
  MemoryLinkRow,
} from './types/memory.js';
export { CodexSessionSource } from './parsers/codex-session-source.js';
