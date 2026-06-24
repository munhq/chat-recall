/**
 * Skills memory source.
 *
 * Discovers skill packs across the AI tools that support them. Each tool
 * uses the same on-disk shape — a directory containing `SKILL.md` with
 * yaml frontmatter (`name`, `description`) plus optional `references/`
 * and `scripts/` subdirectories.
 *
 * Roots scanned (every tool uses the same SKILL.md shape, so a skill is the
 * one artifact that needs NO format translation to move between tools):
 *   - Shared    — ~/.agents/skills/<name>/SKILL.md          (tool-neutral standard,
 *                 read by Claude, Gemini, OpenCode and Codex alike)
 *   - Claude    — ~/.claude/skills/<name>/SKILL.md
 *   - Gemini    — ~/.gemini/skills/<name>/SKILL.md
 *   - OpenCode  — ~/.config/opencode/{skills,skill}/<name>/SKILL.md
 *                 ~/.opencode/{skill,skills}/<name>/SKILL.md
 *   - Codex     — ~/.codex/skills/<name>/SKILL.md           (user-authored)
 *                 ~/.codex/skills/.system/<name>/SKILL.md   (OpenAI bundled, READ-ONLY)
 *                 ~/.codex/.tmp/plugins/plugins/<plugin>/skills/<name>/SKILL.md
 *
 * Each skill yields one MemoryItem with extra.tool tagging the source. Skills
 * tagged `shared` already live in the tool-neutral location every tool reads,
 * so the sync layer treats them as present-everywhere. System/plugin skills
 * carry extra.readonly so the UI never offers to overwrite or promote them.
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
import { geminiBackend as GEMINI } from '../core/backends/gemini.js';
import { codexBackend as CODEX } from '../core/backends/codex.js';
import { isSourceEnabled } from '../core/settings.js';

const MAX_CHUNK_CHARS = 2000;

export type SkillTool = 'shared' | 'claude' | 'gemini' | 'opencode' | 'codex';

interface SkillRoot {
  path: string;
  tool: SkillTool;
  /** Skip these immediate child dir names (e.g. Codex's `.system` container). */
  skipChildren?: string[];
  /** Mark every skill found here read-only (bundled/system — never sync target). */
  readonly?: boolean;
}

function resolveRoots(): SkillRoot[] {
  // Per-tool skill toggles — emit only the roots whose tool is enabled.
  const home = homedir();
  const all: SkillRoot[] = [];

  // Tool-neutral standard location, read by every tool.
  if (isSourceEnabled('shared', 'skills')) {
    all.push({ path: join(home, '.agents', 'skills'), tool: 'shared' });
  }
  if (isSourceEnabled('claude', 'skills')) {
    all.push({ path: CLAUDE.skillsDir(), tool: 'claude' });
  }
  if (isSourceEnabled('gemini', 'skills')) {
    all.push({ path: GEMINI.skillsDir(), tool: 'gemini' });
  }
  if (isSourceEnabled('opencode', 'skills')) {
    all.push(
      { path: join(home, '.config', 'opencode', 'skills'), tool: 'opencode' },
      { path: join(home, '.config', 'opencode', 'skill'),  tool: 'opencode' },
      { path: join(home, '.opencode', 'skill'),            tool: 'opencode' },
      { path: join(home, '.opencode', 'skills'),           tool: 'opencode' },
    );
  }
  if (isSourceEnabled('codex', 'skills')) {
    // User skills sit directly under ~/.codex/skills; `.system` is OpenAI's
    // read-only bundle and is scanned separately as a distinct root.
    all.push({ path: CODEX.skillsDir(), tool: 'codex', skipChildren: ['.system'] });
    all.push({ path: CODEX.skillsSystemDir(), tool: 'codex', readonly: true });
  }
  return all.filter(r => existsSync(r.path));
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

    // Codex plugin skills live at ~/.codex/.tmp/plugins/plugins/<plugin>/skills/<name>/SKILL.md
    // — the doubled "plugins" segment is intentional in Codex's on-disk layout.
    if (!isSourceEnabled('codex', 'skills')) return;
    const codexPluginsDir = CODEX.pluginsDir();
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
      if (root.skipChildren?.includes(name)) continue;
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
      // Bundled/system/plugin skills are read-only: never a sync target and
      // never offered for promotion. Shared skills live in the tool-neutral
      // location every tool already reads.
      if (root.readonly || pluginName !== undefined) extra.readonly = true;
      if (root.tool === 'shared') extra.shared = true;
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
