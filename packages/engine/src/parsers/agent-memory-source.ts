/**
 * Per-project agent memory source.
 *
 * Claude Code agents write persistent reference / feedback / project-state
 * notes into `~/.claude/projects/<project-hash>/memory/*.md`. These files
 * carry YAML frontmatter (`name`, `description`, `originSessionId`, …) and
 * are the single richest source of cross-session knowledge an agent has —
 * but they were never indexed, so `recall_memory_search` couldn't find
 * them. This source fixes that.
 *
 * Discovery roots (same multi-install convention as the other Claude
 * sources — `~/.claude`, `~/.claude-*`, all via the Claude backend):
 *   <claudeHome>/projects/<project-hash>/memory/*.md
 *
 * Each file becomes one MemoryItem under source_type='agent_memory'. The
 * `id` is the frontmatter `name` when present (stable across edits) and
 * falls back to the filename stem. `projectPath` is derived from the
 * parent project-hash dir so these show up under the right project in the
 * UI and link to sibling sessions/plans.
 *
 * Links:
 *   - agent_memory → session  (via frontmatter `originSessionId`, when set)
 *   - agent_memory → project  (self-referential marker, like ClaudeMdSource)
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
import { claudeBackend as CLAUDE } from '../core/backends/claude.js';
import { isSourceEnabled } from '../core/settings.js';
import { resolveProjectDirName } from '../core/project-dir-name.js';

const MAX_CHUNK_CHARS = 2000;
const MAX_CHUNKS = 12;

interface Frontmatter {
  name?: string;
  description?: string;
  originSessionId?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Parse a leading YAML-ish frontmatter block (---\n…\n---). We don't pull
 * in a full YAML parser to keep the engine dependency-free; this handles
 * the flat `key: value` shape Claude Code's memory files actually use.
 */
function parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
  const fm: Frontmatter = {};
  let body = content;
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (m) {
    body = m[2];
    for (const line of m[1].split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf(':');
      if (i <= 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (k) fm[k] = v;
    }
  }
  return { fm, body };
}

/**
 * Resolve a Claude project-hash dir name back to a filesystem path:
 *   -home-user-code-personal-chat-recall → /home/user/code/personal/chat-recall
 */
function projectHashToPath(hashDir: string): string {
  return resolveProjectDirName(hashDir);
}

/** List the `memory/` dirs that actually exist under <claudeHome>/projects/. */
function discoverMemoryDirs(): Array<{ memoryDir: string; projectHash: string }> {
  const out: Array<{ memoryDir: string; projectHash: string }> = [];
  const seen = new Set<string>();
  const add = (memoryDir: string, projectHash: string) => {
    if (!seen.has(memoryDir) && existsSync(memoryDir)) {
      seen.add(memoryDir);
      out.push({ memoryDir, projectHash });
    }
  };

  // Primary + multi-profile ~/.claude-* / ~/.claude-<suffix>/projects
  const home = homedir();
  const claudeRoots: string[] = [CLAUDE.projectsDir()];
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.claude-') && entry.name !== '.claude-code') {
        claudeRoots.push(join(home, entry.name, 'projects'));
      }
    }
  } catch { /* tolerate */ }

  for (const projectsDir of claudeRoots) {
    if (!existsSync(projectsDir)) continue;
    try {
      for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        add(join(projectsDir, entry.name, 'memory'), entry.name);
      }
    } catch { /* tolerate */ }
  }

  return out;
}

export class AgentMemorySource implements MemorySource {
  readonly sourceType = 'agent_memory' as const;

  async *discover(): AsyncGenerator<MemoryItem> {
    if (!isSourceEnabled('claude', 'agentMemory')) return;

    const seen = new Set<string>();
    for (const { memoryDir, projectHash } of discoverMemoryDirs()) {
      const projectPath = projectHashToPath(projectHash);
      try {
        for (const entry of readdirSync(memoryDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const filePath = join(memoryDir, entry.name);
          if (seen.has(filePath)) continue;
          seen.add(filePath);

          const item = this.fileToItem(filePath, entry.name, projectPath, projectHash);
          if (item) yield item;
        }
      } catch { continue; }
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(item.filePath)) return [];
    const content = readFileSync(item.filePath, 'utf-8');
    const { body } = parseFrontmatter(content);

    const chunks: MemoryChunk[] = [];
    const sections = splitByHeaders(body);

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (!section.text.trim() || section.text.trim().length < 20) continue;

      const chunkType = i === 0 ? 'agent_memory_overview' : 'agent_memory_section';
      const text = section.text.slice(0, MAX_CHUNK_CHARS);

      chunks.push({
        chunkId: `${item.id}_${chunkType}_${i}`,
        itemId: item.id,
        sourceType: 'agent_memory',
        title: section.heading || item.title,
        text,
        chunkType,
        projectPath: item.projectPath,
        filePath: item.filePath,
        mtime: item.mtime,
      });
    }

    return chunks.slice(0, MAX_CHUNKS);
  }

  async extractLinks(item: MemoryItem): Promise<MemoryLink[]> {
    const links: MemoryLink[] = [];
    const extra = item.extra || {};
    const originSessionId = extra.originSessionId as string | undefined;

    // Link to the originating session when frontmatter carries it.
    if (originSessionId) {
      links.push({
        sourceType: 'agent_memory',
        sourceId: item.id,
        targetType: 'session',
        targetId: originSessionId,
        linkType: 'agent_memory_from_session',
        confidence: 1.0,
      });
    }

    // Self-referential project marker (same convention as ClaudeMdSource).
    if (item.projectPath) {
      links.push({
        sourceType: 'agent_memory',
        sourceId: item.id,
        targetType: 'agent_memory',
        targetId: item.projectPath,
        linkType: 'agent_memory_for_project',
        confidence: 1.0,
      });
    }

    return links;
  }

  private fileToItem(
    filePath: string,
    filename: string,
    projectPath: string,
    _projectHash: string,
  ): MemoryItem | null {
    try {
      const stat = statSync(filePath);
      const content = readFileSync(filePath, 'utf-8');
      const { fm } = parseFrontmatter(content);

      // Stable id: frontmatter `name` if present, else the filename stem.
      // Prefix with the project hash so two projects with a `MEMORY.md`
      // don't collide.
      const stem = filename.replace(/\.md$/, '');
      const idBase = fm.name || stem;
      const id = `agent_memory:${projectPath.endsWith('/') ? projectPath : projectPath}/${idBase}`;

      const title = fm.description
        ? `${fm.description}`.slice(0, 200)
        : `${stem} - ${basename(projectPath) || projectPath}`;

      // First non-empty, non-frontmatter line as a preview fallback.
      const bodyPreview = content.split('\n')
        .find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'))
        ?.trim()
        ?.slice(0, 200) || title;

      return {
        id,
        sourceType: 'agent_memory',
        title,
        projectPath,
        filePath,
        mtime: stat.mtimeMs,
        contentPreview: bodyPreview,
        extra: {
          name: fm.name,
          description: fm.description,
          originSessionId: fm.originSessionId,
          filename,
        },
      };
    } catch {
      return null;
    }
  }
}