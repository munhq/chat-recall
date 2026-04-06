/**
 * LanceDB indexer for session chunks.
 */
import lancedb from '@lancedb/lancedb';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getAllSessions, parseSessionFile } from '../parsers/session.js';
import { chunkSession } from '../parsers/chunker.js';
export class SessionIndex {
    static TABLE_NAME = 'session_chunks';
    static DEFAULT_INDEX_PATH = join(homedir(), '.claude', 'chat-recall-index');
    embedder;
    indexPath;
    db = null;
    table = null;
    mtimeCache = {};
    mtimeCachePath;
    constructor(embedder, indexPath) {
        this.embedder = embedder;
        this.indexPath = indexPath || SessionIndex.DEFAULT_INDEX_PATH;
        this.mtimeCachePath = join(this.indexPath, 'mtime_cache.json');
        // Ensure directory exists
        if (!existsSync(this.indexPath)) {
            mkdirSync(this.indexPath, { recursive: true });
        }
        // Load mtime cache
        this.mtimeCache = this.loadMtimeCache();
    }
    async connect() {
        if (!this.db) {
            this.db = await lancedb.connect(this.indexPath);
            // Try to open existing table
            const tableNames = await this.db.tableNames();
            if (tableNames.includes(SessionIndex.TABLE_NAME)) {
                this.table = await this.db.openTable(SessionIndex.TABLE_NAME);
            }
        }
    }
    loadMtimeCache() {
        if (existsSync(this.mtimeCachePath)) {
            return JSON.parse(readFileSync(this.mtimeCachePath, 'utf-8'));
        }
        return {};
    }
    saveMtimeCache() {
        writeFileSync(this.mtimeCachePath, JSON.stringify(this.mtimeCache));
    }
    needsUpdate(sessionId, mtime) {
        const cachedMtime = this.mtimeCache[sessionId] || 0;
        return mtime > cachedMtime;
    }
    async addChunks(chunks, showProgress = false) {
        if (chunks.length === 0)
            return 0;
        // Filter out empty chunks (prevents embedding errors)
        const validChunks = chunks.filter(chunk => chunk.text && chunk.text.trim().length > 0);
        if (validChunks.length === 0)
            return 0;
        await this.connect();
        // Get texts and create embeddings
        const texts = validChunks.map(chunk => chunk.text);
        if (showProgress) {
            console.log(`  Embedding ${texts.length} chunks...`);
        }
        const embeddings = await this.embedder.embed(texts);
        // Create records
        const records = validChunks.map((chunk, i) => ({
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
            this.table = await this.db.createTable(SessionIndex.TABLE_NAME, records);
        }
        else {
            await this.table.add(records);
        }
        // Update mtime cache
        for (const chunk of chunks) {
            this.mtimeCache[chunk.sessionId] = chunk.mtime;
        }
        this.saveMtimeCache();
        return records.length;
    }
    async deleteSession(sessionId) {
        await this.connect();
        if (this.table !== null) {
            await this.table.delete(`session_id = "${sessionId}"`);
        }
        delete this.mtimeCache[sessionId];
        this.saveMtimeCache();
    }
    async getStats() {
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
        const data = await this.table.toArrow();
        const rows = data.toArray();
        const sessionIds = new Set();
        const projectCounts = {};
        for (const row of rows) {
            sessionIds.add(row.session_id);
            projectCounts[row.project_path] = (projectCounts[row.project_path] || 0) + 1;
        }
        return {
            totalChunks: rows.length,
            totalSessions: sessionIds.size,
            projects: projectCounts,
            indexPath: this.indexPath,
        };
    }
    async clear() {
        await this.connect();
        const tableNames = await this.db.tableNames();
        if (tableNames.includes(SessionIndex.TABLE_NAME)) {
            await this.db.dropTable(SessionIndex.TABLE_NAME);
        }
        this.table = null;
        this.mtimeCache = {};
        this.saveMtimeCache();
    }
    async search(query, topK = 20, projectFilter, dedupeSessions = true) {
        await this.connect();
        if (this.table === null) {
            throw new Error('Index not found. Run "chat-recall index" first.');
        }
        // Embed the query
        const queryVector = await this.embedder.embedQuery(query);
        // Get more results to aggregate per session
        const limit = dedupeSessions ? topK * 5 : topK;
        // Type assertion for table methods
        const table = this.table;
        let searchQuery = table.search(queryVector);
        if (projectFilter) {
            searchQuery = searchQuery.where?.(`project_path LIKE "%${projectFilter}%"`) || searchQuery;
        }
        const results = await searchQuery.limit(limit).toArray();
        if (results.length === 0) {
            return [];
        }
        // Convert distance to similarity score and group by session
        const sessionMap = new Map();
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
            const session = sessionMap.get(sessionId);
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
        let processedResults = [];
        for (const [sessionId, session] of sessionMap) {
            // Sort chunks by score descending
            session.chunks.sort((a, b) => b.score - a.score);
            // Get the best text to display (prefer summary, then assistant, then first_prompt)
            let bestText = session.chunks[0]?.text || session.firstPrompt;
            const summaryChunk = session.chunks.find(c => c.chunkType === 'summary');
            const assistantChunk = session.chunks.find(c => c.chunkType === 'assistant');
            if (summaryChunk) {
                bestText = summaryChunk.text;
            }
            else if (assistantChunk) {
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
export async function indexAllSessions(embedder, options = {}) {
    const { indexPath, claudeDir, force = false, showProgress = true, } = options;
    const index = new SessionIndex(embedder, indexPath);
    await index.connect();
    if (force) {
        if (showProgress) {
            console.log('Clearing existing index...');
        }
        await index.clear();
    }
    const stats = {
        sessionsProcessed: 0,
        sessionsSkipped: 0,
        chunksAdded: 0,
        errors: 0,
    };
    if (showProgress) {
        console.log('Scanning sessions...');
    }
    // Collect all sessions
    const sessions = [];
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
        }
        catch (err) {
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
export async function searchSessions(query, embedder, options = {}) {
    const { topK = 10, projectFilter, indexPath } = options;
    const index = new SessionIndex(embedder, indexPath);
    return index.search(query, topK, projectFilter);
}
