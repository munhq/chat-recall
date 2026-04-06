/**
 * LanceDB vector index for unified memory chunks.
 *
 * Stores all memory types in a single `memory_chunks` table alongside
 * the existing `session_chunks` table, enabling cross-type semantic
 * search in one query with optional source type filtering.
 */
import lancedb from '@lancedb/lancedb';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
export class MemoryIndex {
    static TABLE_NAME = 'memory_chunks';
    static DEFAULT_INDEX_PATH = join(homedir(), '.claude', 'chat-recall-index');
    embedder;
    indexPath;
    db = null;
    table = null;
    mtimeCache = {};
    mtimeCachePath;
    constructor(embedder, indexPath) {
        this.embedder = embedder;
        this.indexPath = indexPath || MemoryIndex.DEFAULT_INDEX_PATH;
        this.mtimeCachePath = join(this.indexPath, 'memory_mtime_cache.json');
        if (!existsSync(this.indexPath)) {
            mkdirSync(this.indexPath, { recursive: true });
        }
        this.mtimeCache = this.loadMtimeCache();
    }
    async connect() {
        if (!this.db) {
            this.db = await lancedb.connect(this.indexPath);
            const tableNames = await this.db.tableNames();
            if (tableNames.includes(MemoryIndex.TABLE_NAME)) {
                this.table = await this.db.openTable(MemoryIndex.TABLE_NAME);
            }
        }
    }
    loadMtimeCache() {
        if (existsSync(this.mtimeCachePath)) {
            try {
                return JSON.parse(readFileSync(this.mtimeCachePath, 'utf-8'));
            }
            catch {
                return {};
            }
        }
        return {};
    }
    saveMtimeCache() {
        writeFileSync(this.mtimeCachePath, JSON.stringify(this.mtimeCache));
    }
    /** Cache key combines source type and item ID for uniqueness */
    cacheKey(sourceType, itemId) {
        return `${sourceType}:${itemId}`;
    }
    needsUpdate(sourceType, itemId, mtime) {
        const key = this.cacheKey(sourceType, itemId);
        const cachedMtime = this.mtimeCache[key] || 0;
        return mtime > cachedMtime;
    }
    async addChunks(chunks) {
        if (chunks.length === 0)
            return 0;
        const validChunks = chunks.filter(c => c.text && c.text.trim().length > 0);
        if (validChunks.length === 0)
            return 0;
        await this.connect();
        const texts = validChunks.map(c => c.text);
        const embeddings = await this.embedder.embed(texts);
        const records = validChunks.map((chunk, i) => ({
            id: chunk.chunkId,
            item_id: chunk.itemId,
            source_type: chunk.sourceType,
            title: chunk.title,
            vector: embeddings[i],
            text: chunk.text,
            chunk_type: chunk.chunkType,
            project_path: chunk.projectPath,
            file_path: chunk.filePath,
            mtime: chunk.mtime,
        }));
        if (this.table === null) {
            this.table = await this.db.createTable(MemoryIndex.TABLE_NAME, records);
        }
        else {
            await this.table.add(records);
        }
        // Update mtime cache
        for (const chunk of validChunks) {
            const key = this.cacheKey(chunk.sourceType, chunk.itemId);
            this.mtimeCache[key] = Math.max(this.mtimeCache[key] || 0, chunk.mtime);
        }
        this.saveMtimeCache();
        return records.length;
    }
    async deleteItem(sourceType, itemId) {
        await this.connect();
        if (this.table !== null) {
            await this.table.delete(`source_type = "${sourceType}" AND item_id = "${itemId}"`);
        }
        const key = this.cacheKey(sourceType, itemId);
        delete this.mtimeCache[key];
        this.saveMtimeCache();
    }
    async deleteSourceType(sourceType) {
        await this.connect();
        if (this.table !== null) {
            await this.table.delete(`source_type = "${sourceType}"`);
        }
        // Remove matching entries from mtime cache
        const prefix = `${sourceType}:`;
        for (const key of Object.keys(this.mtimeCache)) {
            if (key.startsWith(prefix)) {
                delete this.mtimeCache[key];
            }
        }
        this.saveMtimeCache();
    }
    async search(query, options = {}) {
        const { topK = 20, sourceTypes, projectFilter } = options;
        await this.connect();
        if (this.table === null) {
            return [];
        }
        const queryVector = await this.embedder.embedQuery(query);
        const limit = topK * 5;
        const table = this.table;
        let searchQuery = table.search(queryVector);
        // Build filter
        const filters = [];
        if (sourceTypes && sourceTypes.length > 0) {
            const typeList = sourceTypes.map(t => `"${t}"`).join(', ');
            filters.push(`source_type IN (${typeList})`);
        }
        if (projectFilter) {
            filters.push(`project_path LIKE "%${projectFilter}%"`);
        }
        if (filters.length > 0) {
            const filter = filters.join(' AND ');
            searchQuery = searchQuery.where?.(filter) || searchQuery;
        }
        const results = await searchQuery.limit(limit).toArray();
        if (results.length === 0) {
            return [];
        }
        // Group by item_id + source_type
        const itemMap = new Map();
        for (const row of results) {
            const score = 1 / (1 + row._distance);
            const key = `${row.source_type}:${row.item_id}`;
            if (!itemMap.has(key)) {
                itemMap.set(key, {
                    itemId: row.item_id,
                    sourceType: row.source_type,
                    title: row.title,
                    projectPath: row.project_path,
                    filePath: row.file_path,
                    mtime: row.mtime,
                    chunks: [],
                    bestScore: score,
                });
            }
            const item = itemMap.get(key);
            item.chunks.push({
                chunkType: row.chunk_type,
                text: row.text,
                score,
            });
            if (score > item.bestScore) {
                item.bestScore = score;
            }
        }
        // Convert to results
        const searchResults = [];
        for (const [, item] of itemMap) {
            item.chunks.sort((a, b) => b.score - a.score);
            searchResults.push({
                itemId: item.itemId,
                sourceType: item.sourceType,
                title: item.title,
                text: item.chunks[0]?.text || '',
                score: item.bestScore,
                chunkType: item.chunks[0]?.chunkType || 'unknown',
                projectPath: item.projectPath,
                filePath: item.filePath,
                mtime: item.mtime,
                matchedChunks: item.chunks.slice(0, 3),
            });
        }
        searchResults.sort((a, b) => b.score - a.score);
        return searchResults.slice(0, topK);
    }
    async getStats() {
        await this.connect();
        if (this.table === null) {
            return {
                totalChunks: 0,
                totalItems: 0,
                bySourceType: {},
                indexPath: this.indexPath,
            };
        }
        const data = await this.table.toArrow();
        const rows = data.toArray();
        const itemsByType = new Map();
        const chunksByType = new Map();
        for (const row of rows) {
            if (!itemsByType.has(row.source_type)) {
                itemsByType.set(row.source_type, new Set());
                chunksByType.set(row.source_type, 0);
            }
            itemsByType.get(row.source_type).add(row.item_id);
            chunksByType.set(row.source_type, (chunksByType.get(row.source_type) || 0) + 1);
        }
        const bySourceType = {};
        let totalItems = 0;
        for (const [type, items] of itemsByType) {
            bySourceType[type] = {
                items: items.size,
                chunks: chunksByType.get(type) || 0,
            };
            totalItems += items.size;
        }
        return {
            totalChunks: rows.length,
            totalItems,
            bySourceType,
            indexPath: this.indexPath,
        };
    }
    async clear() {
        await this.connect();
        const tableNames = await this.db.tableNames();
        if (tableNames.includes(MemoryIndex.TABLE_NAME)) {
            await this.db.dropTable(MemoryIndex.TABLE_NAME);
        }
        this.table = null;
        this.mtimeCache = {};
        this.saveMtimeCache();
    }
}
