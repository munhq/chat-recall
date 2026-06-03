/**
 * Paste cache memory source.
 *
 * Indexes ~/.claude/paste-cache/*.txt files. These are content that
 * users pasted into Claude Code conversations. They are linked to
 * history entries via content hashes (the filename IS the hash).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
} from '../types/memory.js';
import { claudeBackend as CLAUDE } from '../core/backends/claude.js';
import { isSourceEnabled } from '../core/settings.js';

const MAX_CHUNK_CHARS = 2000;
const MAX_FILE_SIZE = 50_000; // Skip very large paste files

export class PasteSource implements MemorySource {
  readonly sourceType = 'paste' as const;

  private cacheDirs: string[];

  constructor(cacheDir?: string) {
    if (cacheDir) {
      this.cacheDirs = [cacheDir];
    } else {
      // Discover paste-cache across all Claude directories
      const home = homedir();
      const dirs: string[] = [];
      const tryAdd = (p: string) => { if (existsSync(p) && !dirs.includes(p)) dirs.push(p); };
      tryAdd(CLAUDE.pasteCacheDir());
      try {
        for (const entry of readdirSync(home, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith('.claude-') && entry.name !== '.claude-code') {
            tryAdd(join(home, entry.name, 'paste-cache'));
          }
        }
      } catch {}
      this.cacheDirs = dirs.length > 0 ? dirs : [CLAUDE.pasteCacheDir()];
    }
  }

  async *discover(): AsyncGenerator<MemoryItem> {
    if (!isSourceEnabled('claude', 'pasteCache')) return;
    const seen = new Set<string>();
    for (const cacheDir of this.cacheDirs) {
      if (!existsSync(cacheDir)) continue;

      const files = readdirSync(cacheDir).filter(f => f.endsWith('.txt'));

      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        const filePath = join(cacheDir, file);

      try {
        const stat = statSync(filePath);

        // Skip very large files (likely binary or log dumps)
        if (stat.size > MAX_FILE_SIZE) continue;
        if (stat.size < 10) continue;

        const hash = basename(file, '.txt');
        const content = readFileSync(filePath, 'utf-8');

        // Generate a title from first meaningful line
        const firstLine = content.split('\n')
          .find(l => l.trim().length > 5)
          ?.trim()
          ?.slice(0, 100) || `Paste ${hash.slice(0, 8)}`;

        yield {
          id: hash,
          sourceType: 'paste',
          title: firstLine,
          projectPath: '', // No inherent project association
          filePath,
          mtime: stat.mtimeMs,
          contentPreview: content.slice(0, 300),
        };
      } catch {
        continue;
      }
    }
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(item.filePath)) return [];

    const content = readFileSync(item.filePath, 'utf-8');
    if (content.trim().length < 20) return [];

    // Single chunk per paste (most are small enough)
    return [{
      chunkId: `${item.id}_paste`,
      itemId: item.id,
      sourceType: 'paste',
      title: item.title,
      text: content.slice(0, MAX_CHUNK_CHARS),
      chunkType: 'paste_content',
      projectPath: item.projectPath,
      filePath: item.filePath,
      mtime: item.mtime,
    }];
  }

  async extractLinks(_item: MemoryItem): Promise<MemoryLink[]> {
    // Paste items are targets of links from history entries.
    // No outgoing links needed from paste items themselves.
    return [];
  }
}
