/**
 * MCPs memory source.
 *
 * Each AI tool stores MCP server configuration in its own file with a
 * slightly different shape. We normalize them into MemoryItems so the UI
 * can show "what MCPs are configured where", and so a future "promote to
 * Claude too" action has a single representation to work with.
 *
 * Sources scanned:
 *   - Claude    — ~/.mcp.json (mcpServers)
 *                 ~/.claude.json (mcpServers, user-level)
 *   - OpenCode  — ~/.config/opencode/config.json (mcp)
 *                 ~/.opencode/config.json (mcp, alt path)
 *   - Gemini    — ~/.gemini/settings.json (mcpServers)
 *   - Codex     — ~/.codex/config.toml [mcp_servers.*]
 *                 ~/.codex/.tmp/plugins/<plugin>/.mcp.json
 *
 * Each MCP entry yields one MemoryItem keyed by `<tool>_mcp_<name>`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
  SourceType,
} from '../types/memory.js';

interface McpConfig {
  command?: string;
  args?: unknown;
  env?: Record<string, string>;
  type?: string;       // OpenCode shape ('local' | 'remote')
  url?: string;        // remote MCPs
  alwaysAllow?: unknown;
  enabled?: unknown;
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return null; }
}

function commandPreview(cfg: McpConfig): string {
  if (cfg.url && typeof cfg.url === 'string') return cfg.url;
  // OpenCode stores command as string[]; Claude/Gemini store command + args[].
  if (Array.isArray(cfg.command)) return (cfg.command as unknown as string[]).join(' ');
  if (typeof cfg.command === 'string') {
    const args = Array.isArray(cfg.args) ? (cfg.args as string[]).join(' ') : '';
    return [cfg.command, args].filter(Boolean).join(' ');
  }
  return '';
}

export class McpsSource implements MemorySource {
  readonly sourceType = 'mcp' as SourceType;

  async *discover(): AsyncGenerator<MemoryItem> {
    const home = homedir();

    // Claude — ~/.mcp.json (project/global) and ~/.claude.json (user)
    yield* this.fromObject(readJson(join(home, '.mcp.json'))?.mcpServers, {
      tool: 'claude',
      filePath: join(home, '.mcp.json'),
      scope: 'global',
    });
    yield* this.fromObject(readJson(join(home, '.claude.json'))?.mcpServers, {
      tool: 'claude',
      filePath: join(home, '.claude.json'),
      scope: 'user',
    });

    // OpenCode — config.json `mcp` key (two possible locations)
    for (const path of [
      join(home, '.config', 'opencode', 'config.json'),
      join(home, '.opencode', 'config.json'),
    ]) {
      yield* this.fromObject(readJson(path)?.mcp, {
        tool: 'opencode',
        filePath: path,
        scope: 'user',
      });
    }

    // Gemini — settings.json mcpServers
    const gemSettings = readJson(join(home, '.gemini', 'settings.json'));
    yield* this.fromObject(gemSettings?.mcpServers, {
      tool: 'gemini',
      filePath: join(home, '.gemini', 'settings.json'),
      scope: 'user',
    });

    // Codex — ~/.codex/config.toml [mcp_servers.*] and plugin .mcp.json files
    yield* this.fromCodexToml(join(home, '.codex', 'config.toml'));
    const pluginsDir = join(home, '.codex', '.tmp', 'plugins');
    if (existsSync(pluginsDir)) {
      for (const plugin of readdirSync(pluginsDir)) {
        const mcpPath = join(pluginsDir, plugin, '.mcp.json');
        yield* this.fromObject(readJson(mcpPath)?.mcpServers, {
          tool: 'codex',
          filePath: mcpPath,
          scope: 'plugin',
        });
      }
    }
  }

  private async *fromObject(
    obj: Record<string, McpConfig> | undefined | null,
    ctx: { tool: 'claude' | 'opencode' | 'gemini' | 'codex'; filePath: string; scope: string },
  ): AsyncGenerator<MemoryItem> {
    if (!obj || typeof obj !== 'object') return;

    let mtime = 0;
    try { mtime = statSync(ctx.filePath).mtimeMs; } catch { /* ignore */ }

    for (const [name, cfgRaw] of Object.entries(obj)) {
      const cfg = (cfgRaw || {}) as McpConfig;
      const cmd = commandPreview(cfg);
      const allow = Array.isArray(cfg.alwaysAllow) ? (cfg.alwaysAllow as string[]).slice(0, 8) : [];

      yield {
        id: `${ctx.tool}_mcp_${name}`,
        sourceType: 'mcp',
        title: name,
        projectPath: '', // MCPs are global config, not project-scoped
        filePath: ctx.filePath,
        mtime,
        contentPreview: cmd.slice(0, 300),
        extra: {
          tool: ctx.tool,
          mcpName: name,
          scope: ctx.scope,
          command: cmd,
          alwaysAllow: allow,
          type: cfg.type || (cfg.url ? 'remote' : 'local'),
          enabled: cfg.enabled !== false,
        },
      };
    }
  }

  private async *fromCodexToml(path: string): AsyncGenerator<MemoryItem> {
    if (!existsSync(path)) return;
    let content: string;
    try { content = readFileSync(path, 'utf-8'); }
    catch { return; }

    const servers: Record<string, McpConfig> = {};
    let currentName: string | null = null;
    let currentEnv: Record<string, string> | undefined;

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const envMatch = line.match(/^\[mcp_servers\.([^\.\]]+)\.env\]$/);
      if (envMatch) {
        currentName = envMatch[1];
        if (!servers[currentName]) servers[currentName] = {};
        currentEnv = servers[currentName].env || {};
        servers[currentName].env = currentEnv;
        continue;
      }

      const serverMatch = line.match(/^\[mcp_servers\.([^\.\]]+)\]$/);
      if (serverMatch) {
        currentName = serverMatch[1];
        if (!servers[currentName]) servers[currentName] = {};
        currentEnv = undefined;
        continue;
      }

      const propMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
      if (!propMatch) continue;
      const key = propMatch[1];
      let value = propMatch[2].trim();

      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (currentName && currentEnv !== undefined) {
        currentEnv[key] = value;
      } else if (currentName) {
        if (key === 'args' && value.startsWith('[')) {
          try { servers[currentName].args = JSON.parse(value); }
          catch { servers[currentName].args = value; }
        } else {
          (servers[currentName] as any)[key] = value;
        }
      }
    }

    yield* this.fromObject(servers, {
      tool: 'codex',
      filePath: path,
      scope: 'user',
    });
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    // The "content" of an MCP is its command + alwaysAllow list — short and
    // stable. One small chunk is enough for FTS/vector search to find it
    // by name or by tool surface area.
    const extra = (item.extra || {}) as Record<string, unknown>;
    const cmd = String(extra.command || '');
    const allow = Array.isArray(extra.alwaysAllow) ? (extra.alwaysAllow as string[]).join(', ') : '';
    const text = [
      `MCP: ${item.title}`,
      `Tool: ${extra.tool || 'unknown'}`,
      `Scope: ${extra.scope || ''}`,
      `Command: ${cmd}`,
      allow ? `Always allow: ${allow}` : '',
    ].filter(Boolean).join('\n');

    return [{
      chunkId: `${item.id}_mcp`,
      itemId: item.id,
      sourceType: 'mcp',
      title: item.title,
      text,
      chunkType: 'mcp',
      projectPath: item.projectPath,
      filePath: item.filePath,
      mtime: item.mtime,
    }];
  }

  async extractLinks(_item: MemoryItem): Promise<MemoryLink[]> {
    return [];
  }
}
