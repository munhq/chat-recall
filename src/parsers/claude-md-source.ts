/**
 * CLAUDE.md memory source.
 *
 * Discovers CLAUDE.md files by scanning:
 * 1. All known project directories (derived from ~/.claude/projects/)
 * 2. ~/CLAUDE.md (global instructions)
 * 3. Any additional search directories provided via constructor
 *
 * No hardcoded paths — works on any machine with any directory structure.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
} from '../types/memory.js';
import { splitByHeaders } from '../core/utils.js';

const MAX_CHUNK_CHARS = 2000;

/**
 * Discover project directories from ~/.claude/projects/.
 * Each subdirectory name encodes the project path:
 *   -home-user-code-myproject → /home/user/code/myproject
 */
function discoverProjectDirs(claudeDir?: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  const scanProjectsDir = (projectsDir: string) => {
    if (!existsSync(projectsDir)) return;
    try {
      const entries = readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const projectPath = entry.name.replace(/^-/, '/').replace(/-/g, '/');
        if (!seen.has(projectPath) && existsSync(projectPath)) {
          seen.add(projectPath);
          dirs.push(projectPath);
        }
      }
    } catch {}
  };

  if (claudeDir) {
    scanProjectsDir(join(claudeDir, 'projects'));
  } else {
    // Scan all Claude directories
    const home = homedir();
    scanProjectsDir(join(home, '.claude', 'projects'));
    try {
      for (const entry of readdirSync(home, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('.claude-') && entry.name !== '.claude-code') {
          scanProjectsDir(join(home, entry.name, 'projects'));
        }
      }
    } catch {}
  }

  return dirs;
}

export class ClaudeMdSource implements MemorySource {
  readonly sourceType = 'claude_md' as const;

  private searchDirs: string[];
  private claudeDir?: string;

  constructor(searchDirs?: string[], claudeDir?: string) {
    this.claudeDir = claudeDir;
    this.searchDirs = searchDirs || [];
  }

  async *discover(): AsyncGenerator<MemoryItem> {
    const seen = new Set<string>();

    // 1. Always check ~/CLAUDE.md (global instructions)
    const globalPath = join(homedir(), 'CLAUDE.md');
    if (existsSync(globalPath)) {
      seen.add(globalPath);
      const item = this.fileToItem(globalPath);
      if (item) yield item;
    }

    // 2. Discover project dirs from ~/.claude/projects/ (no hardcoded paths)
    const projectDirs = discoverProjectDirs(this.claudeDir);
    for (const projectDir of projectDirs) {
      const claudePath = join(projectDir, 'CLAUDE.md');
      if (existsSync(claudePath) && !seen.has(claudePath)) {
        seen.add(claudePath);
        const item = this.fileToItem(claudePath);
        if (item) yield item;
      }
    }

    // 3. Also check any additional search dirs provided via constructor
    for (const searchDir of this.searchDirs) {
      if (!existsSync(searchDir)) continue;

      // Check CLAUDE.md directly in the search dir
      const directPath = join(searchDir, 'CLAUDE.md');
      if (existsSync(directPath) && !seen.has(directPath)) {
        seen.add(directPath);
        const item = this.fileToItem(directPath);
        if (item) yield item;
      }

      // Check subdirectories (one level deep)
      try {
        const entries = readdirSync(searchDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const claudePath = join(searchDir, entry.name, 'CLAUDE.md');
          if (existsSync(claudePath) && !seen.has(claudePath)) {
            seen.add(claudePath);
            const item = this.fileToItem(claudePath);
            if (item) yield item;
          }
        }
      } catch {
        continue;
      }
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(item.filePath)) return [];

    const content = readFileSync(item.filePath, 'utf-8');
    const chunks: MemoryChunk[] = [];

    // Split by ## headers
    const sections = splitByHeaders(content);

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (!section.text.trim() || section.text.trim().length < 20) continue;

      const chunkType = i === 0 ? 'claude_md_overview' : 'claude_md_section';
      const text = section.text.slice(0, MAX_CHUNK_CHARS);

      chunks.push({
        chunkId: `${item.id}_${chunkType}_${i}`,
        itemId: item.id,
        sourceType: 'claude_md',
        title: section.heading || item.title,
        text,
        chunkType,
        projectPath: item.projectPath,
        filePath: item.filePath,
        mtime: item.mtime,
      });
    }

    return chunks.slice(0, 12);
  }

  async extractLinks(item: MemoryItem): Promise<MemoryLink[]> {
    // CLAUDE.md links to its project path (used for project-based related lookups)
    // Note: targetType must match an actual SourceType — we use 'claude_md' as a
    // self-referential marker since the projectPath is NOT a session UUID.
    if (item.projectPath) {
      return [{
        sourceType: 'claude_md',
        sourceId: item.id,
        targetType: 'claude_md',
        targetId: item.projectPath,
        linkType: 'claude_md_for_project',
        confidence: 1.0,
      }];
    }
    return [];
  }

  private fileToItem(filePath: string): MemoryItem | null {
    try {
      const stat = statSync(filePath);
      const projectDir = dirname(filePath);
      const projectName = basename(projectDir);

      // Derive project path from filesystem
      const projectPath = projectDir;

      const content = readFileSync(filePath, 'utf-8');
      const firstLine = content.split('\n')
        .find(l => l.trim() && !l.startsWith('#'))
        ?.trim()
        ?.slice(0, 200) || `CLAUDE.md for ${projectName}`;

      return {
        id: projectName,
        sourceType: 'claude_md',
        title: `CLAUDE.md - ${projectName}`,
        projectPath,
        filePath,
        mtime: stat.mtimeMs,
        contentPreview: firstLine,
      };
    } catch {
      return null;
    }
  }
}
