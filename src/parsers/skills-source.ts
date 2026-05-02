/**
 * Skills memory source.
 *
 * Discovers skill packs across the AI tools that support them. Each tool
 * uses the same on-disk shape — a directory containing `SKILL.md` with
 * yaml frontmatter (`name`, `description`) plus optional `references/`
 * and `scripts/` subdirectories.
 *
 * Roots scanned:
 *   - Claude    — ~/.claude/skills/<name>/SKILL.md
 *   - OpenCode  — ~/.config/opencode/skill/<name>/SKILL.md
 *                 ~/.opencode/skill/<name>/SKILL.md
 *                 ~/.opencode/skills/<name>/SKILL.md
 *   - Codex     — ~/.codex/skills/.system/<name>/SKILL.md
 *                 ~/.codex/.tmp/plugins/<plugin>/skills/<name>/SKILL.md
 *   - Gemini    — no first-class skills concept; extensions under
 *                 ~/.gemini/extensions/ are surfaced as MCPs instead.
 *
 * Each skill yields one MemoryItem with extra.tool tagging the source.
 * The "name" field from yaml frontmatter is the canonical id within a tool.
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

interface SkillRoot {
  path: string;
  tool: 'claude' | 'opencode' | 'codex';
}

function resolveRoots(): SkillRoot[] {
  const home = homedir();
  return [
    { path: join(home, '.claude', 'skills'),         tool: 'claude' as const },
    { path: join(home, '.config', 'opencode', 'skill'),  tool: 'opencode' as const },
    { path: join(home, '.opencode', 'skill'),        tool: 'opencode' as const },
    { path: join(home, '.opencode', 'skills'),       tool: 'opencode' as const },
    { path: join(home, '.codex', 'skills', '.system'), tool: 'codex' as const },
  ].filter(r => existsSync(r.path));
}

/** Pull `name`/`description` out of a SKILL.md yaml frontmatter block. */
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

export class SkillsSource implements MemorySource {
  readonly sourceType = 'skill' as SourceType;

  async *discover(): AsyncGenerator<MemoryItem> {
    for (const root of resolveRoots()) {
      yield* this.fromSkillRoot(root);
    }

    // Codex plugin skills: ~/.codex/.tmp/plugins/<plugin>/skills/<name>/SKILL.md
    const codexPluginsDir = join(homedir(), '.codex', '.tmp', 'plugins');
    if (existsSync(codexPluginsDir)) {
      for (const pluginName of readdirSync(codexPluginsDir)) {
        const skillsDir = join(codexPluginsDir, pluginName, 'skills');
        if (!existsSync(skillsDir)) continue;
        yield* this.fromSkillRoot({ path: skillsDir, tool: 'codex' as const }, pluginName);
      }
    }
  }

  private async *fromSkillRoot(root: SkillRoot, pluginName?: string): AsyncGenerator<MemoryItem> {
    let entries: string[];
    try { entries = readdirSync(root.path); } catch { return; }

    for (const name of entries) {
      const skillDir = join(root.path, name);
      let st;
      try { st = statSync(skillDir); } catch { continue; }
      if (!st.isDirectory()) continue;

      const skillMd = join(skillDir, 'SKILL.md');
      if (!existsSync(skillMd)) continue;

      let content: string;
      try { content = readFileSync(skillMd, 'utf-8'); } catch { continue; }

      const fm = parseFrontmatter(content);
      const skillName = fm.name || name;
      let mtime = st.mtimeMs;
      try { mtime = statSync(skillMd).mtimeMs; } catch { /* keep dir mtime */ }

      // Inventory aux assets so the UI can show "scripts: 3 · references: 2".
      const subdirs: Record<string, number> = {};
      try {
        for (const sub of readdirSync(skillDir)) {
          const subPath = join(skillDir, sub);
          try {
            const ss = statSync(subPath);
            if (ss.isDirectory()) {
              let count = 0;
              try { count = readdirSync(subPath).length; } catch {}
              subdirs[sub] = count;
            }
          } catch {}
        }
      } catch {}

      const extra: Record<string, unknown> = {
        tool: root.tool,
        skillName,
        description: fm.description || '',
        skillDir,
        subdirs,
      };
      if (pluginName !== undefined) {
        extra.plugin = pluginName;
      }

      yield {
        id: `${root.tool}_skill_${skillName}`,
        sourceType: 'skill',
        title: skillName,
        projectPath: '', // skills are global, not per-project
        filePath: skillMd,
        mtime,
        contentPreview: (fm.description || content.slice(0, 300)).slice(0, 300),
        extra,
      };
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(item.filePath)) return [];
    const content = readFileSync(item.filePath, 'utf-8');
    if (!content.trim()) return [];

    return [{
      chunkId: `${item.id}_skill`,
      itemId: item.id,
      sourceType: 'skill',
      title: item.title,
      text: content.slice(0, MAX_CHUNK_CHARS),
      chunkType: 'skill',
      projectPath: item.projectPath,
      filePath: item.filePath,
      mtime: item.mtime,
    }];
  }

  async extractLinks(_item: MemoryItem): Promise<MemoryLink[]> {
    return [];
  }
}
