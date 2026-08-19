/**
 * Per-project agent-instructions memory source.
 *
 * Discovers all known per-project notes files:
 *   CLAUDE.md     → tool=claude   (Claude Code)
 *   GEMINI.md     → tool=gemini   (Gemini CLI)
 *   AGENTS.md     → tool=opencode (OpenCode / Cline / generic agent convention)
 *   AGENTS.md     → tool=codex    (Codex CLI)
 *
 * Sources scanned (per-tool sources contribute their own discovery roots):
 *   - All known project directories (~/.claude/projects/, ~/.gemini/projects.json)
 *   - $HOME (global *.md instructions)
 *   - Additional search directories provided via constructor
 *
 * Indexed under the legacy `source_type='claude_md'` for back-compat with
 * existing links and MCP tool descriptions; the per-row `extra.tool` carries
 * the actual provenance so the UI can filter and badge correctly.
 */

import { openSqliteReadonlyOrThrow } from '../core/sqlite-reader.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import { createHash } from 'crypto';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
} from '../types/memory.js';
import { splitByHeaders } from '../core/utils.js';
import { claudeBackend as CLAUDE } from '../core/backends/claude.js';
import { geminiBackend as GEMINI } from '../core/backends/gemini.js';
import { isSourceEnabled } from '../core/settings.js';
import { opencodeBackend as OPENCODE } from '../core/backends/opencode.js';

const MAX_CHUNK_CHARS = 2000;

/**
 * The set of agent-instruction filenames we recognize, with the tool they
 * came from. Order matters for back-compat: CLAUDE.md first so it keeps
 * its historical id (`<projectName>`).
 */
const NOTE_FILES: Array<{ filename: string; tool: 'claude' | 'gemini' | 'opencode' | 'codex' }> = [
  { filename: 'CLAUDE.md',   tool: 'claude' },
  { filename: 'GEMINI.md',   tool: 'gemini' },
  { filename: 'AGENTS.md',   tool: 'opencode' },
  { filename: 'AGENTS.md',   tool: 'codex' },
];

/**
 * Discover project directories from ~/.claude/projects/.
 * Each subdirectory name encodes the project path:
 *   -home-user-code-myproject → /home/user/code/myproject
 */
function discoverProjectDirs(claudeDir?: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  const addProject = (path: string) => {
    if (!seen.has(path) && existsSync(path)) {
      seen.add(path);
      dirs.push(path);
    }
  };

  const scanProjectsDir = (projectsDir: string) => {
    if (!existsSync(projectsDir)) return;
    try {
      const entries = readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const projectPath = entry.name.replace(/^-/, '/').replace(/-/g, '/');
        addProject(projectPath);
      }
    } catch {}
  };

  if (claudeDir) {
    scanProjectsDir(join(claudeDir, 'projects'));
    return dirs;
  }

  const home = homedir();

  // 1) Claude project directories
  scanProjectsDir(CLAUDE.projectsDir());

  // 2) Multi-profile ~/.claude-*/projects/
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.claude-') && entry.name !== '.claude-code') {
        scanProjectsDir(join(home, entry.name, 'projects'));
      }
    }
  } catch {}

  // 3) Gemini CLI projects — listed by full path in ~/.gemini/projects.json.
  //    We don't need the SHA mapping here, just the resolved paths.
  const gemProjects = GEMINI.projectsJson();
  if (existsSync(gemProjects)) {
    try {
      const data = JSON.parse(readFileSync(gemProjects, 'utf-8'));
      for (const path of Object.keys(data.projects || {})) addProject(path);
    } catch { /* tolerate */ }
  }

  // 4) OpenCode projects — `project.worktree` in opencode.db. Surface them
  //    via the same path-as-id convention.
  const ocDb = OPENCODE.dbPath();
  if (existsSync(ocDb)) {
    try {
      // Node's built-in reader — no native module, so a Claude-only setup can
      // never be broken by an OpenCode dependency failing to build.
      // `readOnly` also refuses to create a missing file (the old fileMustExist).
      const db = openSqliteReadonlyOrThrow(ocDb);
      try {
        const rows = db.prepare('SELECT DISTINCT worktree FROM project WHERE worktree IS NOT NULL').all() as Array<{ worktree: string }>;
        for (const r of rows) if (r.worktree) addProject(r.worktree);
      } finally { db.close(); }
    } catch { /* tolerate */ }
  }

  // Suppress an unused-variable warning when createHash isn't needed at runtime
  // — it's imported in case future scanners want it (Gemini hash mapping etc).
  void createHash;

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
    if (!isSourceEnabled('common', 'agentMd')) return;
    // The dedup key must include the *tool*, not just the path. AGENTS.md
    // is shared by OpenCode and Codex — we want both rows in the index so
    // each tool's column in the cross-tool matrix lights up.
    const seen = new Set<string>();
    const seenKey = (path: string, tool: string) => `${tool}:${path}`;

    // 1) Global notes in $HOME — only CLAUDE.md is conventional there, but
    //    look for the others too in case the user has them.
    for (const note of NOTE_FILES) {
      const p = join(homedir(), note.filename);
      const key = seenKey(p, note.tool);
      if (existsSync(p) && !seen.has(key)) {
        seen.add(key);
        const item = this.fileToItem(p, note.filename, note.tool);
        if (item) yield item;
      }
    }

    // 2) Per-project notes — walk every known project dir from any AI tool
    //    and check for each filename.
    const projectDirs = discoverProjectDirs(this.claudeDir);
    for (const projectDir of projectDirs) {
      for (const note of NOTE_FILES) {
        const p = join(projectDir, note.filename);
        const key = seenKey(p, note.tool);
        if (existsSync(p) && !seen.has(key)) {
          seen.add(key);
          const item = this.fileToItem(p, note.filename, note.tool);
          if (item) yield item;
        }
      }
    }

    // 3) Additional search dirs supplied to the constructor — same per-file scan.
    for (const searchDir of this.searchDirs) {
      if (!existsSync(searchDir)) continue;

      for (const note of NOTE_FILES) {
        const directPath = join(searchDir, note.filename);
        const key = seenKey(directPath, note.tool);
        if (existsSync(directPath) && !seen.has(key)) {
          seen.add(key);
          const item = this.fileToItem(directPath, note.filename, note.tool);
          if (item) yield item;
        }
      }

      try {
        const entries = readdirSync(searchDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          for (const note of NOTE_FILES) {
            const p = join(searchDir, entry.name, note.filename);
            const key = seenKey(p, note.tool);
            if (existsSync(p) && !seen.has(key)) {
              seen.add(key);
              const item = this.fileToItem(p, note.filename, note.tool);
              if (item) yield item;
            }
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

  private fileToItem(
    filePath: string,
    filename: string,
    tool: 'claude' | 'gemini' | 'opencode' | 'codex',
  ): MemoryItem | null {
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
        ?.slice(0, 200) || `${filename} for ${projectName}`;

      // Preserve historical id for CLAUDE.md (so existing links keep
      // resolving). Other note types use a tool-suffixed id to avoid
      // collisions when both files exist in the same project.
      const id = tool === 'claude' ? projectName : `${projectName}_${tool}`;

      return {
        id,
        sourceType: 'claude_md',
        title: `${filename} - ${projectName}`,
        projectPath,
        filePath,
        mtime: stat.mtimeMs,
        contentPreview: firstLine,
        extra: {
          tool,
          filename,
        },
      };
    } catch {
      return null;
    }
  }
}
