/**
 * Local cross-tool sync executor.
 *
 * The actual filesystem work behind "copy a skill/command/agent/MCP from tool
 * X to tool Y". It runs wherever there's access to the user's tool dirs — the
 * CLI agent (the real Model-B executor, draining server-queued intents) and,
 * as a fast path, a local server route.
 *
 * Two input modes feed the same copy core:
 *   - the CLI agent discovers artifacts from disk via the source parsers
 *     (`discoverLocalArtifacts`)
 *   - the server route already has them as indexed store rows
 * Both normalize to `ArtifactRow`, then `copyArtifactToTool` / `planSync` /
 * `executeSyncAll` do the rest. Never overwrites an existing target.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync, rmSync } from 'fs';
import { dirname, join, basename } from 'path';
import { homedir } from 'os';
import { getDataDir } from './paths.js';

import { claudeBackend as CLAUDE } from './backends/claude.js';
import { opencodeBackend as OPENCODE } from './backends/opencode.js';
import { cursorHomeDir } from './tool-paths.js';
import { hermesBackend as HERMES } from './backends/hermes.js';
import {
  addHermesMcpServer, deleteHermesMcpServer, hermesConfigPath, hermesServerEntry, readHermesMcpServers,
} from './hermes-config.js';
import { codexBackend as CODEX } from './backends/codex.js';
import { agyBackend as AGY } from './backends/agy.js';
import {
  emit as emitArtifact, readCommand, readAgent, readInstructions,
  type ToolId, type CodecType, type Encoding,
} from './artifact-codec.js';
import { SkillsSource } from '../parsers/skills-source.js';
import { McpsSource } from '../parsers/mcps-source.js';
import { SlashCommandsSource } from '../parsers/slash-commands-source.js';
import { SubagentsSource } from '../parsers/subagents-source.js';
import { ClaudeMdSource } from '../parsers/claude-md-source.js';
import type { MemoryItem } from '../types/memory.js';

export type SyncType = 'skill' | 'mcp' | 'command' | 'agent' | 'instructions';
export type TargetTool = ToolId;

/** Tool-neutral source row both the parsers and the store can produce. */
export interface ArtifactRow {
  id: string;
  title: string;
  filePath: string;
  projectPath?: string;
  tool: string;
  name: string;
  extra: Record<string, unknown>;
  readonly: boolean;
  shared: boolean;
}

export interface CopyResult {
  ok: boolean;
  targetPath?: string;
  error?: string;
  /** 409 = already exists (skipped), 404 = source missing, 500 = write failed. */
  status?: number;
  /** Removals only: the trash copies made before the change, one per file changed. */
  backupPaths?: string[];
}

export const ALL_SYNC_TYPES: SyncType[] = ['skill', 'mcp', 'command', 'agent', 'instructions'];

/** extra_json field holding an artifact's display name, per type. */
export const NAME_FIELD: Record<SyncType, string> = {
  skill: 'skillName', mcp: 'mcpName', command: 'commandName', agent: 'agentName', instructions: 'filename',
};

/**
 * Which tools can receive each artifact type.
 *
 * EXPORTED because the server route and the web UI each used to keep their own
 * copy of this table, and the three drifted. They now import this one.
 */
export const SUPPORTED_TARGETS: Record<SyncType, TargetTool[]> = {
  skill:   ['claude', 'agy', 'opencode', 'codex', 'cursor', 'hermes'],
  mcp:     ['claude', 'opencode', 'agy', 'codex', 'cursor', 'hermes'],
  command: ['claude', 'agy', 'opencode', 'codex', 'cursor'],
  agent:   ['claude', 'agy', 'opencode', 'codex', 'cursor'],
  instructions: ['claude', 'agy', 'opencode', 'codex', 'cursor'],
};

export const SOURCE_PRECEDENCE: Record<SyncType, TargetTool[]> = {
  skill:   ['claude', 'codex', 'opencode', 'agy', 'cursor', 'hermes'],
  mcp:     ['claude', 'codex', 'agy', 'opencode', 'cursor', 'hermes'],
  command: ['claude', 'opencode', 'codex', 'agy', 'cursor'],
  agent:   ['claude', 'opencode', 'agy', 'codex', 'cursor'],
  instructions: ['claude', 'codex', 'opencode', 'agy', 'cursor'],
};

