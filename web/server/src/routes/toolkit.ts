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
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'fs';
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

const SUPPORTED_TARGETS: Record<'skill' | 'mcp', TargetTool[]> = {
  skill: ['claude', 'opencode', 'codex'],          // gemini has no Skills surface
  mcp:   ['claude', 'opencode', 'gemini', 'codex'],
};

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

interface PromoteResult {
  ok: boolean;
  targetPath?: string;
  error?: string;
  status?: number;
}

function copySkillToTool(
  extra: Record<string, unknown>,
  itemFilePath: string,
  toTool: TargetTool,
): PromoteResult {
  if (toTool === 'gemini') {
    return { ok: false, status: 400, error: 'Gemini does not have a Skills surface (use Extensions instead).' };
  }
  const skillDir = (extra.skillDir as string) || dirname(itemFilePath);
  if (!existsSync(skillDir)) return { ok: false, status: 404, error: `Source dir missing: ${skillDir}` };

  const skillName = (extra.skillName as string) || basename(skillDir);
  const targetRoot =
      toTool === 'claude'   ? join(homedir(), '.claude', 'skills')
    : toTool === 'opencode' ? join(homedir(), '.config', 'opencode', 'skill')
    :                         join(homedir(), '.codex', 'skills', '.system');
  const targetDir = join(targetRoot, skillName);

  if (existsSync(targetDir)) {
    return { ok: false, status: 409, error: `Already exists: ${targetDir}. Remove or rename first.` };
  }

  try {
    mkdirSync(targetRoot, { recursive: true });
    cpSync(skillDir, targetDir, { recursive: true });
    return { ok: true, targetPath: targetDir };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : 'cp failed' };
  }
}

function promoteSkill(item: any, extra: Record<string, unknown>, toTool: TargetTool, res: express.Response) {
  const r = copySkillToTool(extra, item.file_path, toTool);
  if (!r.ok) return res.status(r.status || 500).json({ error: r.error });
  return res.json({ ok: true, targetPath: r.targetPath });
}

function copyMcpToTool(
  itemTitle: string,
  extra: Record<string, unknown>,
  fromTool: string,
  toTool: TargetTool,
): PromoteResult {
  const name = (extra.mcpName as string) || itemTitle;
  const command = (extra.command as string) || '';
  const allow = Array.isArray(extra.alwaysAllow) ? (extra.alwaysAllow as string[]) : [];

  const sourceCfg = readMcpEntry(fromTool, name);
  let entry = sourceCfg;
  if (!entry) {
    const parts = command.split(' ').filter(Boolean);
    entry = parts.length > 0
      ? { command: parts[0], args: parts.slice(1), ...(allow.length ? { alwaysAllow: allow } : {}) }
      : null;
  }
  if (!entry) return { ok: false, status: 404, error: `Could not read source MCP config for ${name}` };

  return writeMcpEntryPure(toTool, name, entry);
}

