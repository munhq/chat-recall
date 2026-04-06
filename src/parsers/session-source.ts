/**
 * Session memory source adapter.
 *
 * Wraps existing session.ts + chunker.ts as a MemorySource plugin,
 * enabling sessions to participate in the unified memory system.
 */

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
} from '../types/memory.js';
import {
  getAllSessions,
  parseSessionFile,
  type SessionEntry,
} from './session.js';
import { chunkSession } from './chunker.js';

export class SessionSource implements MemorySource {
  readonly sourceType = 'session' as const;

  private claudeDir?: string;

  constructor(claudeDir?: string) {
    this.claudeDir = claudeDir;
  }

  async *discover(): AsyncGenerator<MemoryItem> {
    for (const [entry, sessionPath] of getAllSessions(this.claudeDir)) {
      yield this.entryToItem(entry, sessionPath);
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    const content = await parseSessionFile(item.filePath);
    const entry = this.itemToEntry(item);
    const sessionChunks = chunkSession(entry, content);

    // Store rich session metadata back onto the item (persisted to extra_json in SQLite)
    item.extra = {
      ...(item.extra || {}),
      ...content.metadata,
    };

    return sessionChunks.map(sc => ({
      chunkId: sc.chunkId,
      itemId: sc.sessionId,
      sourceType: 'session' as const,
      title: sc.firstPrompt.slice(0, 100) || `Session ${sc.sessionId.slice(0, 8)}`,
      text: sc.text,
      chunkType: sc.chunkType,
      projectPath: sc.projectPath,
      filePath: sc.sourceFile,
      mtime: sc.mtime,
    }));
  }

  async extractLinks(_item: MemoryItem): Promise<MemoryLink[]> {
    // Sessions are the hub - other sources link TO sessions.
    // No outgoing links needed from sessions themselves.
    return [];
  }

  private entryToItem(entry: SessionEntry, sessionPath: string): MemoryItem {
    return {
      id: entry.sessionId,
      sourceType: 'session',
      title: entry.firstPrompt
        ? entry.firstPrompt.replace(/\n/g, ' ').trim().slice(0, 100)
        : `Session ${entry.sessionId.slice(0, 8)}`,
      projectPath: entry.projectPath,
      filePath: sessionPath,
      mtime: entry.fileMtime,
      contentPreview: entry.firstPrompt?.slice(0, 200),
      extra: {
        messageCount: entry.messageCount,
        gitBranch: entry.gitBranch,
        created: entry.created,
        modified: entry.modified,
        isSidechain: entry.isSidechain,
      },
    };
  }

  private itemToEntry(item: MemoryItem): SessionEntry {
    const extra = item.extra || {};
    return {
      sessionId: item.id,
      fullPath: item.filePath,
      fileMtime: item.mtime,
      firstPrompt: item.contentPreview || '',
      messageCount: (extra.messageCount as number) || 0,
      created: (extra.created as string) || '',
      modified: (extra.modified as string) || '',
      gitBranch: (extra.gitBranch as string) || '',
      projectPath: item.projectPath,
      isSidechain: (extra.isSidechain as boolean) || false,
    };
  }
}
