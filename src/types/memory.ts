/**
 * Shared types for the unified memory system.
 *
 * The memory system extends chat-recall from session-only indexing to a
 * unified system that indexes plans, tasks, CLAUDE.md files, paste cache,
 * and history - with proper relationships between them.
 */

/** All supported memory source types */
export type SourceType = 'session' | 'plan' | 'task' | 'claude_md' | 'paste' | 'history' | 'diary';

/** A single discoverable item from a data source */
export interface MemoryItem {
  /** Unique identifier for this item (e.g. session ID, file path hash) */
  id: string;
  /** Which source type this item belongs to */
  sourceType: SourceType;
  /** Human-readable title */
  title: string;
  /** Associated project path (if any) */
  projectPath: string;
  /** File path on disk */
  filePath: string;
  /** File modification time (ms since epoch) */
  mtime: number;
  /** Optional preview of the content */
  contentPreview?: string;
  /** Extra metadata as JSON-serializable object */
  extra?: Record<string, unknown>;
}

/** A chunk of embeddable text derived from a MemoryItem */
export interface MemoryChunk {
  /** Unique chunk ID (item_id + chunk_type + index) */
  chunkId: string;
  /** ID of the parent MemoryItem */
  itemId: string;
  /** Source type from parent */
  sourceType: SourceType;
  /** Human-readable title from parent */
  title: string;
  /** The text content to embed */
  text: string;
  /** Classification of the chunk content */
  chunkType: string;
  /** Associated project path */
  projectPath: string;
  /** File path on disk */
  filePath: string;
  /** File modification time (ms since epoch) */
  mtime: number;
}

/** Relationship link types between memory items */
export type LinkType =
  | 'task_in_session'      // Task UUID folder = Session ID
  | 'history_for_session'  // history.jsonl sessionId field
  | 'history_has_paste'    // contentHash -> paste-cache file
  | 'claude_md_for_project' // CLAUDE.md in project directory
  | 'plan_for_project'     // Plan references project file paths
  | 'agent_plan_for_session' // Agent plan filename contains session hash
  | 'brain_artifact_for_session' // Gemini brain artifact linked to session
  | 'diary_for_session'; // Agent diary entry linked to session

/** A discovered relationship between two memory items */
export interface MemoryLink {
  /** Source type of the linking item */
  sourceType: SourceType;
  /** ID of the source item */
  sourceId: string;
  /** Target source type */
  targetType: SourceType;
  /** ID of the target item */
  targetId: string;
  /** Type of the relationship */
  linkType: LinkType;
  /** Confidence of the link (0.0 - 1.0) */
  confidence: number;
}

/** A single result from unified memory search */
export interface MemorySearchResult {
  /** Item ID */
  itemId: string;
  /** Source type */
  sourceType: SourceType;
  /** Human-readable title */
  title: string;
  /** Best matching text */
  text: string;
  /** Similarity score (0-1) */
  score: number;
  /** Chunk type of best match */
  chunkType: string;
  /** Associated project path */
  projectPath: string;
  /** File path */
  filePath: string;
  /** File modification time */
  mtime: number;
  /** Top matched chunks */
  matchedChunks: Array<{
    chunkType: string;
    text: string;
    score: number;
  }>;
}

/** Stored metadata for a memory item (SQLite row) */
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

/** Stored link between memory items (SQLite row) */
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

/**
 * Interface that each data source must implement.
 * A SourceRegistry manages all registered sources.
 */
export interface MemorySource {
  /** The source type this implementation handles */
  readonly sourceType: SourceType;
  /** Discover all items on disk */
  discover(): AsyncGenerator<MemoryItem>;
  /** Convert a discovered item into embeddable chunks */
  parse(item: MemoryItem): Promise<MemoryChunk[]>;
  /** Discover relationships to other items */
  extractLinks(item: MemoryItem): Promise<MemoryLink[]>;
}
