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
export { OllamaEmbedder } from '../../../src/core/embedder.js';
export { SourceRegistry } from '../../../src/core/source-registry.js';
export { MetadataCache } from '../../../src/core/metadata-cache.js';

// Parsers
export { getAllSessions, parseSessionFile, type SessionEntry, type SessionMetadata } from '../../../src/parsers/session.js';
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

// Core (new features)
export { KnowledgeGraph } from '../../../src/core/knowledge-graph.js';
export { sanitizeQuery } from '../../../src/core/query-sanitizer.js';
export { getWAL } from '../../../src/core/write-ahead-log.js';
export { classifyChunk, type MemoryType, type ClassificationResult } from '../../../src/core/memory-classifier.js';
export { extractEntities, extractAndPopulateKG } from '../../../src/core/entity-extractor.js';

// Types
export type {
  SourceType,
  MemorySearchResult,
  MemoryMetadataRow,
  MemoryLinkRow,
} from '../../../src/types/memory.js';
