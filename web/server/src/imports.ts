/**
 * Re-exports from the root chat-recall source.
 *
 * Single point of contact for the ../../../src/ relative path.
 * All web server files should import from here instead of
 * using deep relative paths directly.
 */

// Core
export { MemoryIndex, type MemoryChunkRecord } from '../../../src/core/memory-index.js';
export { MemoryStore } from '../../../src/core/memory-store.js';
// Storage-flag drivers (sqlite|postgres) — routes/services should prefer these
// async factories over instantiating the concrete classes directly.
export { createStore, type StorageDriver } from '../../../src/core/store/index.js';
export { createVectorStore, type VectorStore } from '../../../src/core/store/vector.js';
export { createMetadataCache, createOutcomeCache, type MetadataCacheDriver, type OutcomeCacheDriver } from '../../../src/core/store/caches.js';
export { createKnowledgeGraph, type KnowledgeGraphDriver } from '../../../src/core/store/knowledge-graph.js';
// Re-export the row type so route files can use it without deep paths.
export {
  OllamaEmbedder,
  GeminiEmbedder,
  OpenAICompatibleEmbedder,
  OPENAI_COMPAT_PRESETS,
  getEmbedder,
  type Embedder,
  type EmbedderProvider,
} from '../../../src/core/embedder.js';
export { SourceRegistry } from '../../../src/core/source-registry.js';
export { MetadataCache } from '../../../src/core/metadata-cache.js';
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
} from '../../../src/core/settings.js';

// Parsers
export { getAllSessions, parseSessionFile, type SessionEntry, type SessionMetadata } from '../../../src/parsers/session.js';

// Cheap first-prompt extractor (used as fallback when sessions-index.json is missing)
export { extractFirstUserPromptSync } from '../../../src/core/first-prompt.js';

// Display helpers shared between MCP and web
export { tierFor, tierAll, type ScoreTier } from '../../../src/core/score-tier.js';
export { statusEmoji, outcomeOneLiner, outcomeBadge } from '../../../src/core/outcome-display.js';
export { quickOutcomeStatus, quickStatusEmoji, quickOutcomeFromMtime, type QuickOutcomeStatus, type QuickOutcome } from '../../../src/core/quick-outcome.js';
export { detectTool, type AiTool } from '../../../src/core/live-session-scan.js';
export {
  OutcomeCache,
  isFresh,
  fingerprintFile,
  type CachedOutcome,
  type CachedOutcomeStatus,
} from '../../../src/core/outcome-cache.js';

// Live transcript scanning (for the active session and anything not yet re-indexed)
export {
  liveScanModifiedFiles,
  liveScanRecentEdits,
  liveScanSessionEdits,
  findCodexSessionFile,
  type SessionEdit,
} from '../../../src/core/live-session-scan.js';
// Cache-first timeline (Activity tab) — reads compute_cache[diff] when fresh.
export { cachedRecentEdits } from '../../../src/core/cached-timeline.js';
export {
  extractTurnsAny,
  replaySessionAny,
} from '../../../src/core/session-multi-tool.js';
// ToolBackend registry — single source of truth for per-tool paths,
// id prefixes, format adapters, and per-session operations.
export {
  claudeBackend,
  geminiBackend,
  opencodeBackend,
  codexBackend,
} from '../../../src/core/backends/index.js';
export {
  getBackendForId,
  getBackend,
  listAllBackends,
  listAvailableBackends,
} from '../../../src/core/tool-backend.js';
export {
  claudeHomeDir,
  geminiHomeDir,
  opencodeDbPath,
  codexHomeDir,
} from '../../../src/core/tool-paths.js';

// Session replay / git / sentiment / outcome (per-session deep-dive).
// Use `replaySessionAny` for the registry-routed version that works
// across every backend.
export {
  findRepoRoot,
  type SessionDiffResult,
  type FileReplayResult,
  type FileEditEvent,
} from '../../../src/core/session-replay.js';
export {
  getSessionCommits,
  groupFilesByRepo,
  type SessionCommit,
  type SessionCommitsResult,
} from '../../../src/core/session-git.js';
export {
  markPrompt,
  summarizeMarkers,
  type PromptMarker,
  type MarkedPrompt,
  type SessionMarkerCounts,
} from '../../../src/core/session-sentiment.js';
export {
  type SessionTurn,
  type TurnKind,
  type ExtractedTurns,
} from '../../../src/core/session-turns.js';
export {
  computeOutcome,
  type SessionOutcome,
  type SessionStatus,
  type SessionDecision,
  type SessionBlocker,
  type ClaimReactionPair,
} from '../../../src/core/session-outcome.js';
export { SessionSource } from '../../../src/parsers/session-source.js';
export { PlanSource } from '../../../src/parsers/plan-source.js';
export { TaskSource } from '../../../src/parsers/task-source.js';
export { ClaudeMdSource } from '../../../src/parsers/claude-md-source.js';
export { HistorySource } from '../../../src/parsers/history-source.js';
export { PasteSource } from '../../../src/parsers/paste-source.js';
export { GeminiSessionSource } from '../../../src/parsers/gemini-source.js';
export { GeminiBrainSource } from '../../../src/parsers/gemini-brain-source.js';
export { OpenCodeSource } from '../../../src/parsers/opencode-source.js';
export { OpenCodeTodoSource } from '../../../src/parsers/opencode-todo-source.js';
export { DiarySource } from '../../../src/parsers/diary-source.js';
export { SkillsSource } from '../../../src/parsers/skills-source.js';
export { McpsSource } from '../../../src/parsers/mcps-source.js';
export { SlashCommandsSource } from '../../../src/parsers/slash-commands-source.js';
export { SubagentsSource } from '../../../src/parsers/subagents-source.js';
export { HooksSource } from '../../../src/parsers/hooks-source.js';
export { PluginsSource } from '../../../src/parsers/plugins-source.js';


// Summary
export { CLI_PRESETS as SUMMARY_CLI_PRESET_COMMANDS, SummaryGenerator, defaultApiBaseUrl } from '../../../src/core/summary-generator.js';

// Core (new features)
export { KnowledgeGraph } from '../../../src/core/knowledge-graph.js';
export { sanitizeQuery } from '../../../src/core/query-sanitizer.js';
export { getWAL } from '../../../src/core/write-ahead-log.js';
export { classifyChunk, type MemoryType, type ClassificationResult } from '../../../src/core/memory-classifier.js';
export { extractEntities, extractAndPopulateKG } from '../../../src/core/entity-extractor.js';
export {
  resolveProjectId,
  resolveWorkspaceId,
  loadProjectsConfig,
  getProjectsConfigPath,
  resetProjectResolverCache,
} from '../../../src/core/project-resolver.js';
export { buildProjectDossier } from '../../../src/core/project-dossier.js';
export type {
  DeclaredProject,
  DeclaredSubProject,
  ProjectsConfig,
  ResolvedProject,
} from '../../../src/types/project.js';

// Types
export type {
  SourceType,
  MemorySearchResult,
  MemoryMetadataRow,
  MemoryLinkRow,
} from '../../../src/types/memory.js';
export { CodexSessionSource } from '../../../src/parsers/codex-session-source.js';
