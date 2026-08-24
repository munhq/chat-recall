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
 *                 ~/.codex/.tmp/plugins/plugins/<plugin>/.mcp.json
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
import { geminiBackend as GEMINI } from '../core/backends/gemini.js';
import { codexBackend as CODEX } from '../core/backends/codex.js';
import { isSourceEnabled } from '../core/settings.js';
import { cursorHomeDir } from '../core/tool-paths.js';
import { redactInlineSecrets } from '../core/redact-inline.js';

export { redactInlineSecrets };

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
  try {
    const raw = readFileSync(path, 'utf-8');
    // OpenCode allows JSONC (opencode.jsonc) — strip line/block comments and
    // trailing commas before parsing. Cheap and safe for plain JSON too.
    const stripped = path.endsWith('.jsonc')
      ? raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1')
      : raw;
    return JSON.parse(stripped);
  }
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

/**
 * A faithful, SECRET-FREE description of one MCP registration, for rebuilding
 * it on a different machine.
 *
 * `env` VALUES ARE NEVER INCLUDED — only the variable names. An MCP's env is
 * where API keys live, and this payload is uploaded to the server, so shipping
 * the values would publish every key the user has configured. The names are
 * what the other machine needs anyway: it writes the same variable names and
 * tells the user which ones to set locally.
 */
function reconstructionSpec(cfg: McpConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: cfg.type || (cfg.url ? 'remote' : 'local'),
    enabled: cfg.enabled !== false,
  };
  let hidSecret = false;
  const clean = (v: string): string => {
    const r = redactInlineSecrets(v);
    if (r.redacted) hidSecret = true;
    return r.text;
  };
  if (typeof cfg.url === 'string' && cfg.url) out.url = clean(cfg.url);
  // Kept structured: a flattened string cannot be split back into command +
  // args without guessing at quoting.
  if (Array.isArray(cfg.command)) out.command = (cfg.command as unknown as string[]).map(clean);
  else if (typeof cfg.command === 'string') out.command = clean(cfg.command);
  if (Array.isArray(cfg.args)) out.args = (cfg.args as string[]).map((a) => clean(String(a)));
  // The FULL allow-list, not the truncated display copy.
  if (Array.isArray(cfg.alwaysAllow)) out.alwaysAllow = cfg.alwaysAllow as string[];
  if (cfg.env && typeof cfg.env === 'object') out.envKeys = Object.keys(cfg.env).sort();
  // Tell the puller that this entry is incomplete BY DESIGN, so it can say so
  // instead of installing a server that fails to connect.
  if (hidSecret) out.secretsRedacted = true;
  return out;
}

export class McpsSource implements MemorySource {
  readonly sourceType = 'mcp' as SourceType;

  async *discover(): AsyncGenerator<MemoryItem> {
    if (!isSourceEnabled('common', 'mcps')) return;
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

    // OpenCode — `mcp` key. Canonical files are opencode.json[c]; config.json
    // is the legacy name still present on many installs. Scan all of them in
    // both the XDG config dir and the legacy ~/.opencode dir.
    for (const path of [
      join(home, '.config', 'opencode', 'opencode.json'),
      join(home, '.config', 'opencode', 'opencode.jsonc'),
      join(home, '.config', 'opencode', 'config.json'),
      join(home, '.opencode', 'opencode.json'),
      join(home, '.opencode', 'opencode.jsonc'),
      join(home, '.opencode', 'config.json'),
    ]) {
      yield* this.fromObject(readJson(path)?.mcp, {
        tool: 'opencode',
        filePath: path,
        scope: 'user',
      });
    }

    // Gemini — settings.json mcpServers
    const geminiSettings = GEMINI.settingsFile();
    const gemSettings = readJson(geminiSettings);
    yield* this.fromObject(gemSettings?.mcpServers, {
      tool: 'gemini',
      filePath: geminiSettings,
      scope: 'user',
    });

    // Cursor — ~/.cursor/mcp.json, same `mcpServers` shape as Claude.
    const cursorMcp = join(cursorHomeDir(), 'mcp.json');
    yield* this.fromObject(readJson(cursorMcp)?.mcpServers, {
      tool: 'cursor',
      filePath: cursorMcp,
      scope: 'user',
    });

    // Antigravity — its own mcp_config.json under the Gemini config dir.
    const agyMcp = join(home, '.gemini', 'config', 'mcp_config.json');
    yield* this.fromObject(readJson(agyMcp)?.mcpServers, {
      tool: 'agy',
      filePath: agyMcp,
      scope: 'user',
    });

    // Codex — config.toml [mcp_servers.*] + per-plugin .mcp.json files
    yield* this.fromCodexToml(CODEX.configToml());
    const pluginsDir = CODEX.pluginsDir();
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
    ctx: { tool: 'claude' | 'opencode' | 'gemini' | 'codex' | 'agy' | 'cursor'; filePath: string; scope: string },
  ): AsyncGenerator<MemoryItem> {
    if (!obj || typeof obj !== 'object') return;

    let mtime = 0;
    try { mtime = statSync(ctx.filePath).mtimeMs; } catch { /* ignore */ }

    for (const [name, cfgRaw] of Object.entries(obj)) {
      const cfg = (cfgRaw || {}) as McpConfig;
      const cmd = redactInlineSecrets(commandPreview(cfg)).text;
      const allow = Array.isArray(cfg.alwaysAllow) ? (cfg.alwaysAllow as string[]).slice(0, 8) : [];
      const spec = reconstructionSpec(cfg);

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
          // Enough to REBUILD this registration on another machine. The three
          // display fields above cannot do it: `command` flattens a remote
          // MCP's url into a shell string, and `alwaysAllow` is truncated to
          // 8 for the preview — rebuilding from either produces a broken or
          // half-permissioned server, silently.
          spec,
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