export function supportedTargetsFor(type: SyncType): TargetTool[] { return SUPPORTED_TARGETS[type]; }

// ── Row adapters ───────────────────────────────────────────────────

/** Normalize a parser MemoryItem into an ArtifactRow. */
export function rowFromMemoryItem(type: SyncType, item: MemoryItem): ArtifactRow {
  const extra = (item.extra || {}) as Record<string, unknown>;
  return {
    id: item.id,
    title: item.title,
    filePath: item.filePath || '',
    projectPath: item.projectPath,
    tool: String(extra.tool || 'claude'),
    name: String(extra[NAME_FIELD[type]] || item.title),
    extra,
    readonly: extra.readonly === true,
    shared: extra.shared === true,
  };
}

/** Normalize an indexed store row (memory_metadata) into an ArtifactRow. */
export function rowFromStore(
  type: SyncType,
  row: {
    id: string;
    title: string;
    file_path?: string | null;
    filePath?: string;
    project_path?: string | null;
    projectPath?: string;
    extra_json?: string | null;
  }
): ArtifactRow {
  let extra: Record<string, unknown> = {};
  try { extra = JSON.parse(row.extra_json || '{}'); } catch { /* tolerate */ }
  return {
    id: row.id,
    title: row.title,
    filePath: row.file_path || row.filePath || '',
    projectPath: row.project_path || row.projectPath || '',
    tool: String(extra.tool || 'claude'),
    name: String(extra[NAME_FIELD[type]] || row.title),
    extra,
    readonly: extra.readonly === true,
    shared: extra.shared === true,
  };
}

// ── Skills ─────────────────────────────────────────────────────────

export function skillsDirFor(tool: TargetTool): string {
  switch (tool) {
    case 'claude':   return CLAUDE.skillsDir();
    case 'agy':      return join(AGY.homeDir(), 'skills');
    case 'opencode': return OPENCODE.skillsDir();
    case 'codex':    return CODEX.skillsDir();  // user skills, NOT .system
    case 'cursor':   return join(cursorHomeDir(), 'skills');
    case 'hermes':   return join(HERMES.homeDir(), 'skills');
  }
}

/**
 * Every folder of a skill named `name` under the tool's skills root. Hermes
 * groups its skills in category folders (`skills/<category>/<name>/SKILL.md`),
 * so it is searched one level down as well.
 */
function skillDirsNamed(tool: TargetTool, name: string): string[] {
  const root = skillsDirFor(tool);
  const found: string[] = [];
  if (existsSync(join(root, name))) found.push(join(root, name));
  if (tool !== 'hermes' || !existsSync(root)) return found;
  for (const category of readdirSync(root)) {
    const candidate = join(root, category, name);
    if (existsSync(join(candidate, 'SKILL.md'))) found.push(candidate);
  }
  return found;
}

function copySkill(row: ArtifactRow, toTool: TargetTool): CopyResult {
  const skillDir = (row.extra.skillDir as string) || dirname(row.filePath);
  if (!existsSync(skillDir)) return { ok: false, status: 404, error: `Source dir missing: ${skillDir}` };
  const name = (row.extra.skillName as string) || basename(skillDir);
  const targetDir = join(skillsDirFor(toTool), name);
  const existing = skillDirsNamed(toTool, name);
  if (existing.length) return { ok: false, status: 409, error: `Already exists: ${existing[0]}` };
  try {
    mkdirSync(dirname(targetDir), { recursive: true });
    cpSync(skillDir, targetDir, { recursive: true });
    return { ok: true, targetPath: targetDir };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : 'cp failed' };
  }
}

// ── MCP servers (JSON ↔ TOML config merge) ─────────────────────────

/**
 * The JSON config files a tool reads its MCP servers from, in lookup order.
 * Codex keeps its servers in TOML and is not listed here.
 */
