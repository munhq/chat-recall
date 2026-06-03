/**
 * History memory source.
 *
 * Parses ~/.claude/history.jsonl which contains all user prompts
 * (what users typed into Claude Code). Entries are grouped by
 * sessionId when available, and linked to paste-cache entries
 * via pastedContents hashes.
 *
 * History entry format:
 * {"display":"user prompt text","pastedContents":{},"timestamp":1234,"project":"/path","sessionId?":"uuid"}
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
} from '../types/memory.js';
import { discoverSubdirs } from '../core/utils.js';
import { claudeBackend as CLAUDE } from '../core/backends/claude.js';
import { isSourceEnabled } from '../core/settings.js';

const MAX_CHUNK_CHARS = 2000;

interface HistoryEntry {
  display: string;
  pastedContents?: Record<string, unknown>;
  timestamp: number;
  project?: string;
  sessionId?: string;
}

/** Group history entries by project for discovery */
interface ProjectGroup {
  project: string;
  entries: HistoryEntry[];
  latestTimestamp: number;
  sessionIds: Set<string>;
  pasteHashes: Set<string>;
}

export class HistorySource implements MemorySource {
  readonly sourceType = 'history' as const;

  private historyPaths: string[];

  constructor(historyPath?: string) {
    if (historyPath) {
      this.historyPaths = [historyPath];
    } else {
      // Discover history.jsonl across all Claude directories
      const home = homedir();
      const paths: string[] = [];
      const tryAdd = (p: string) => { if (existsSync(p) && !paths.includes(p)) paths.push(p); };
      tryAdd(CLAUDE.historyFile());
      try {
        for (const entry of readdirSync(home, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith('.claude-') && entry.name !== '.claude-code') {
            tryAdd(join(home, entry.name, 'history.jsonl'));
          }
        }
      } catch {}
      this.historyPaths = paths.length > 0 ? paths : [join(home, '.claude', 'history.jsonl')];
    }
  }

  async *discover(): AsyncGenerator<MemoryItem> {
    if (!isSourceEnabled('claude', 'history')) return;
    // Use the first existing history file for stat/mtime
    const historyPath = this.historyPaths.find(p => existsSync(p));
    if (!historyPath) return;

    const stat = statSync(historyPath);

    // Group entries by project (across all history files)
    const groups = await this.groupByProject();

    for (const [project, group] of groups) {
      // Use project path as a stable ID
      const projectId = project.replace(/\//g, '-').replace(/^-/, '');

      yield {
        id: `history_${projectId}`,
        sourceType: 'history',
        title: `History: ${project.replace(/^\/home\/\w+\/code\/\w+\//, '')}`,
        projectPath: project,
        filePath: historyPath,
        mtime: stat.mtimeMs,
        contentPreview: group.entries.slice(-3).map(e => e.display).join(' | ').slice(0, 300),
        extra: {
          entryCount: group.entries.length,
          sessionIds: Array.from(group.sessionIds),
          pasteHashes: Array.from(group.pasteHashes),
          latestTimestamp: group.latestTimestamp,
        },
      };
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    const extra = item.extra || {};
    const chunks: MemoryChunk[] = [];

    // Re-read entries for this project
    const groups = await this.groupByProject();
    const projectPath = item.projectPath;
    const group = groups.get(projectPath);

    if (!group || group.entries.length === 0) return [];

    // Chunk: Combined recent prompts (most valuable for search)
    const recentEntries = group.entries.slice(-20);
    const recentText = recentEntries
      .map(e => e.display)
      .filter(d => d.length > 5 && !d.startsWith('/'))
      .join('\n\n');

    if (recentText.trim().length > 20) {
      chunks.push({
        chunkId: `${item.id}_recent`,
        itemId: item.id,
        sourceType: 'history',
        title: item.title,
        text: recentText.slice(0, MAX_CHUNK_CHARS),
        chunkType: 'history_recent',
        projectPath: item.projectPath,
        filePath: item.filePath,
        mtime: item.mtime,
      });
    }

    // Chunk: Earlier prompts for broader context
    if (group.entries.length > 20) {
      const earlyEntries = group.entries.slice(0, -20).slice(-20);
      const earlyText = earlyEntries
        .map(e => e.display)
        .filter(d => d.length > 5 && !d.startsWith('/'))
        .join('\n\n');

      if (earlyText.trim().length > 20) {
        chunks.push({
          chunkId: `${item.id}_early`,
          itemId: item.id,
          sourceType: 'history',
          title: item.title,
          text: earlyText.slice(0, MAX_CHUNK_CHARS),
          chunkType: 'history_early',
          projectPath: item.projectPath,
          filePath: item.filePath,
          mtime: item.mtime,
        });
      }
    }

    return chunks;
  }

  async extractLinks(item: MemoryItem): Promise<MemoryLink[]> {
    const links: MemoryLink[] = [];
    const extra = item.extra || {};

    // Link to sessions
    const sessionIds = (extra.sessionIds as string[]) || [];
    for (const sessionId of sessionIds) {
      links.push({
        sourceType: 'history',
        sourceId: item.id,
        targetType: 'session',
        targetId: sessionId,
        linkType: 'history_for_session',
        confidence: 1.0,
      });
    }

    // Link to paste cache entries
    const pasteHashes = (extra.pasteHashes as string[]) || [];
    for (const hash of pasteHashes) {
      links.push({
        sourceType: 'history',
        sourceId: item.id,
        targetType: 'paste',
        targetId: hash,
        linkType: 'history_has_paste',
        confidence: 1.0,
      });
    }

    return links;
  }

  private async groupByProject(): Promise<Map<string, ProjectGroup>> {
    const groups = new Map<string, ProjectGroup>();

    for (const historyPath of this.historyPaths) {
      if (!existsSync(historyPath)) continue;

      const rl = createInterface({
        input: createReadStream(historyPath),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line) as HistoryEntry;
        const project = entry.project || 'unknown';

        if (!groups.has(project)) {
          groups.set(project, {
            project,
            entries: [],
            latestTimestamp: 0,
            sessionIds: new Set(),
            pasteHashes: new Set(),
          });
        }

        const group = groups.get(project)!;
        group.entries.push(entry);

        if (entry.timestamp > group.latestTimestamp) {
          group.latestTimestamp = entry.timestamp;
        }

        if (entry.sessionId) {
          group.sessionIds.add(entry.sessionId);
        }

        // Extract paste content hashes
        if (entry.pastedContents && typeof entry.pastedContents === 'object') {
          for (const key of Object.keys(entry.pastedContents)) {
            if (key && key !== '{}') {
              group.pasteHashes.add(key);
            }
          }
        }
      } catch {
        continue;
      }
    }
    }

    return groups;
  }
}
