/**
 * Subagent-definition memory source — all four tools.
 *
 * Subagents are named agent personas with their own prompt/model/tools.
 * On-disk shapes:
 *   - Claude    — ~/.claude/agents/<name>.md     (+ project .claude/agents)   MD+frontmatter
 *   - Gemini    — ~/.gemini/agents/<name>.md                                  MD+frontmatter
 *   - OpenCode  — ~/.config/opencode/agents/<name>.md                         MD+frontmatter
 *   - Codex     — ~/.codex/agents/<name>.toml                                 TOML
 *
 * The markdown body (or Codex's `developer_instructions` scalar) is the agent's
 * system prompt. We normalize all four into one MemoryItem; `extra.format`
 * records the encoding so the cross-tool sync codec can round-trip.
 *
 * Distinct from "subagent transcripts" (session content indexed elsewhere).
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

type AgentTool = 'claude' | 'gemini' | 'opencode' | 'codex' | 'cursor';

interface AgentRoot {
  path: string;
  tool: AgentTool;
  scope: string;
  projectPath: string;
  format: 'md' | 'toml';
}

function parseAgent(content: string, fallbackName: string, format: 'md' | 'toml'):
  { name: string; description: string; tools: string; body: string } {
  if (format === 'toml') {
    const t = parseScalarToml(content);
    return {
      name: t.name || fallbackName,
      description: t.description || '',
      tools: '',
      body: t.developer_instructions || t.instructions || '',
    };
  }
  const { fm, body } = parseFrontmatter(content);
  return {
    name: fm.name || fallbackName,
    description: fm.description || '',
    tools: fm.tools || '',
    body: body.trim(),
  };
}

export class SubagentsSource implements MemorySource {
  readonly sourceType = 'agent' as SourceType;

  private roots(): AgentRoot[] {
    const roots: AgentRoot[] = [];

    if (isSourceEnabled('claude', 'agents')) {
      roots.push({ path: CLAUDE.agentsDir(), tool: 'claude', scope: 'user', projectPath: '', format: 'md' });
      const projectsRoot = CLAUDE.projectsDir();
      if (existsSync(projectsRoot)) {
        try {
          for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const projectPath = decodeProjectDirName(entry.name);
            const agentDir = join(projectPath, '.claude', 'agents');
            if (existsSync(agentDir)) roots.push({ path: agentDir, tool: 'claude', scope: 'project', projectPath, format: 'md' });
          }
        } catch { /* skip */ }
      }
    }
    if (isSourceEnabled('gemini', 'agents')) {
      roots.push({ path: GEMINI.agentsDir(), tool: 'gemini', scope: 'user', projectPath: '', format: 'md' });
    }
    if (isSourceEnabled('opencode', 'agents')) {
      roots.push({ path: OPENCODE.agentsDir(), tool: 'opencode', scope: 'user', projectPath: '', format: 'md' });
    }
    if (isSourceEnabled('codex', 'agents')) {
      roots.push({ path: CODEX.agentsDir(), tool: 'codex', scope: 'user', projectPath: '', format: 'toml' });
    }
    if (isSourceEnabled('cursor', 'agents')) {
      roots.push({ path: join(cursorHomeDir(), 'agents'), tool: 'cursor', scope: 'user', projectPath: '', format: 'md' });
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
          const parsed = parseAgent(content, basename(file, ext), root.format);
          yield {
            id: `${root.tool}_agent_${root.scope}_${parsed.name}`,
            sourceType: 'agent',
            title: parsed.name,
            projectPath: root.projectPath,
            filePath,
            mtime: stat.mtimeMs,
            contentPreview: (parsed.description || parsed.body).slice(0, 300),
            extra: {
              tool: root.tool,
              agentName: parsed.name,
              description: parsed.description,
              tools: parsed.tools,
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
