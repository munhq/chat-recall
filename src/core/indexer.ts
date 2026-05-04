/**
 * LanceDB indexer for session chunks.
 */

import lancedb from '@lancedb/lancedb';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import type { Embedder } from './embedder.js';
import type { SessionChunk } from '../parsers/chunker.js';
import type { SessionEntry } from '../parsers/session.js';
import { getAllSessions, parseSessionFile } from '../parsers/session.js';
import { chunkSession } from '../parsers/chunker.js';
import { getIndexDir } from './paths.js';

export interface ChunkRecord {
  id: string;
  session_id: string;
  vector: number[];
  text: string;
  project_path: string;
  created: string;
  modified: string;
  mtime: number;
  first_prompt: string;
  chunk_type: string;
  source_file: string;
  source_line: number;
}

export interface SearchResult {
  sessionId: string;
  score: number;
  chunkType: string;
  text: string;  // The matched chunk text (could be summary, assistant response, etc.)
  projectPath: string;
  created: string;
  modified: string;
  firstPrompt: string;
  summary?: string;  // Session summary if available
  matchedChunks: Array<{  // All relevant chunks for this session
    chunkType: string;
    text: string;
    score: number;
  }>;
}

export class SessionIndex {
  static readonly TABLE_NAME = 'session_chunks';
  /** Default index dir — resolved lazily so tests can swap it via env var. */
  static getDefaultIndexPath(): string { return getIndexDir(); }

  private embedder: Embedder;
  private indexPath: string;
  private db: Awaited<ReturnType<typeof lancedb.connect>> | null = null;
  private table: unknown | null = null;
  private mtimeCache: Record<string, number> = {};
  private mtimeCachePath: string;

  constructor(embedder: Embedder, indexPath?: string) {
    this.embedder = embedder;
    this.indexPath = indexPath || SessionIndex.getDefaultIndexPath();
    this.mtimeCachePath = join(this.indexPath, 'mtime_cache.json');
    
    // Ensure directory exists
    if (!existsSync(this.indexPath)) {
      mkdirSync(this.indexPath, { recursive: true });
    }
    
    // Load mtime cache
    this.mtimeCache = this.loadMtimeCache();
  }
  
  async connect(): Promise<void> {
    if (!this.db) {
      this.db = await lancedb.connect(this.indexPath);
      
      // Try to open existing table
      const tableNames = await this.db.tableNames();
      if (tableNames.includes(SessionIndex.TABLE_NAME)) {
        this.table = await this.db.openTable(SessionIndex.TABLE_NAME);
      }
    }
  }
  
  private loadMtimeCache(): Record<string, number> {
    if (existsSync(this.mtimeCachePath)) {
      return JSON.parse(readFileSync(this.mtimeCachePath, 'utf-8'));
    }
    return {};
  }
  
  private saveMtimeCache(): void {
    writeFileSync(this.mtimeCachePath, JSON.stringify(this.mtimeCache));
  }
  
  needsUpdate(sessionId: string, mtime: number): boolean {
    const cachedMtime = this.mtimeCache[sessionId] || 0;
    return mtime > cachedMtime;
  }
  
  async addChunks(chunks: SessionChunk[], showProgress = false): Promise<number> {
    if (chunks.length === 0) return 0;

    // Filter out empty chunks (prevents embedding errors)
    const validChunks = chunks.filter(chunk => chunk.text && chunk.text.trim().length > 0);
    if (validChunks.length === 0) return 0;

    await this.connect();

    // Get texts and create embeddings
    const texts = validChunks.map(chunk => chunk.text);
    
    if (showProgress) {
      console.log(`  Embedding ${texts.length} chunks...`);
    }
    
    const embeddings = await this.embedder.embed(texts);

    // Create records
    const records: ChunkRecord[] = validChunks.map((chunk, i) => ({
      id: chunk.chunkId,
      session_id: chunk.sessionId,
      vector: embeddings[i],
      text: chunk.text,
      project_path: chunk.projectPath,
      created: chunk.created,
      modified: chunk.modified,
      mtime: chunk.mtime,
      first_prompt: chunk.firstPrompt,
      chunk_type: chunk.chunkType,
      source_file: chunk.sourceFile,
      source_line: chunk.sourceLine,
    }));
    
    // Add to LanceDB
    if (this.table === null) {
      this.table = await this.db!.createTable(SessionIndex.TABLE_NAME, records as unknown as Record<string, unknown>[]);
    } else {
      await (this.table as { add: (records: unknown[]) => Promise<void> }).add(records);
    }
    
    // Update mtime cache
    for (const chunk of chunks) {
      this.mtimeCache[chunk.sessionId] = chunk.mtime;
    }
    this.saveMtimeCache();
    
    return records.length;
  }
  
