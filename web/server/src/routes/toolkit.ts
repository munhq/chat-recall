/**
 * Toolkit routes — config-y primitives that span AI tools (Claude, Gemini,
 * OpenCode, Codex). These are surfaced under the dedicated Toolkit UI tab.
 *
 * Distinct from /api/memory/* which handles "what was said / what happened"
 * primitives (sessions, plans, notes, tasks, paste, history, diary). Both
 * routes back the same MemoryStore but expose different validators so the
 * UI separation is honest at the API layer too.
 */

import express from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'fs';
import { dirname, join, basename } from 'path';
import { homedir } from 'os';
import { MemoryStore } from '../imports.js';
import type { SourceType } from '../imports.js';

const router = express.Router();

const VALID_TOOLKIT_TYPES = ['skill', 'mcp', 'command', 'agent', 'hook', 'plugin'] as const;
type ToolkitType = (typeof VALID_TOOLKIT_TYPES)[number];

function isToolkitType(t: string): t is ToolkitType {
  return (VALID_TOOLKIT_TYPES as readonly string[]).includes(t);
}

// GET /api/toolkit/status — counts per (type, tool) so the UI can render
// "skill: 43 claude · 43 opencode · 0 gemini" without listing items.
router.get('/status', (_req, res) => {
  const store = new MemoryStore();
  try {
    const out: Record<string, Record<string, number>> = {};
    for (const t of VALID_TOOLKIT_TYPES) {
      out[t] = { claude: 0, gemini: 0, opencode: 0, codex: 0 };
      const items = store.listItems(t as SourceType, 5000, 0);
      for (const it of items) {
        let tool = 'claude';
        try { tool = JSON.parse(it.extra_json || '{}').tool || 'claude'; } catch {}
        if (tool in out[t]) out[t][tool]++;
      }
    }
    res.json({ counts: out });
  } catch (error) {
    console.error('Toolkit status error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally { store.close(); }
});

// GET /api/toolkit/browse/:type?limit=&offset=&tool=
router.get('/browse/:type', (req, res) => {
  const { type } = req.params;
  if (!isToolkitType(type)) {
    return res.status(400).json({ error: `Invalid toolkit type: ${type}. Allowed: ${VALID_TOOLKIT_TYPES.join(', ')}` });
  }
  const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 200, 5000));
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const toolFilter = (req.query.tool as string | undefined)?.trim().toLowerCase();

  const store = new MemoryStore();
  try {
    let items = store.listItems(type as SourceType, limit + offset + 100, 0);
    if (toolFilter && toolFilter !== 'all') {
      items = items.filter(it => {
        try { return (JSON.parse(it.extra_json || '{}').tool || 'claude') === toolFilter; }
        catch { return toolFilter === 'claude'; }
      });
    }
    items = items.slice(offset, offset + limit);
    res.json({ items, type, count: items.length });
  } catch (error) {
    console.error('Toolkit browse error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally { store.close(); }
});

// GET /api/toolkit/item/:type/:id
router.get('/item/:type/:id', (req, res) => {
  const { type, id } = req.params;
  if (!isToolkitType(type)) {
    return res.status(400).json({ error: `Invalid toolkit type: ${type}` });
  }
  const store = new MemoryStore();
  try {
    const item = store.getItem(id, type as SourceType);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (error) {
    console.error('Toolkit item error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally { store.close(); }
});

// GET /api/toolkit/item/:type/:id/content — raw file contents for editing/preview.
router.get('/item/:type/:id/content', (req, res) => {
  const { type, id } = req.params;
  if (!isToolkitType(type)) {
    return res.status(400).json({ error: `Invalid toolkit type: ${type}` });
  }
  const store = new MemoryStore();
  try {
    const item = store.getItem(id, type as SourceType);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (!item.file_path) return res.json({ content: '' });
    let content = '';
    try {
      // Lazy require to avoid bringing fs into hot paths that don't need it.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readFileSync, existsSync } = require('fs');
      if (existsSync(item.file_path)) content = readFileSync(item.file_path, 'utf-8');
    } catch { /* tolerate */ }
    res.json({ content, filePath: item.file_path });
  } catch (error) {
    console.error('Toolkit content error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally { store.close(); }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/toolkit/promote
//
// Body: { type, sourceId, toTool }
// Copies a toolkit primitive from one AI tool's storage into another.
// Skill: cp -r ~/.claude/skills/<name>/ → ~/.config/opencode/skill/<name>/
// MCP:   read source config, merge entry into target tool's config file
// Note:  cp CLAUDE.md → GEMINI.md or AGENTS.md in same project dir
// ─────────────────────────────────────────────────────────────────

const TARGET_TOOLS = ['claude', 'gemini', 'opencode', 'codex'] as const;
type TargetTool = (typeof TARGET_TOOLS)[number];

router.post('/promote', express.json(), (req, res) => {
  const { type, sourceId, toTool } = req.body || {};
  if (!isToolkitType(type)) return res.status(400).json({ error: `Invalid type: ${type}` });
  if (typeof sourceId !== 'string' || !sourceId) return res.status(400).json({ error: 'sourceId required' });
  if (!(TARGET_TOOLS as readonly string[]).includes(toTool)) {
    return res.status(400).json({ error: `Invalid toTool: ${toTool}. Allowed: ${TARGET_TOOLS.join(', ')}` });
  }

  const store = new MemoryStore();
  try {
    const item = store.getItem(sourceId, type as SourceType);
    if (!item) return res.status(404).json({ error: 'Source item not found' });

    let extra: Record<string, unknown> = {};
    try { extra = JSON.parse(item.extra_json || '{}'); } catch {}
    const fromTool = (extra.tool as string) || 'claude';
    if (fromTool === toTool) {
      return res.status(400).json({ error: 'Source and target tool are the same' });
    }

    if (type === 'skill') return promoteSkill(item, extra, toTool as TargetTool, res);
    if (type === 'mcp')   return promoteMcp(item, extra, fromTool, toTool as TargetTool, res);
    if (type === 'claude_md' as any) {
      // claude_md isn't in the toolkit set, but kept here for symmetry — UI
      // can call this with type='claude_md' if we ever add notes-promotion.
      return res.status(400).json({ error: 'Notes promotion not implemented yet' });
    }
    return res.status(400).json({ error: `Promotion not supported for type: ${type}` });
  } catch (error) {
    console.error('Promote error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally { store.close(); }
});

function promoteSkill(item: any, extra: Record<string, unknown>, toTool: TargetTool, res: express.Response) {
  if (toTool === 'gemini') {
    return res.status(400).json({ error: 'Gemini does not have a Skills surface (use Extensions instead).' });
  }
  const skillDir = (extra.skillDir as string) || dirname(item.file_path);
  if (!existsSync(skillDir)) return res.status(404).json({ error: `Source dir missing: ${skillDir}` });

  const skillName = (extra.skillName as string) || basename(skillDir);
  const targetRoot =
      toTool === 'claude'   ? join(homedir(), '.claude', 'skills')
    : toTool === 'opencode' ? join(homedir(), '.config', 'opencode', 'skill')
    :                         join(homedir(), '.codex', 'skills', '.system');
  const targetDir = join(targetRoot, skillName);

  if (existsSync(targetDir)) {
    return res.status(409).json({ error: `Already exists: ${targetDir}. Remove or rename first.` });
  }

  mkdirSync(targetRoot, { recursive: true });
  cpSync(skillDir, targetDir, { recursive: true });
  return res.json({ ok: true, targetPath: targetDir });
}

function promoteMcp(
  item: any,
  extra: Record<string, unknown>,
  fromTool: string,
  toTool: TargetTool,
  res: express.Response,
) {
  const name = (extra.mcpName as string) || item.title;
  const command = (extra.command as string) || '';
  const allow = Array.isArray(extra.alwaysAllow) ? (extra.alwaysAllow as string[]) : [];

  // Re-parse the source config to get the original entry (round-trips
  // command/args/env shape per-tool).
  const sourceCfg = readMcpEntry(fromTool, name);
  if (!sourceCfg) {
    // Fall back to a synthesized entry from extra. Loses env vars but
    // is better than failing for promote-from-rendered-row.
    const parts = command.split(' ').filter(Boolean);
    const synth = parts.length > 0
      ? { command: parts[0], args: parts.slice(1), ...(allow.length ? { alwaysAllow: allow } : {}) }
      : null;
    if (!synth) return res.status(404).json({ error: `Could not read source MCP config for ${name}` });
    return writeMcpEntry(toTool, name, synth, res);
  }
  return writeMcpEntry(toTool, name, sourceCfg, res);
}

function readMcpEntry(tool: string, name: string): any | null {
  const home = homedir();
  const tries: { path: string; key: string }[] = [];
  if (tool === 'claude') {
    tries.push({ path: join(home, '.mcp.json'),    key: 'mcpServers' });
    tries.push({ path: join(home, '.claude.json'), key: 'mcpServers' });
  } else if (tool === 'gemini') {
    tries.push({ path: join(home, '.gemini', 'settings.json'), key: 'mcpServers' });
  } else if (tool === 'opencode') {
    tries.push({ path: join(home, '.config', 'opencode', 'config.json'), key: 'mcp' });
    tries.push({ path: join(home, '.opencode', 'config.json'),           key: 'mcp' });
  } else if (tool === 'codex') {
    const entry = readCodexMcpEntry(join(home, '.codex', 'config.toml'), name);
    if (entry) return entry;
  }
  for (const t of tries) {
    if (!existsSync(t.path)) continue;
    try {
      const cfg = JSON.parse(readFileSync(t.path, 'utf-8'));
      const block = cfg[t.key] || {};
      if (block[name]) return block[name];
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Pull a single [mcp_servers.<name>] block out of Codex's config.toml.
 * Mirrors the parser in McpsSource.fromCodexToml — kept local so the
 * promote path doesn't depend on the indexer's internals.
 */
function readCodexMcpEntry(path: string, target: string): any | null {
  if (!existsSync(path)) return null;
  let content: string;
  try { content = readFileSync(path, 'utf-8'); } catch { return null; }

  let currentName: string | null = null;
  let inEnv = false;
  const out: { command?: string; args?: any; env?: Record<string, string>; url?: string } = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const envMatch = line.match(/^\[mcp_servers\.([^\.\]]+)\.env\]$/);
    if (envMatch) {
      currentName = envMatch[1];
      inEnv = currentName === target;
      if (inEnv) out.env = out.env || {};
      continue;
    }
    const serverMatch = line.match(/^\[mcp_servers\.([^\.\]]+)\]$/);
    if (serverMatch) {
      currentName = serverMatch[1];
      inEnv = false;
      continue;
    }
    if (currentName !== target) continue;

    const propMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!propMatch) continue;
    const key = propMatch[1];
    let value = propMatch[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (inEnv) {
      out.env = out.env || {};
      out.env[key] = value;
    } else if (key === 'args' && value.startsWith('[')) {
      try { out.args = JSON.parse(value); } catch { out.args = value; }
    } else {
      (out as any)[key] = value;
    }
  }

  return out.command || out.url ? out : null;
}

/**
 * Append (never replace) a Codex [mcp_servers.<name>] block to config.toml.
 * Returns false when the entry already exists.
 */
function writeCodexMcpEntry(path: string, name: string, entry: any): boolean {
  let content = '';
  if (existsSync(path)) content = readFileSync(path, 'utf-8');

  const header = `[mcp_servers.${name}]`;
  if (content.includes(header)) return false;

  const escape = (s: string) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  let cmd = '';
  let args: string[] = [];
  if (Array.isArray(entry.command)) {
    cmd = entry.command[0] || '';
    args = (entry.command as any[]).slice(1).map(String);
  } else {
    cmd = String(entry.command || '');
    args = Array.isArray(entry.args) ? (entry.args as any[]).map(String) : [];
  }

  const lines: string[] = [];
  if (content.length > 0 && !content.endsWith('\n')) lines.push('');
  lines.push('', header);
  if (cmd) lines.push(`command = ${escape(cmd)}`);
  if (args.length > 0) lines.push(`args = [${args.map(escape).join(', ')}]`);
  if (entry.url) lines.push(`url = ${escape(entry.url)}`);
  if (entry.env && typeof entry.env === 'object' && Object.keys(entry.env).length > 0) {
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [k, v] of Object.entries(entry.env)) {
      lines.push(`${k} = ${escape(String(v))}`);
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content + lines.join('\n') + '\n');
  return true;
}

function writeMcpEntry(toTool: TargetTool, name: string, entry: any, res: express.Response) {
  const home = homedir();

  // Codex stores MCPs in TOML, not JSON — handle separately.
  if (toTool === 'codex') {
    const path = join(home, '.codex', 'config.toml');
    const ok = writeCodexMcpEntry(path, name, entry);
    if (!ok) return res.status(409).json({ error: `MCP "${name}" already exists in ${path}.` });
    return res.json({ ok: true, targetPath: path, name });
  }

  let path: string; let key: string;
  if (toTool === 'claude') {
    path = join(home, '.mcp.json'); key = 'mcpServers';
  } else if (toTool === 'gemini') {
    path = join(home, '.gemini', 'settings.json'); key = 'mcpServers';
  } else {
    path = join(home, '.config', 'opencode', 'config.json'); key = 'mcp';
  }

  let cfg: any = {};
  if (existsSync(path)) {
    try { cfg = JSON.parse(readFileSync(path, 'utf-8')); }
    catch { return res.status(500).json({ error: `Target config is malformed: ${path}` }); }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }

  cfg[key] = cfg[key] || {};
  if (cfg[key][name]) {
    return res.status(409).json({ error: `MCP "${name}" already exists in ${path}.` });
  }

  // Normalize entry shape per target tool.
  let normalized = entry;
  if (toTool === 'opencode') {
    // OpenCode expects { type: 'local', command: string[] } or { type: 'remote', url }.
    if (entry.url) normalized = { type: 'remote', url: entry.url };
    else if (Array.isArray(entry.command)) normalized = { type: 'local', command: entry.command };
    else if (typeof entry.command === 'string') {
      normalized = { type: 'local', command: [entry.command, ...(entry.args || [])] };
    }
  } else {
    // Claude / Gemini expect { command, args, env? }.
    if (Array.isArray(entry.command)) {
      const [cmd, ...args] = entry.command;
      normalized = { command: cmd, args };
    } else {
      normalized = { command: entry.command, ...(entry.args ? { args: entry.args } : {}) };
    }
    if (entry.env) (normalized as any).env = entry.env;
    if (entry.alwaysAllow) (normalized as any).alwaysAllow = entry.alwaysAllow;
  }

  cfg[key][name] = normalized;
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return res.json({ ok: true, targetPath: path, name, normalized });
}

export default router;
