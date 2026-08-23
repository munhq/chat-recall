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

import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'fs';
import { dirname, join, basename } from 'path';
import { homedir } from 'os';

import { claudeBackend as CLAUDE } from './backends/claude.js';
import { geminiBackend as GEMINI } from './backends/gemini.js';
import { opencodeBackend as OPENCODE } from './backends/opencode.js';
import { cursorHomeDir } from './tool-paths.js';
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
  skill:   ['claude', 'agy', 'gemini', 'opencode', 'codex', 'cursor'],
  mcp:     ['claude', 'opencode', 'agy', 'gemini', 'codex', 'cursor'],
  command: ['claude', 'agy', 'gemini', 'opencode', 'codex', 'cursor'],
  agent:   ['claude', 'agy', 'gemini', 'opencode', 'codex', 'cursor'],
  instructions: ['claude', 'agy', 'gemini', 'opencode', 'codex', 'cursor'],
};

export const SOURCE_PRECEDENCE: Record<SyncType, TargetTool[]> = {
  skill:   ['claude', 'codex', 'opencode', 'agy', 'gemini', 'cursor'],
  mcp:     ['claude', 'codex', 'agy', 'gemini', 'opencode', 'cursor'],
  command: ['claude', 'opencode', 'codex', 'agy', 'gemini', 'cursor'],
  agent:   ['claude', 'opencode', 'agy', 'gemini', 'codex', 'cursor'],
  instructions: ['claude', 'codex', 'opencode', 'agy', 'gemini', 'cursor'],
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
    case 'gemini':   return GEMINI.skillsDir();
    case 'opencode': return OPENCODE.skillsDir();
    case 'codex':    return CODEX.skillsDir();  // user skills, NOT .system
    case 'cursor':   return join(cursorHomeDir(), 'skills');
  }
}

function copySkill(row: ArtifactRow, toTool: TargetTool): CopyResult {
  const skillDir = (row.extra.skillDir as string) || dirname(row.filePath);
  if (!existsSync(skillDir)) return { ok: false, status: 404, error: `Source dir missing: ${skillDir}` };
  const name = (row.extra.skillName as string) || basename(skillDir);
  const targetDir = join(skillsDirFor(toTool), name);
  if (existsSync(targetDir)) return { ok: false, status: 409, error: `Already exists: ${targetDir}` };
  try {
    mkdirSync(dirname(targetDir), { recursive: true });
    cpSync(skillDir, targetDir, { recursive: true });
    return { ok: true, targetPath: targetDir };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : 'cp failed' };
  }
}

// ── MCP servers (JSON ↔ TOML config merge) ─────────────────────────

export function readMcpEntry(tool: string, name: string): any | null {
  const home = homedir();
  const tries: { path: string; key: string }[] = [];
  if (tool === 'claude') {
    tries.push({ path: join(home, '.mcp.json'), key: 'mcpServers' });
    tries.push({ path: join(home, '.claude.json'), key: 'mcpServers' });
  } else if (tool === 'gemini') {
    tries.push({ path: join(home, '.gemini', 'settings.json'), key: 'mcpServers' });
  } else if (tool === 'agy') {
    tries.push({ path: join(home, '.gemini', 'config', 'mcp_config.json'), key: 'mcpServers' });
  } else if (tool === 'cursor') {
    tries.push({ path: join(cursorHomeDir(), 'mcp.json'), key: 'mcpServers' });
  } else if (tool === 'opencode') {
    tries.push({ path: join(home, '.config', 'opencode', 'opencode.json'), key: 'mcp' });
    tries.push({ path: join(home, '.config', 'opencode', 'config.json'), key: 'mcp' });
    tries.push({ path: join(home, '.opencode', 'config.json'), key: 'mcp' });
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
  const home = homedir();
  if (toTool === 'codex') {
    const path = join(home, '.codex', 'config.toml');
    if (!writeCodexMcpEntry(path, name, entry)) return { ok: false, status: 409, error: `MCP "${name}" already exists in ${path}.` };
    return { ok: true, targetPath: path };
  }
  let path: string; let key: string;
  if (toTool === 'claude') { path = join(home, '.mcp.json'); key = 'mcpServers'; }
  else if (toTool === 'gemini') { path = join(home, '.gemini', 'settings.json'); key = 'mcpServers'; }
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

// ── Unified copy dispatch ──────────────────────────────────────────

/** Copy one artifact into `toTool`. Never overwrites (409 if present). */
export function copyArtifactToTool(type: SyncType, row: ArtifactRow, toTool: TargetTool): CopyResult {
  if (row.readonly) return { ok: false, status: 400, error: 'Artifact is read-only (system/bundled).' };
  if (row.tool === toTool) return { ok: false, status: 400, error: 'Source and target are the same tool.' };
  if (type === 'skill') return copySkill(row, toTool);
  if (type === 'mcp')   return copyMcp(row, toTool);
  if (type === 'instructions') return copyInstructions(row, toTool);
  return copyCommandOrAgent(type, row, toTool);
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