function mcpJsonCandidates(tool: string): { path: string; key: string }[] {
  const home = homedir();
  switch (tool) {
    case 'claude':
      return [
        { path: join(home, '.mcp.json'), key: 'mcpServers' },
        { path: join(home, '.claude.json'), key: 'mcpServers' },
      ];
    case 'gemini':
      return [{ path: join(home, '.gemini', 'settings.json'), key: 'mcpServers' }];
    case 'agy':
      return [{ path: join(home, '.gemini', 'config', 'mcp_config.json'), key: 'mcpServers' }];
    case 'cursor':
      return [{ path: join(cursorHomeDir(), 'mcp.json'), key: 'mcpServers' }];
    case 'opencode':
      return [
        { path: join(home, '.config', 'opencode', 'opencode.json'), key: 'mcp' },
        { path: join(home, '.config', 'opencode', 'config.json'), key: 'mcp' },
        { path: join(home, '.opencode', 'config.json'), key: 'mcp' },
      ];
    default:
      return [];
  }
}

export function readMcpEntry(tool: string, name: string): any | null {
  if (tool === 'codex') return readCodexMcpEntry(join(homedir(), '.codex', 'config.toml'), name);
  if (tool === 'hermes') return readHermesMcpServers()?.[name] ?? null;
  for (const t of mcpJsonCandidates(tool)) {
    if (!existsSync(t.path)) continue;
    try {
      const cfg = JSON.parse(readFileSync(t.path, 'utf-8'));
      const block = cfg[t.key] || {};
      if (block[name]) return block[name];
    } catch { /* try next */ }
  }
  return null;
}

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
    if (envMatch) { currentName = envMatch[1]; inEnv = currentName === target; if (inEnv) out.env = out.env || {}; continue; }
    const serverMatch = line.match(/^\[mcp_servers\.([^\.\]]+)\]$/);
    if (serverMatch) { currentName = serverMatch[1]; inEnv = false; continue; }
    if (currentName !== target) continue;
    const propMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!propMatch) continue;
    const key = propMatch[1];
    let value = propMatch[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (inEnv) { out.env = out.env || {}; out.env[key] = value; }
    else if (key === 'args' && value.startsWith('[')) { try { out.args = JSON.parse(value); } catch { out.args = value; } }
    else (out as any)[key] = value;
  }
  return out.command || out.url ? out : null;
}

