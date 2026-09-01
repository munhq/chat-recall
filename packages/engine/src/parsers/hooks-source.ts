/**
 * Claude Code hooks memory source.
 *
 * Reads the `hooks` block from ~/.claude/settings.json and per-project
 * .claude/settings.json. Each event (SessionStart, PostToolUse, etc.) can
 * have multiple hook commands; we yield one MemoryItem per (event,
 * command) tuple so they can be filtered, searched, and promoted
 * individually.
 *
 * Gemini and OpenCode don't expose user-defined hooks in the same shape.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
  SourceType,
} from '../types/memory.js';
import { claudeBackend as CLAUDE } from '../core/backends/claude.js';
import { isSourceEnabled } from '../core/settings.js';
import { resolveProjectDirName } from '../core/project-dir-name.js';

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
  async?: boolean;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return null; }
}

export class HooksSource implements MemorySource {
  readonly sourceType = 'hook' as SourceType;

  async *discover(): AsyncGenerator<MemoryItem> {
    if (!isSourceEnabled('claude', 'hooks')) return;
    // 1) User-level settings.
    yield* this.fromSettings(CLAUDE.settingsFile(), 'user', '');

    // 2) Per-project .claude/settings.json — discovered via projects index.
    const projectsRoot = CLAUDE.projectsDir();
    if (existsSync(projectsRoot)) {
      try {
        for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const projectPath = resolveProjectDirName(entry.name);
          const settingsPath = join(projectPath, '.claude', 'settings.json');
          if (existsSync(settingsPath)) {
            yield* this.fromSettings(settingsPath, 'project', projectPath);
          }
        }
      } catch { /* skip */ }
    }
  }

  private async *fromSettings(
    settingsPath: string,
    scope: 'user' | 'project',
    projectPath: string,
  ): AsyncGenerator<MemoryItem> {
    const json = readJson(settingsPath);
    if (!json || typeof json !== 'object') return;
    const hooks = json.hooks;
    if (!hooks || typeof hooks !== 'object') return;

    let mtime = 0;
    try { mtime = statSync(settingsPath).mtimeMs; } catch { /* ignore */ }

    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      let groupIdx = 0;
      for (const groupRaw of groups) {
        const group = groupRaw as HookGroup;
        const inner = Array.isArray(group.hooks) ? group.hooks : [];
        let hookIdx = 0;
        for (const h of inner) {
          const cmd = (h.command || '').toString();
          if (!cmd) { hookIdx++; continue; }
          const id = `claude_hook_${scope}_${event}_${groupIdx}_${hookIdx}`;
          const matcherSuffix = group.matcher ? ` (${group.matcher})` : '';
          yield {
            id,
            sourceType: 'hook',
            title: `${event}${matcherSuffix}`,
            projectPath,
            filePath: settingsPath,
            mtime,
            contentPreview: cmd.slice(0, 300),
            extra: {
              tool: 'claude',
              event,
              matcher: group.matcher || '',
              command: cmd,
              hookType: h.type || 'command',
              timeout: h.timeout || 0,
              async: !!h.async,
              scope,
            },
          };
          hookIdx++;
        }
        groupIdx++;
      }
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    const extra = (item.extra || {}) as Record<string, unknown>;
    const cmd = String(extra.command || '');
    const text = [
      `Hook: ${item.title}`,
      `Event: ${extra.event || ''}`,
      extra.matcher ? `Matcher: ${extra.matcher}` : '',
      `Command: ${cmd}`,
      `Scope: ${extra.scope || ''}`,
    ].filter(Boolean).join('\n');

    return [{
      chunkId: `${item.id}_hook`,
      itemId: item.id,
      sourceType: 'hook',
      title: item.title,
      text,
      chunkType: 'hook',
      projectPath: item.projectPath,
      filePath: item.filePath,
      mtime: item.mtime,
    }];
  }

  async extractLinks(_item: MemoryItem): Promise<MemoryLink[]> {
    return [];
  }
}
