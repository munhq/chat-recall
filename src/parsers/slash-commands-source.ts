/**
 * Slash commands memory source.
 *
 * Claude Code stores user-defined slash commands as markdown files at
 * ~/.claude/commands/<name>.md plus per-project .claude/commands/<name>.md.
 * Each file's frontmatter (name, description) describes the command.
 *
 * Gemini and OpenCode don't have an analogous user-defined slash command
 * surface today, so this source is Claude-only.
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

const MAX_CHUNK_CHARS = 2000;

function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const k = kv[1].toLowerCase();
    const v = kv[2].trim().replace(/^["']|["']$/g, '');
    if (k === 'name') out.name = v;
    if (k === 'description') out.description = v;
  }
  return out;
}

export class SlashCommandsSource implements MemorySource {
  readonly sourceType = 'command' as SourceType;

  async *discover(): AsyncGenerator<MemoryItem> {
    const home = homedir();
    const roots: { path: string; scope: string }[] = [
      { path: join(home, '.claude', 'commands'), scope: 'user' },
    ];

    // Per-project .claude/commands/ — discover from known project dirs.
    const projectsRoot = join(home, '.claude', 'projects');
    if (existsSync(projectsRoot)) {
      try {
        for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const projectPath = entry.name.replace(/^-/, '/').replace(/-/g, '/');
          const cmdDir = join(projectPath, '.claude', 'commands');
          if (existsSync(cmdDir)) roots.push({ path: cmdDir, scope: 'project' });
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
          const cmdName = fm.name || basename(file, '.md');
          yield {
            id: `claude_cmd_${root.scope}_${cmdName}`,
            sourceType: 'command',
            title: cmdName,
            projectPath: root.scope === 'project'
              ? root.path.replace(/\/\.claude\/commands$/, '')
              : '',
            filePath,
            mtime: stat.mtimeMs,
            contentPreview: (fm.description || content.replace(/^---[\s\S]*?---/, '').trim()).slice(0, 300),
            extra: {
              tool: 'claude',
              commandName: cmdName,
              description: fm.description || '',
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
      chunkId: `${item.id}_command`,
      itemId: item.id,
      sourceType: 'command',
      title: item.title,
      text: content.slice(0, MAX_CHUNK_CHARS),
      chunkType: 'command',
      projectPath: item.projectPath,
      filePath: item.filePath,
      mtime: item.mtime,
    }];
  }

  async extractLinks(_item: MemoryItem): Promise<MemoryLink[]> {
    return [];
  }
}