function writeCodexMcpEntry(path: string, name: string, entry: any): boolean {
  let content = '';
  if (existsSync(path)) content = readFileSync(path, 'utf-8');
  const header = `[mcp_servers.${name}]`;
  if (content.includes(header)) return false;
  const escape = (s: string) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  let cmd = ''; let args: string[] = [];
  if (Array.isArray(entry.command)) { cmd = entry.command[0] || ''; args = (entry.command as any[]).slice(1).map(String); }
  else { cmd = String(entry.command || ''); args = Array.isArray(entry.args) ? (entry.args as any[]).map(String) : []; }
  const lines: string[] = [];
  if (content.length > 0 && !content.endsWith('\n')) lines.push('');
  lines.push('', header);
  if (cmd) lines.push(`command = ${escape(cmd)}`);
  if (args.length > 0) lines.push(`args = [${args.map(escape).join(', ')}]`);
  if (entry.url) lines.push(`url = ${escape(entry.url)}`);
  if (entry.env && typeof entry.env === 'object' && Object.keys(entry.env).length > 0) {
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [k, v] of Object.entries(entry.env)) lines.push(`${k} = ${escape(String(v))}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content + lines.join('\n') + '\n');
  return true;
}

export function writeMcpEntry(toTool: TargetTool, name: string, entry: any): CopyResult {
  if (toTool === 'hermes') return writeHermesMcp(name, entry);
  const home = homedir();
  if (toTool === 'codex') {
    const path = join(home, '.codex', 'config.toml');
    if (!writeCodexMcpEntry(path, name, entry)) return { ok: false, status: 409, error: `MCP "${name}" already exists in ${path}.` };
    return { ok: true, targetPath: path };
  }
  let path: string; let key: string;
  if (toTool === 'claude') { path = join(home, '.mcp.json'); key = 'mcpServers'; }
  else if (toTool === 'agy') { path = join(home, '.gemini', 'config', 'mcp_config.json'); key = 'mcpServers'; }
  else if (toTool === 'cursor') { path = join(cursorHomeDir(), 'mcp.json'); key = 'mcpServers'; }
  else { path = join(home, '.config', 'opencode', 'opencode.json'); key = 'mcp'; }

  let cfg: any = {};
  if (existsSync(path)) {
    try { cfg = JSON.parse(readFileSync(path, 'utf-8')); }
    catch { return { ok: false, status: 500, error: `Target config is malformed: ${path}` }; }
  } else { mkdirSync(dirname(path), { recursive: true }); }

  cfg[key] = cfg[key] || {};
  if (cfg[key][name]) return { ok: false, status: 409, error: `MCP "${name}" already exists in ${path}.` };

  let normalized = entry;
  if (toTool === 'opencode') {
    // opencode's schema is { type: 'local'|'remote', …, enabled }. Its validator
    // REQUIRES `type` and `enabled`; writing the generic {command,args} shape, or
    // omitting `enabled`, makes opencode refuse to start (the 2026-07 config
    // incident). `command` must be an array (command + args flattened).
    const env = entry.env && typeof entry.env === 'object' ? { environment: entry.env } : {};
    if (entry.url) normalized = { type: 'remote', url: entry.url, enabled: true, ...env };
    else if (Array.isArray(entry.command)) normalized = { type: 'local', command: entry.command, enabled: true, ...env };
    else if (typeof entry.command === 'string') normalized = { type: 'local', command: [entry.command, ...(entry.args || [])], enabled: true, ...env };
  } else {
    if (Array.isArray(entry.command)) { const [cmd, ...args] = entry.command; normalized = { command: cmd, args }; }
    else normalized = { command: entry.command, ...(entry.args ? { args: entry.args } : {}) };
    if (entry.env) (normalized as any).env = entry.env;
    if (entry.alwaysAllow) (normalized as any).alwaysAllow = entry.alwaysAllow;
  }
  cfg[key][name] = normalized;
  try { writeFileSync(path, JSON.stringify(cfg, null, 2)); return { ok: true, targetPath: path }; }
  catch (e) { return { ok: false, status: 500, error: e instanceof Error ? e.message : 'write failed' }; }
}

function copyMcp(row: ArtifactRow, toTool: TargetTool): CopyResult {
  const name = (row.extra.mcpName as string) || row.title;
  const command = (row.extra.command as string) || '';
  const allow = Array.isArray(row.extra.alwaysAllow) ? (row.extra.alwaysAllow as string[]) : [];
  let entry = readMcpEntry(row.tool, name);
  if (!entry) {
    const parts = command.split(' ').filter(Boolean);
    entry = parts.length > 0 ? { command: parts[0], args: parts.slice(1), ...(allow.length ? { alwaysAllow: allow } : {}) } : null;
  }
  if (!entry) return { ok: false, status: 404, error: `Could not read source MCP config for ${name}` };
  return writeMcpEntry(toTool, name, entry);
}

// ── Commands / agents (codec) ──────────────────────────────────────

function copyCommandOrAgent(type: 'command' | 'agent', row: ArtifactRow, toTool: TargetTool): CopyResult {
  if (!row.filePath) return { ok: false, status: 404, error: 'Source has no file on disk' };
  const format: Encoding = row.extra.format === 'toml' ? 'toml' : 'md';
  let art;
  try { art = type === 'command' ? readCommand(row.filePath, format) : readAgent(row.filePath, format); }
  catch (e) { return { ok: false, status: 404, error: `Source unreadable: ${e instanceof Error ? e.message : 'failed'}` }; }
  const out = emitArtifact(type as CodecType, art, toTool);
  if (existsSync(out.path)) return { ok: false, status: 409, error: `Already exists: ${out.path}` };
  try {
    mkdirSync(dirname(out.path), { recursive: true });
    writeFileSync(out.path, out.content);
    return { ok: true, targetPath: out.path };
  } catch (e) { return { ok: false, status: 500, error: e instanceof Error ? e.message : 'write failed' }; }
}

function copyInstructions(row: ArtifactRow, toTool: TargetTool): CopyResult {
  if (!row.filePath) return { ok: false, status: 404, error: 'Source has no file on disk' };
  let art;
  try { art = readInstructions(row.filePath, row.name); }
  catch (e) { return { ok: false, status: 404, error: `Source unreadable: ${e instanceof Error ? e.message : 'failed'}` }; }
  const out = emitArtifact('instructions', art, toTool, row.projectPath || undefined);
  if (existsSync(out.path)) return { ok: false, status: 409, error: `Already exists: ${out.path}` };
  try {
    mkdirSync(dirname(out.path), { recursive: true });
    writeFileSync(out.path, out.content);
    return { ok: true, targetPath: out.path };
  } catch (e) { return { ok: false, status: 500, error: e instanceof Error ? e.message : 'write failed' }; }
}

/** Add one server to Hermes's `mcp_servers:`. The config is backed up to the trash before it changes. */
function writeHermesMcp(name: string, entry: any): CopyResult {
  if (!entry?.command && !entry?.url) return { ok: false, status: 400, error: `MCP "${name}" has no command or url to write.` };
  const path = hermesConfigPath();
  if (!existsSync(path)) return { ok: false, status: 404, error: `${path} not found` };
  try {
    const after = addHermesMcpServer(readFileSync(path, 'utf-8'), name, hermesServerEntry(entry));
    if (after === null) return { ok: false, status: 409, error: `MCP "${name}" already exists in ${path}` };
    const backupPaths = [backupToTrash(path, `mcp-hermes-${name}-config.yaml`)];
    writeFileSync(path, after);
    return { ok: true, targetPath: path, backupPaths };
  } catch (e) { return removeFailed(e, 'write failed'); }
}

// ── Unified copy dispatch ──────────────────────────────────────────

/** Copy one artifact into `toTool`. Never overwrites (409 if present). */
export function copyArtifactToTool(type: SyncType, row: ArtifactRow, toTool: TargetTool): CopyResult {
  if (!SUPPORTED_TARGETS[type].includes(toTool)) return { ok: false, status: 400, error: `A ${type} cannot be copied to ${toTool}.` };
  if (row.readonly) return { ok: false, status: 400, error: 'Artifact is read-only (system/bundled).' };
  if (row.tool === toTool) return { ok: false, status: 400, error: 'Source and target are the same tool.' };
  if (type === 'skill') return copySkill(row, toTool);
  if (type === 'mcp')   return copyMcp(row, toTool);
  if (type === 'instructions') return copyInstructions(row, toTool);
  return copyCommandOrAgent(type, row, toTool);
}

// ── Removal (the local agent's path for a remove intent) ───────────

/**
 * Artifact types a removal can name. Instruction files are not listed: an
 * instruction file belongs to one project, and a name alone does not pick one.
 */
export type RemovableType = 'skill' | 'mcp' | 'command' | 'agent';

/**
 * Remove one named artifact from `tool`.
 *
 * Every removal copies what it is about to change into the chat-recall trash
 * first. When that copy fails, the removal stops and nothing is deleted.
 *
 * A name becomes a path segment for skills, commands and agents, so a name that
 * is not one plain segment is refused before anything is read or deleted.
 */
export async function removeArtifactFromTool(type: string, name: string, tool: TargetTool): Promise<CopyResult> {
  if (type !== 'skill' && type !== 'mcp' && type !== 'command' && type !== 'agent') {
    return { ok: false, status: 400, error: `Cannot remove a ${type} by name` };
  }
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    return { ok: false, status: 400, error: `Invalid artifact name: ${JSON.stringify(name)}` };
  }
  if (type === 'skill') return removeSkill(name, tool);
  if (type === 'mcp') return removeMcp(name, tool);
  return removeCommandOrAgent(type, name, tool);
}

/** The trash holds the state from before each removal, so a removal can be undone by hand. */
function backupToTrash(src: string, label: string): string {
  const dest = join(getDataDir(), 'trash', `${Date.now()}-${label.replace(/[^A-Za-z0-9._-]/g, '_')}`);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  return dest;
}

function removeFailed(e: unknown, fallback: string): CopyResult {
  return { ok: false, status: 500, error: e instanceof Error ? e.message : fallback };
}

function removeSkill(name: string, tool: TargetTool): CopyResult {
  const found = skillDirsNamed(tool, name);
  if (found.length === 0) return { ok: false, status: 404, error: `Not found: ${join(skillsDirFor(tool), name)}` };
  if (found.length > 1) return { ok: false, status: 409, error: `${found.length} skills named "${name}" for ${tool}; none removed` };
  const dir = found[0];
  try {
    const backupPaths = [backupToTrash(dir, `skill-${tool}-${name}`)];
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, targetPath: dir, backupPaths };
  } catch (e) { return removeFailed(e, 'rm failed'); }
}

/** A command or agent is one file. Two rows with the same name for one tool are refused, not guessed between. */
async function removeCommandOrAgent(type: 'command' | 'agent', name: string, tool: TargetTool): Promise<CopyResult> {
  const rows = (await discoverLocalArtifacts())[type].filter(r => r.tool === tool && r.name === name);
  if (rows.length === 0) return { ok: false, status: 404, error: `No ${type} named "${name}" for ${tool}` };
  if (rows.length > 1) return { ok: false, status: 409, error: `${rows.length} ${type}s named "${name}" for ${tool}; none removed` };
  const [row] = rows;
  if (row.readonly) return { ok: false, status: 400, error: 'Artifact is read-only (system/bundled).' };
  if (!row.filePath || !existsSync(row.filePath)) return { ok: false, status: 404, error: 'Source has no file on disk' };
  try {
    const backupPaths = [backupToTrash(row.filePath, `${type}-${tool}-${name}`)];
    rmSync(row.filePath);
    return { ok: true, targetPath: row.filePath, backupPaths };
  } catch (e) { return removeFailed(e, 'rm failed'); }
}

function removeMcp(name: string, tool: TargetTool): CopyResult {
  if (tool === 'hermes') {
    const path = hermesConfigPath();
    if (!existsSync(path)) return { ok: false, status: 404, error: `${path} not found` };
    try {
      const after = deleteHermesMcpServer(readFileSync(path, 'utf-8'), name);
      if (after === null) return { ok: false, status: 404, error: `MCP "${name}" not found in ${path}` };
      const backupPaths = [backupToTrash(path, `mcp-hermes-${name}-config.yaml`)];
      writeFileSync(path, after);
      return { ok: true, targetPath: path, backupPaths };
    } catch (e) { return removeFailed(e, 'write failed'); }
  }
  if (tool === 'codex') {
    const path = join(homedir(), '.codex', 'config.toml');
    if (!existsSync(path)) return { ok: false, status: 404, error: 'config.toml not found' };
    const before = readFileSync(path, 'utf-8');
    const after = stripCodexMcpBlock(before, name);
    if (before === after) return { ok: false, status: 404, error: `MCP "${name}" not found in ${path}` };
    try {
      const backupPaths = [backupToTrash(path, `mcp-codex-${name}`)];
      writeFileSync(path, after);
      return { ok: true, targetPath: path, backupPaths };
    } catch (e) { return removeFailed(e, 'write failed'); }
  }
  // Every JSON file that holds the entry loses it. A name present in two
  // configs would otherwise still show as present in the matrix afterwards.
  let removedFrom: string | undefined;
  const backupPaths: string[] = [];
  for (const c of mcpJsonCandidates(tool)) {
    if (!existsSync(c.path)) continue;
    try {
      const cfg = JSON.parse(readFileSync(c.path, 'utf-8'));
      if (!cfg[c.key]?.[name]) continue;
      backupPaths.push(backupToTrash(c.path, `mcp-${tool}-${name}-${basename(c.path)}`));
      delete cfg[c.key][name];
      writeFileSync(c.path, JSON.stringify(cfg, null, 2));
      if (!removedFrom) removedFrom = c.path;
    } catch (e) { return removeFailed(e, 'failed'); }
  }
  if (!removedFrom) return { ok: false, status: 404, error: `MCP "${name}" not found for ${tool}` };
  return { ok: true, targetPath: removedFrom, backupPaths };
}

/**
 * Strip a `[mcp_servers.<name>]` table and its `.env` sub-table from a Codex
 * config.toml. Every other table header ends the strip, so the tables after the
 * removed server stay in the file.
 */
export function stripCodexMcpBlock(content: string, name: string): string {
  const out: string[] = [];
  let inTarget = false;
  for (const line of content.split('\n')) {
    if (/^\s*\[/.test(line)) {
      const m = line.match(/^\s*\[mcp_servers\.([^.\]]+)(?:\.[^\]]+)?\]\s*$/);
      inTarget = m !== null && m[1] === name;
    }
    if (!inTarget) out.push(line);
  }
  return out.join('\n');
}

// ── Planning ───────────────────────────────────────────────────────

export interface SyncPlanEntry {
  type: SyncType;
  name: string;
  source: TargetTool;
  presentIn: TargetTool[];
  copyTo: TargetTool[];
}

/**
 * Build the fan-out plan from candidate rows. Read-only / shared rows are
 * never a source. Each (type,name) is copied from its best-precedence tool
 * to every supported tool that lacks it.
 */
export function planSync(rowsByType: Partial<Record<SyncType, ArtifactRow[]>>, types: SyncType[] = ALL_SYNC_TYPES): SyncPlanEntry[] {
  const plan: SyncPlanEntry[] = [];
  for (const type of types) {
    const byName = new Map<string, Partial<Record<TargetTool, ArtifactRow>>>();
    for (const row of rowsByType[type] || []) {
      if (row.readonly || row.shared) continue;
      const tool = row.tool as TargetTool;
      if (!SUPPORTED_TARGETS[type].includes(tool)) continue;
      const slot = byName.get(row.name) || {};
      if (!slot[tool]) slot[tool] = row;
      byName.set(row.name, slot);
    }
    for (const [name, slot] of byName) {
      const presentIn = Object.keys(slot) as TargetTool[];
      if (presentIn.length === 0) continue;
      const source = SOURCE_PRECEDENCE[type].find(t => presentIn.includes(t));
      if (!source) continue;
      const copyTo = SUPPORTED_TARGETS[type].filter(t => !presentIn.includes(t));
      if (copyTo.length === 0) continue;
      plan.push({ type, name, source, presentIn, copyTo });
    }
  }
  return plan;
}

// ── Local discovery + execution (the CLI agent path) ───────────────

/** Discover every syncable artifact from disk via the source parsers. */
export async function discoverLocalArtifacts(): Promise<Record<SyncType, ArtifactRow[]>> {
  const out: Record<SyncType, ArtifactRow[]> = { skill: [], mcp: [], command: [], agent: [], instructions: [] };
  const sources: Array<[SyncType, AsyncGenerator<MemoryItem>]> = [
    ['skill', new SkillsSource().discover()],
    ['mcp', new McpsSource().discover()],
    ['command', new SlashCommandsSource().discover()],
    ['agent', new SubagentsSource().discover()],
    ['instructions', new ClaudeMdSource().discover()],
  ];
  for (const [type, gen] of sources) {
    for await (const item of gen) out[type].push(rowFromMemoryItem(type, item));
  }
  return out;
}

export interface ExecuteReport {
  copied: Array<{ type: SyncType; name: string; toTool: TargetTool; path?: string }>;
  skipped: Array<{ type: SyncType; name: string; toTool: TargetTool; reason: string }>;
  failed: Array<{ type: SyncType; name: string; toTool: TargetTool; error: string }>;
}

function emptyReport(): ExecuteReport { return { copied: [], skipped: [], failed: [] }; }

function record(report: ExecuteReport, type: SyncType, name: string, toTool: TargetTool, r: CopyResult): void {
  if (r.ok) report.copied.push({ type, name, toTool, path: r.targetPath });
  else if (r.status === 409) report.skipped.push({ type, name, toTool, reason: r.error || 'already exists' });
  else report.failed.push({ type, name, toTool, error: r.error || 'failed' });
}

/** Fan everything out to every tool that's missing it (the "sync everything"). */
export async function executeSyncAll(types: SyncType[] = ALL_SYNC_TYPES): Promise<ExecuteReport> {
  const rows = await discoverLocalArtifacts();
  const plan = planSync(rows, types);
  const report = emptyReport();
  for (const entry of plan) {
    const source = (rows[entry.type] || []).find(r => r.tool === entry.source && r.name === entry.name && !r.readonly);
    if (!source) { for (const t of entry.copyTo) report.failed.push({ type: entry.type, name: entry.name, toTool: t, error: 'source vanished' }); continue; }
    for (const toTool of entry.copyTo) record(report, entry.type, entry.name, toTool, copyArtifactToTool(entry.type, source, toTool));
  }
  return report;
}

/** Copy a single named artifact from `fromTool` to `toTool`. */
export async function executeCopy(type: SyncType, name: string, fromTool: string, toTool: TargetTool): Promise<CopyResult> {
  const rows = await discoverLocalArtifacts();
  const source = (rows[type] || []).find(r => r.tool === fromTool && r.name === name);
  if (!source) return { ok: false, status: 404, error: `No ${type} named "${name}" found for ${fromTool}` };
  return copyArtifactToTool(type, source, toTool);
}
