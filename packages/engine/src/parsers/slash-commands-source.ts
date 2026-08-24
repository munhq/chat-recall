/**
 * Slash / custom command memory source — all four tools.
 *
 * Commands are reusable prompt templates invoked as `/name`. Each tool stores
 * them differently:
 *   - Claude    — ~/.claude/commands/<name>.md            (+ project .claude/commands)
 *   - OpenCode  — ~/.config/opencode/commands/<name>.md
 *   - Codex     — ~/.codex/prompts/<name>.md              (flat; invoked /prompts:name)
 *   - Gemini    — ~/.gemini/commands/<name>.toml          (TOML: prompt + description)
 *
 * Markdown forms keep the prompt in the body; Gemini's TOML keeps it in a
 * `prompt` scalar. We normalize both to one MemoryItem so search + the
 * cross-tool sync codec have a single representation. `extra.format` records
 * the on-disk encoding so the codec knows how to round-trip.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
  SourceType,
} from '../types/memory.js';
import { claudeBackend as CLAUDE } from '../core/backends/claude.js';
import { geminiBackend as GEMINI } from '../core/backends/gemini.js';
import { opencodeBackend as OPENCODE } from '../core/backends/opencode.js';
import { codexBackend as CODEX } from '../core/backends/codex.js';
import { isSourceEnabled } from '../core/settings.js';
import { cursorHomeDir } from '../core/tool-paths.js';
import { parseFrontmatter, parseScalarToml } from '../core/toolkit-format.js';
import { decodeProjectDirName } from '../core/project-dir-name.js';

import { redactInlineSecrets } from '../core/redact-inline.js';

const MAX_CHUNK_CHARS = 2000;

/**
 * The artifact's full text, for rebuilding it on another machine.
 *
 * WHY THIS IS SEPARATE FROM THE SEARCH CHUNK. The chunk is capped at 2000
 * characters because that is the right size for FTS and embeddings — and that
 * cap silently truncated 733 of 794 real skills, losing 5.5MB. Reconstructing
 * from a truncated body produces a CORRUPTED skill, which is worse than not
 * syncing it: it looks installed and quietly misbehaves. So the search chunk
 * keeps its cap and the rebuild body is stored whole, redacted.
 */
const MAX_BODY_CHARS = 512 * 1024;   // the largest real skill measured is 139KB

function rebuildBody(content: string): Record<string, unknown> {
  const { text, redacted } = redactInlineSecrets(content);
  const out: Record<string, unknown> = {};
  if (text.length > MAX_BODY_CHARS) {
    // Say so rather than shipping a body that cannot be trusted whole.
    out.body = text.slice(0, MAX_BODY_CHARS);
    out.bodyTruncated = true;
  } else {
    out.body = text;
  }
  if (redacted) out.bodySecretsRedacted = true;
  return out;
}

type CmdTool = 'claude' | 'gemini' | 'opencode' | 'codex' | 'cursor';

interface CmdRoot {
  path: string;
  tool: CmdTool;
  scope: string;
  projectPath: string;
  format: 'md' | 'toml';
}

/** Pull (name, description, body) out of a command file in either encoding. */
function parseCommand(content: string, fallbackName: string, format: 'md' | 'toml'):
  { name: string; description: string; body: string } {
  if (format === 'toml') {
    const t = parseScalarToml(content);
    return {
      name: t.name || fallbackName,
      description: t.description || '',
      body: t.prompt || '',
    };
  }
  const { fm, body } = parseFrontmatter(content);
  return {
    name: fm.name || fallbackName,
    description: fm.description || '',
    body: body.trim(),
  };
}

export class SlashCommandsSource implements MemorySource {
  readonly sourceType = 'command' as SourceType;

  private roots(): CmdRoot[] {
    const roots: CmdRoot[] = [];

    if (isSourceEnabled('claude', 'commands')) {
      roots.push({ path: CLAUDE.commandsDir(), tool: 'claude', scope: 'user', projectPath: '', format: 'md' });
      // Per-project .claude/commands/ — discovered from known project dirs.
      const projectsRoot = CLAUDE.projectsDir();
      if (existsSync(projectsRoot)) {
        try {
          for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const projectPath = decodeProjectDirName(entry.name);
            const cmdDir = join(projectPath, '.claude', 'commands');
            if (existsSync(cmdDir)) roots.push({ path: cmdDir, tool: 'claude', scope: 'project', projectPath, format: 'md' });
          }
        } catch { /* skip */ }
      }
    }
    if (isSourceEnabled('gemini', 'commands')) {
      roots.push({ path: GEMINI.commandsDir(), tool: 'gemini', scope: 'user', projectPath: '', format: 'toml' });
    }
    if (isSourceEnabled('opencode', 'commands')) {
      roots.push({ path: OPENCODE.commandsDir(), tool: 'opencode', scope: 'user', projectPath: '', format: 'md' });
    }
    if (isSourceEnabled('codex', 'commands')) {
      roots.push({ path: CODEX.promptsDir(), tool: 'codex', scope: 'user', projectPath: '', format: 'md' });
    }
    if (isSourceEnabled('cursor', 'commands')) {
      roots.push({ path: join(cursorHomeDir(), 'commands'), tool: 'cursor', scope: 'user', projectPath: '', format: 'md' });
    }
    return roots;
  }

  async *discover(): AsyncGenerator<MemoryItem> {
    for (const root of this.roots()) {
      const ext = root.format === 'toml' ? '.toml' : '.md';
      let files: string[];
      try { files = readdirSync(root.path).filter(f => f.endsWith(ext)); } catch { continue; }
      for (const file of files) {
        const filePath = join(root.path, file);
        try {
          const stat = statSync(filePath);
          const content = readFileSync(filePath, 'utf-8');
          const parsed = parseCommand(content, basename(file, ext), root.format);
          yield {
            id: `${root.tool}_cmd_${root.scope}_${parsed.name}`,
            sourceType: 'command',
            title: parsed.name,
            projectPath: root.projectPath,
            filePath,
            mtime: stat.mtimeMs,
            contentPreview: (parsed.description || parsed.body).slice(0, 300),
            extra: {
              tool: root.tool,
              commandName: parsed.name,
              description: parsed.description,
              scope: root.scope,
              format: root.format,
              // The whole file, so another machine can rebuild it. The search
              // chunk stays capped at 2000 chars; this does not.
              ...rebuildBody(content),
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
