/**
 * Agent Diary memory source.
 *
 * Each AI agent gets a persistent diary — a session-level journal
 * for recording observations, decisions, and context across conversations.
 *
 * Storage: <data dir>/index/diary/<agent_name>/<timestamp>.json
 * (canonical path resolved through `src/core/paths.ts`).
 *
 * Diary entries are filed via MCP tools (recall_diary_write) and
 * discovered + indexed like any other memory source.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, basename } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
  SourceType,
} from '../types/memory.js';
import { getDiaryDir } from '../core/paths.js';

const MAX_CHUNK_CHARS = 3000;

export interface DiaryEntry {
  agent: string;
  topic: string;
  content: string;
  timestamp: string;
  sessionId?: string;
  projectPath?: string;
}

export class DiarySource implements MemorySource {
  readonly sourceType = 'diary' as SourceType;

  private readonly diaryDir: string;

  constructor(diaryDir?: string) {
    this.diaryDir = diaryDir || getDiaryDir();
  }

  /** Discover all diary entries across all agents. */
  async *discover(): AsyncGenerator<MemoryItem> {
    if (!existsSync(this.diaryDir)) return;

    const agents = readdirSync(this.diaryDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const agentDir of agents) {
      const agentPath = join(this.diaryDir, agentDir.name);
      const files = readdirSync(agentPath).filter(f => f.endsWith('.json'));

      for (const file of files) {
        const filePath = join(agentPath, file);
        try {
          const stat = statSync(filePath);
          const raw = readFileSync(filePath, 'utf-8');
          const entry = JSON.parse(raw) as DiaryEntry;

          const entryId = basename(file, '.json');
          const title = `[${entry.agent}] ${entry.topic}: ${entry.content.slice(0, 80)}`;

          yield {
            id: entryId,
            sourceType: 'diary' as SourceType,
            title,
            projectPath: entry.projectPath || '',
            filePath,
            mtime: stat.mtimeMs,
            contentPreview: entry.content.slice(0, 300),
            extra: {
              agent: entry.agent,
              topic: entry.topic,
              sessionId: entry.sessionId,
            },
          };
        } catch {
          continue;
        }
      }
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(item.filePath)) return [];

    const raw = readFileSync(item.filePath, 'utf-8');
    const entry = JSON.parse(raw) as DiaryEntry;

    if (!entry.content || entry.content.trim().length < 10) return [];

    return [{
      chunkId: `${item.id}_diary`,
      itemId: item.id,
      sourceType: 'diary' as SourceType,
      title: item.title,
      text: entry.content.slice(0, MAX_CHUNK_CHARS),
      chunkType: 'diary_entry',
      projectPath: item.projectPath,
      filePath: item.filePath,
      mtime: item.mtime,
    }];
  }

  async extractLinks(item: MemoryItem): Promise<MemoryLink[]> {
    const links: MemoryLink[] = [];

    const extra = item.extra as { sessionId?: string } | undefined;
    if (extra?.sessionId) {
      links.push({
        sourceType: 'diary' as SourceType,
        sourceId: item.id,
        targetType: 'session',
        targetId: extra.sessionId,
        linkType: 'diary_for_session' as MemoryLink['linkType'],
        confidence: 1.0,
      });
    }

    return links;
  }

  // ── Write API (used by MCP tools) ─────────────────────────────

  /**
   * Write a new diary entry. Returns the entry ID.
   */
  static write(entry: DiaryEntry, diaryDir?: string): string {
    const dir = diaryDir || getDiaryDir();

    const agentDir = join(dir, entry.agent.toLowerCase().replace(/[^a-z0-9_-]/g, '_'));
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const entryId = `diary_${entry.agent.toLowerCase()}_${ts}`;
    const filePath = join(agentDir, `${entryId}.json`);

    const full: DiaryEntry = {
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    };

    writeFileSync(filePath, JSON.stringify(full, null, 2), 'utf-8');
    return entryId;
  }

  /**
   * Read recent diary entries for an agent.
   */
  static read(agentName: string, lastN = 10, diaryDir?: string): DiaryEntry[] {
    const dir = diaryDir || getDiaryDir();

    const agentDir = join(dir, agentName.toLowerCase().replace(/[^a-z0-9_-]/g, '_'));
    if (!existsSync(agentDir)) return [];

    const files = readdirSync(agentDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, lastN);

    const entries: DiaryEntry[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(agentDir, file), 'utf-8');
        entries.push(JSON.parse(raw) as DiaryEntry);
      } catch {
        continue;
      }
    }

    return entries;
  }
}
