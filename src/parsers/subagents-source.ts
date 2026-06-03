/**
 * Subagent definitions memory source.
 *
 * Claude Code stores subagent definitions as markdown files at
 * ~/.claude/agents/<name>.md (user-level) and .claude/agents/<name>.md
 * (per-project). The frontmatter has `name` and `description`; the body
 * is the agent's system prompt.
 *
 * Distinct from "subagent transcripts" which live in session subagents/
 * directories — those are session content, indexed by SessionSource.
 *
 * Gemini and OpenCode don't have user-definable subagent files in the
 * same shape, so this source is Claude-only.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
  SourceType,
} from '../types/memory.js';
import { claudeBackend as CLAUDE } from '../core/backends/claude.js';
import { isSourceEnabled } from '../core/settings.js';

const MAX_CHUNK_CHARS = 2000;

function parseFrontmatter(text: string): { name?: string; description?: string; tools?: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: { name?: string; description?: string; tools?: string } = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const k = kv[1].toLowerCase();
    const v = kv[2].trim().replace(/^["']|["']$/g, '');
    if (k === 'name') out.name = v;
    if (k === 'description') out.description = v;
    if (k === 'tools') out.tools = v;
  }
  return out;
}

export class SubagentsSource implements MemorySource {
  readonly sourceType = 'agent' as SourceType;

  async *discover(): AsyncGenerator<MemoryItem> {
    if (!isSourceEnabled('claude', 'agents')) return;
    const roots: { path: string; scope: string; projectPath: string }[] = [
      { path: CLAUDE.agentsDir(), scope: 'user', projectPath: '' },
    ];

    const projectsRoot = CLAUDE.projectsDir();
    if (existsSync(projectsRoot)) {
      try {
        for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const projectPath = entry.name.replace(/^-/, '/').replace(/-/g, '/');
          const agentDir = join(projectPath, '.claude', 'agents');
          if (existsSync(agentDir)) roots.push({ path: agentDir, scope: 'project', projectPath });
        }
      } catch { /* skip */ }
    }

    for (const root of roots) {
      let files: string[];
      try { files = readdirSync(root.path).filter(f => f.endsWith('.md')); } catch { continue; }
      for (const file of files) {
        const filePath = join(root.path, file);
        try {
          const stat = statSync(filePath);
          const content = readFileSync(filePath, 'utf-8');
          const fm = parseFrontmatter(content);
          const agentName = fm.name || basename(file, '.md');
          yield {
            id: `claude_agent_${root.scope}_${agentName}`,
            sourceType: 'agent',
            title: agentName,
            projectPath: root.projectPath,
            filePath,
            mtime: stat.mtimeMs,
            contentPreview: (fm.description || content.replace(/^---[\s\S]*?---/, '').trim()).slice(0, 300),
            extra: {
              tool: 'claude',
              agentName,
              description: fm.description || '',
              tools: fm.tools || '',
              scope: root.scope,
            },
          };
        } catch { /* skip */ }
      }
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(item.filePath)) return [];
    const content = readFileSync(item.filePath, 'utf-8');
    if (!content.trim()) return [];
    return [{
      chunkId: `${item.id}_agent`,
      itemId: item.id,
      sourceType: 'agent',
      title: item.title,
      text: content.slice(0, MAX_CHUNK_CHARS),
      chunkType: 'agent',
      projectPath: item.projectPath,
      filePath: item.filePath,
      mtime: item.mtime,
    }];
  }

  async extractLinks(_item: MemoryItem): Promise<MemoryLink[]> {
    return [];
  }
}