function promoteMcp(
  item: any,
  extra: Record<string, unknown>,
  fromTool: string,
  toTool: TargetTool,
  res: express.Response,
) {
  const r = copyMcpToTool(item.title, extra, fromTool, toTool);
  if (!r.ok) return res.status(r.status || 500).json({ error: r.error });
  return res.json({ ok: true, targetPath: r.targetPath });
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

function writeMcpEntryPure(toTool: TargetTool, name: string, entry: any): PromoteResult {
  const home = homedir();

  // Codex stores MCPs in TOML, not JSON — handle separately.
  if (toTool === 'codex') {
    const path = join(home, '.codex', 'config.toml');
    const ok = writeCodexMcpEntry(path, name, entry);
    if (!ok) return { ok: false, status: 409, error: `MCP "${name}" already exists in ${path}.` };
    return { ok: true, targetPath: path };
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
    catch { return { ok: false, status: 500, error: `Target config is malformed: ${path}` }; }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }

  cfg[key] = cfg[key] || {};
  if (cfg[key][name]) {
    return { ok: false, status: 409, error: `MCP "${name}" already exists in ${path}.` };
  }

  // Normalize entry shape per target tool.
  let normalized = entry;
  if (toTool === 'opencode') {
    if (entry.url) normalized = { type: 'remote', url: entry.url };
    else if (Array.isArray(entry.command)) normalized = { type: 'local', command: entry.command };
    else if (typeof entry.command === 'string') {
      normalized = { type: 'local', command: [entry.command, ...(entry.args || [])] };
    }
  } else {
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
  try {
    writeFileSync(path, JSON.stringify(cfg, null, 2));
    return { ok: true, targetPath: path };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : 'write failed' };
  }
}

function writeMcpEntry(toTool: TargetTool, name: string, entry: any, res: express.Response) {
  const r = writeMcpEntryPure(toTool, name, entry);
  if (!r.ok) return res.status(r.status || 500).json({ error: r.error });
  return res.json({ ok: true, targetPath: r.targetPath, name });
}

// ─────────────────────────────────────────────────────────────────
// DELETE /api/toolkit/item
//
// Body: { type: 'skill'|'mcp', name, tool }
// Removes one entry from one tool. For Skills, deletes the on-disk dir.
// For MCPs in JSON-backed tools (claude/gemini/opencode), deletes the
// keyed entry. For Codex MCPs (TOML), rewrites the file without the
// [mcp_servers.<name>] block.
// ─────────────────────────────────────────────────────────────────

router.delete('/item', express.json(), (req, res) => {
  const { type, name, tool } = req.body || {};
  if (type !== 'skill' && type !== 'mcp') return res.status(400).json({ error: 'type must be "skill" or "mcp"' });
  if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'name required' });
  if (!(TARGET_TOOLS as readonly string[]).includes(tool)) {
    return res.status(400).json({ error: `invalid tool: ${tool}` });
  }

  try {
    if (type === 'skill') {
      const r = removeSkillFromTool(name, tool as TargetTool);
      if (!r.ok) return res.status(r.status || 500).json({ error: r.error });
      return res.json({ ok: true, removedPath: r.targetPath });
    }
    const r = removeMcpFromTool(name, tool as TargetTool);
    if (!r.ok) return res.status(r.status || 500).json({ error: r.error });
    return res.json({ ok: true, removedPath: r.targetPath });
  } catch (error) {
    console.error('Remove error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  }
});

function removeSkillFromTool(name: string, tool: TargetTool): PromoteResult {
  if (tool === 'gemini') return { ok: false, status: 400, error: 'Gemini has no Skills surface.' };
  const root =
      tool === 'claude'   ? join(homedir(), '.claude', 'skills')
    : tool === 'opencode' ? join(homedir(), '.config', 'opencode', 'skill')
    :                       join(homedir(), '.codex', 'skills', '.system');
  const dir = join(root, name);
  if (!existsSync(dir)) return { ok: false, status: 404, error: `Not found: ${dir}` };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, targetPath: dir };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : 'rm failed' };
  }
}

function removeMcpFromTool(name: string, tool: TargetTool): PromoteResult {
  const home = homedir();

  if (tool === 'codex') {
    const path = join(home, '.codex', 'config.toml');
    if (!existsSync(path)) return { ok: false, status: 404, error: 'config.toml not found' };
    const before = readFileSync(path, 'utf-8');
    const after = stripCodexMcpBlock(before, name);
    if (before === after) return { ok: false, status: 404, error: `MCP "${name}" not found in ${path}` };
    try {
      writeFileSync(path, after);
      return { ok: true, targetPath: path };
    } catch (e) {
      return { ok: false, status: 500, error: e instanceof Error ? e.message : 'write failed' };
    }
  }

  let path: string; let key: string;
  if (tool === 'claude') {
    // ~/.mcp.json is the conventional global file. ~/.claude.json carries
    // user-level entries; we only delete from the file that actually has it.
    const cands = [
      { path: join(home, '.mcp.json'),    key: 'mcpServers' },
      { path: join(home, '.claude.json'), key: 'mcpServers' },
    ];
    for (const c of cands) {
      if (!existsSync(c.path)) continue;
      try {
        const cfg = JSON.parse(readFileSync(c.path, 'utf-8'));
        if (cfg[c.key] && cfg[c.key][name]) {
          delete cfg[c.key][name];
          writeFileSync(c.path, JSON.stringify(cfg, null, 2));
          return { ok: true, targetPath: c.path };
        }
      } catch { /* try next */ }
    }
    return { ok: false, status: 404, error: `MCP "${name}" not found in claude configs` };
  } else if (tool === 'gemini') {
    path = join(home, '.gemini', 'settings.json'); key = 'mcpServers';
  } else {
    // opencode — try both possible locations
    const cands = [
      { path: join(home, '.config', 'opencode', 'config.json'), key: 'mcp' },
      { path: join(home, '.opencode', 'config.json'),           key: 'mcp' },
    ];
    for (const c of cands) {
      if (!existsSync(c.path)) continue;
      try {
        const cfg = JSON.parse(readFileSync(c.path, 'utf-8'));
        if (cfg[c.key] && cfg[c.key][name]) {
          delete cfg[c.key][name];
          writeFileSync(c.path, JSON.stringify(cfg, null, 2));
          return { ok: true, targetPath: c.path };
        }
      } catch { /* try next */ }
    }
    return { ok: false, status: 404, error: `MCP "${name}" not found in opencode configs` };
  }

  if (!existsSync(path)) return { ok: false, status: 404, error: `${path} not found` };
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf-8'));
    if (!cfg[key] || !cfg[key][name]) return { ok: false, status: 404, error: `MCP "${name}" not found in ${path}` };
    delete cfg[key][name];
    writeFileSync(path, JSON.stringify(cfg, null, 2));
    return { ok: true, targetPath: path };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : 'failed' };
  }
}