  async deleteSession(sessionId: string): Promise<void> {
    await this.connect();
    
    if (this.table !== null) {
      const safeId = sessionId.replace(/"/g, '');
      await (this.table as { delete: (filter: string) => Promise<void> }).delete(
        `session_id = "${safeId}"`
      );
    }
    
    delete this.mtimeCache[sessionId];
    this.saveMtimeCache();
  }
  
  async getStats(): Promise<{
    totalChunks: number;
    totalSessions: number;
    projects: Record<string, number>;
    indexPath: string;
  }> {
    await this.connect();
    
    if (this.table === null) {
      return {
        totalChunks: 0,
        totalSessions: 0,
        projects: {},
        indexPath: this.indexPath,
      };
    }
    
    // Get all data
    const data = await (this.table as { toArrow: () => Promise<unknown> }).toArrow() as {
      toArray: () => Array<{ session_id: string; project_path: string }>;
    };
    const rows = data.toArray();
    
    const sessionIds = new Set<string>();
    const projectSessions: Record<string, Set<string>> = {};

    for (const row of rows) {
      sessionIds.add(row.session_id);
      if (!projectSessions[row.project_path]) {
        projectSessions[row.project_path] = new Set();
      }
      projectSessions[row.project_path].add(row.session_id);
    }

    // Convert Sets to counts
    const projectCounts: Record<string, number> = {};
    for (const [path, sessions] of Object.entries(projectSessions)) {
      projectCounts[path] = sessions.size;
    }
    
    return {
      totalChunks: rows.length,
      totalSessions: sessionIds.size,
      projects: projectCounts,
      indexPath: this.indexPath,
    };
  }
  
  async clear(): Promise<void> {
    await this.connect();
    
    const tableNames = await this.db!.tableNames();
    if (tableNames.includes(SessionIndex.TABLE_NAME)) {
      await this.db!.dropTable(SessionIndex.TABLE_NAME);
    }
    
    this.table = null;
    this.mtimeCache = {};
    this.saveMtimeCache();
  }
  
  async search(
    query: string,
    topK = 20,
    projectFilter?: string,
    dedupeSessions = true
  ): Promise<SearchResult[]> {
    await this.connect();

    if (this.table === null) {
      throw new Error('Index not found. Run "chat-recall index" first.');
    }

    // Embed the query
    const queryVector = await this.embedder.embedQuery(query);

    // Get more results to aggregate per session
    const limit = dedupeSessions ? topK * 5 : topK;

    // Type assertion for table methods
    const table = this.table as {
      search: (vector: number[]) => {
        where?: (filter: string) => unknown;
        limit: (n: number) => { toArray: () => Promise<Array<{
          session_id: string;
          _distance: number;
          chunk_type: string;
          text: string;
          project_path: string;
          created: string;
          modified: string;
          first_prompt: string;
        }>> };
      };
    };

    let searchQuery = table.search(queryVector);

    if (projectFilter) {
      const safeFilter = projectFilter.replace(/["'\\%_]/g, '');
      if (safeFilter) {
        searchQuery = searchQuery.where?.(`project_path LIKE "%${safeFilter}%"`) as typeof searchQuery || searchQuery;
      }
    }

    const results = await searchQuery.limit(limit).toArray();

    if (results.length === 0) {
      return [];
    }

    // Convert distance to similarity score and group by session
    const sessionMap = new Map<string, {
      chunks: Array<{
        chunkType: string;
        text: string;
        score: number;
      }>;
      bestScore: number;
      projectPath: string;
      created: string;
      modified: string;
      firstPrompt: string;
      summary?: string;
    }>();

    for (const row of results) {
      const score = 1 / (1 + row._distance);
      const sessionId = row.session_id;

      if (!sessionMap.has(sessionId)) {
        sessionMap.set(sessionId, {
          chunks: [],
          bestScore: score,
          projectPath: row.project_path,
          created: row.created,
          modified: row.modified,
          firstPrompt: row.first_prompt,
        });
      }

      const session = sessionMap.get(sessionId)!;
      session.chunks.push({
        chunkType: row.chunk_type,
        text: row.text,
        score,
      });

      // Track best score
      if (score > session.bestScore) {
        session.bestScore = score;
      }

      // Capture summary if this chunk is a summary
      if (row.chunk_type === 'summary' && !session.summary) {
        session.summary = row.text;
      }
    }

    // Convert to array and sort by best score
    let processedResults: SearchResult[] = [];

    for (const [sessionId, session] of sessionMap) {
      // Sort chunks by score descending
      session.chunks.sort((a, b) => b.score - a.score);

      // Get the best text to display (prefer summary, then assistant, then first_prompt)
      let bestText = session.chunks[0]?.text || session.firstPrompt;
      const summaryChunk = session.chunks.find(c => c.chunkType === 'summary');
      const assistantChunk = session.chunks.find(c => c.chunkType === 'assistant');

      if (summaryChunk) {
        bestText = summaryChunk.text;
      } else if (assistantChunk) {
        bestText = assistantChunk.text;
      }

      processedResults.push({
        sessionId,
        score: session.bestScore,
        chunkType: session.chunks[0]?.chunkType || 'unknown',
        text: bestText,
        projectPath: session.projectPath,
        created: session.created,
        modified: session.modified,
        firstPrompt: session.firstPrompt,
        summary: session.summary,
        matchedChunks: session.chunks.slice(0, 3), // Top 3 matched chunks
      });
    }

    // Sort by score descending
    processedResults.sort((a, b) => b.score - a.score);

    return processedResults.slice(0, topK);
  }
}

export interface IndexStats {
  sessionsProcessed: number;
  sessionsSkipped: number;
  chunksAdded: number;
  errors: number;
}

export async function indexAllSessions(
  embedder: Embedder,
  options: {
    indexPath?: string;
    claudeDir?: string;
    force?: boolean;
    showProgress?: boolean;
  } = {}
): Promise<IndexStats> {
  const {
    indexPath,
    claudeDir,
    force = false,
    showProgress = true,
  } = options;
  
  const index = new SessionIndex(embedder, indexPath);
  await index.connect();
  
  if (force) {
    if (showProgress) {
      console.log('Clearing existing index...');
    }
    await index.clear();
  }
  
  const stats: IndexStats = {
    sessionsProcessed: 0,
    sessionsSkipped: 0,
    chunksAdded: 0,
    errors: 0,
  };
  
  if (showProgress) {
    console.log('Scanning sessions...');
  }
  
  // Collect all sessions
  const sessions: Array<[SessionEntry, string]> = [];
  for (const session of getAllSessions(claudeDir)) {
    sessions.push(session);
  }
  
  if (showProgress) {
    console.log(`Found ${sessions.length} sessions`);
  }
  
  for (const [entry, sessionPath] of sessions) {
    try {
      // Skip if unchanged
      if (!force && !index.needsUpdate(entry.sessionId, entry.fileMtime)) {
        stats.sessionsSkipped++;
        continue;
      }
      
      if (showProgress) {
        let project = entry.projectPath;
        if (project.length > 40) {
          project = '...' + project.slice(-37);
        }
        console.log(`Indexing: ${project} (${entry.sessionId.slice(0, 8)}...)`);
      }
      
      // Parse and chunk
      const content = await parseSessionFile(sessionPath);
      const chunks = chunkSession(entry, content);
      
      if (chunks.length > 0) {
        // Delete old chunks for this session
        await index.deleteSession(entry.sessionId);
        
        // Add new chunks
        const added = await index.addChunks(chunks, false);
        stats.chunksAdded += added;
      }
      
      stats.sessionsProcessed++;
    } catch (err) {
      stats.errors++;
      if (showProgress) {
        console.log(`  Error: ${err}`);
      }
    }
  }
  
  if (showProgress) {
    console.log(`\nDone! Processed: ${stats.sessionsProcessed}, ` +
      `Skipped: ${stats.sessionsSkipped}, Chunks: ${stats.chunksAdded}`);
  }
  
  return stats;
}

export async function searchSessions(
  query: string,
  embedder: Embedder,
  options: {
    topK?: number;
    projectFilter?: string;
    indexPath?: string;
  } = {}
): Promise<SearchResult[]> {
  const { topK = 10, projectFilter, indexPath } = options;
  
  const index = new SessionIndex(embedder, indexPath);
  return index.search(query, topK, projectFilter);
}