/**
 * Strip a `[mcp_servers.<name>]` section (and its `.env` sub-section)
 * from a Codex config.toml without disturbing other entries.
 */
function stripCodexMcpBlock(content: string, name: string): string {
  const out: string[] = [];
  let inTarget = false;
  for (const line of content.split('\n')) {
    const m = line.match(/^\[mcp_servers\.([^\.\]]+)(?:\.([^\]]+))?\]$/);
    if (m) {
      inTarget = m[1] === name;
      if (inTarget) continue;
    }
    if (!inTarget) out.push(line);
  }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────
// GET /api/toolkit/matrix
//
// Returns { skill, mcp } × name × tool presence map for the cross-tool
// matrix UI. Avoids the client having to scan every row.
// ─────────────────────────────────────────────────────────────────

router.get('/matrix', (_req, res) => {
  const store = new MemoryStore();
  try {
    const out: Record<'skill' | 'mcp', Record<string, Record<string, boolean>>> = { skill: {}, mcp: {} };
    for (const type of ['skill', 'mcp'] as const) {
      const rows = store.listItems(type as SourceType, 100_000, 0);
      for (const row of rows) {
        let extra: any = {};
        try { extra = JSON.parse(row.extra_json || '{}'); } catch { /* skip */ }
        const tool = String(extra.tool || 'claude');
        const name = type === 'skill'
          ? String(extra.skillName || row.title)
          : String(extra.mcpName || row.title);
        if (!name) continue;
        out[type][name] = out[type][name] || {};
        out[type][name][tool] = true;
      }
    }
    res.json({
      skill: out.skill,
      mcp: out.mcp,
      supportedTargets: SUPPORTED_TARGETS,
    });
  } catch (error) {
    console.error('Matrix error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally {
    store.close();
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/toolkit/sync-all
//
// Body: { types?: ['skill'|'mcp'][], dryRun?: boolean }
//
// For each (type, name) pair the indexer knows about, decide which tools
// should have it (every tool that supports the type) and copy the source
// content into every tool that's missing it. Idempotent: existing entries
// are reported as "skipped: already_exists", never overwritten. Conflicts
// where two source tools have the same name are resolved by precedence:
//   skill: claude > codex > opencode  (gemini has no skills surface)
//   mcp:   claude > codex > gemini > opencode
//
// dryRun returns the plan without writing anything.
// ─────────────────────────────────────────────────────────────────

const SOURCE_PRECEDENCE: Record<'skill' | 'mcp', TargetTool[]> = {
  skill: ['claude', 'codex', 'opencode'],
  mcp:   ['claude', 'codex', 'gemini', 'opencode'],
};

interface SyncPlanEntry {
  type: 'skill' | 'mcp';
  name: string;
  source: TargetTool;       // tool we'll copy from
  presentIn: TargetTool[];  // tools that already have this row
  copyTo: TargetTool[];     // tools we'll write to (when not dryRun)
}

interface SyncResultEntry extends SyncPlanEntry {
  copied: { tool: TargetTool; targetPath?: string }[];
  skipped: { tool: TargetTool; reason: string }[];
  errors: { tool: TargetTool; error: string }[];
}

function readField(item: any, key: string): unknown {
  try { return JSON.parse(item.extra_json || '{}')[key]; }
  catch { return undefined; }
}

router.post('/sync-all', express.json(), (req, res) => {
  const types: Array<'skill' | 'mcp'> = Array.isArray(req.body?.types) && req.body.types.length > 0
    ? req.body.types.filter((t: string) => t === 'skill' || t === 'mcp')
    : ['skill', 'mcp'];
  const dryRun = !!req.body?.dryRun;

  const store = new MemoryStore();
  try {
    const plan: SyncPlanEntry[] = [];

    for (const type of types) {
      // Index every (name, tool) → row for this type.
      const rows = store.listItems(type as SourceType, 100_000, 0);
      const byName = new Map<string, Partial<Record<TargetTool, any>>>();
      for (const row of rows) {
        const tool = String(readField(row, 'tool') || 'claude') as TargetTool;
        const name = type === 'skill'
          ? String(readField(row, 'skillName') || row.title)
          : String(readField(row, 'mcpName') || row.title);
        if (!name) continue;
        const slot = byName.get(name) || {};
        slot[tool] = row;
        byName.set(name, slot);
      }

      for (const [name, slot] of byName.entries()) {
        const presentIn = (Object.keys(slot) as TargetTool[]).filter(t => SUPPORTED_TARGETS[type].includes(t));
        if (presentIn.length === 0) continue;
        // Pick best source by precedence.
        const source = SOURCE_PRECEDENCE[type].find(t => presentIn.includes(t));
        if (!source) continue;
        const copyTo = SUPPORTED_TARGETS[type].filter(t => !presentIn.includes(t));
        if (copyTo.length === 0) continue;
        plan.push({ type, name, source, presentIn, copyTo });
      }
    }

    if (dryRun) {
      return res.json({ dryRun: true, plan, totalToCopy: plan.reduce((n, p) => n + p.copyTo.length, 0) });
    }

    const results: SyncResultEntry[] = [];
    for (const entry of plan) {
      const sourceRow = store.listItems(entry.type as SourceType, 100_000, 0)
        .find(r => {
          const tool = String(readField(r, 'tool') || 'claude');
          const name = entry.type === 'skill'
            ? String(readField(r, 'skillName') || r.title)
            : String(readField(r, 'mcpName') || r.title);
          return tool === entry.source && name === entry.name;
        });
      if (!sourceRow) {
        results.push({ ...entry, copied: [], skipped: [],
          errors: entry.copyTo.map(t => ({ tool: t, error: 'source row vanished from store' })) });
        continue;
      }
      const extra = (() => { try { return JSON.parse(sourceRow.extra_json || '{}'); } catch { return {}; } })();

      const copied: SyncResultEntry['copied'] = [];
      const skipped: SyncResultEntry['skipped'] = [];
      const errors: SyncResultEntry['errors'] = [];

      for (const target of entry.copyTo) {
        const r = entry.type === 'skill'
          ? copySkillToTool(extra, sourceRow.file_path, target)
          : copyMcpToTool(sourceRow.title, extra, entry.source, target);
        if (r.ok) {
          copied.push({ tool: target, targetPath: r.targetPath });
        } else if (r.status === 409) {
          skipped.push({ tool: target, reason: r.error || 'already exists' });
        } else {
          errors.push({ tool: target, error: r.error || 'failed' });
        }
      }
      results.push({ ...entry, copied, skipped, errors });
    }

    const summary = {
      itemsConsidered: plan.length,
      itemsCopied: results.reduce((n, r) => n + r.copied.length, 0),
      itemsSkipped: results.reduce((n, r) => n + r.skipped.length, 0),
      itemsFailed: results.reduce((n, r) => n + r.errors.length, 0),
    };
    return res.json({ dryRun: false, summary, results });
  } catch (error) {
    console.error('Sync-all error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally {
    store.close();
  }
});

export default router;
