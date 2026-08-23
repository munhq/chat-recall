/**
 * Cross-tool artifact codec.
 *
 * The thing that makes "share everything between tools" real rather than a
 * blind file-copy. Commands, agents and instructions are the same *idea*
 * across Claude / Gemini / OpenCode / Codex but live in different encodings
 * (markdown+frontmatter vs TOML) and different filenames (CLAUDE.md vs
 * AGENTS.md vs GEMINI.md). This module normalizes any source into a tool-
 * neutral `NormalizedArtifact`, then emits the exact file a target tool
 * expects.
 *
 *   read<Type>(filePath, format) → NormalizedArtifact
 *   emit(type, art, toTool, projectPath?) → { path, content }
 *
 * Skills and MCP servers are handled in the server route (skills are a
 * recursive dir copy; MCP servers merge into a shared config file) — those
 * don't fit the single-file emit shape, so they stay out of this codec.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { claudeBackend as CLAUDE } from './backends/claude.js';
import { geminiBackend as GEMINI } from './backends/gemini.js';
import { opencodeBackend as OPENCODE } from './backends/opencode.js';
import { cursorHomeDir } from './tool-paths.js';
import { codexBackend as CODEX } from './backends/codex.js';
// agy (Antigravity) inherits Gemini CLI's on-disk layout — same commands,
// agents, skills directories under the Gemini home.
import { agyBackend as AGY } from './backends/agy.js';
import {
  parseFrontmatter,
  stringifyFrontmatter,
  parseScalarToml,
  stringifyScalarToml,
} from './toolkit-format.js';

export type ToolId = 'claude' | 'agy' | 'gemini' | 'opencode' | 'codex' | 'cursor';
export type CodecType = 'command' | 'agent' | 'instructions';
export type Encoding = 'md' | 'toml';

export interface NormalizedArtifact {
  name: string;
  description: string;
  /** Prompt / system-prompt / instruction body (markdown). */
  body: string;
  /** Comma-separated tool allowlist (agents only; best-effort). */
  tools?: string;
}

export interface EmittedFile {
  path: string;
  content: string;
}

/** The on-disk encoding a tool uses for a given artifact type. */
export function encodingFor(type: CodecType, tool: ToolId): Encoding {
  if (type === 'instructions') return 'md';
  if (type === 'command') return tool === 'gemini' ? 'toml' : 'md';
  if (type === 'agent') return tool === 'codex' ? 'toml' : 'md';
  return 'md';
}

// ── Readers ────────────────────────────────────────────────────────

export function readCommand(filePath: string, format: Encoding): NormalizedArtifact {
  const content = readFileSync(filePath, 'utf-8');
  if (format === 'toml') {
    const t = parseScalarToml(content);
    return { name: t.name || base(filePath), description: t.description || '', body: t.prompt || '' };
  }
  const { fm, body } = parseFrontmatter(content);
  return { name: fm.name || base(filePath), description: fm.description || '', body: body.trim() };
}

export function readAgent(filePath: string, format: Encoding): NormalizedArtifact {
  const content = readFileSync(filePath, 'utf-8');
  if (format === 'toml') {
    const t = parseScalarToml(content);
    return {
      name: t.name || base(filePath),
      description: t.description || '',
      body: t.developer_instructions || t.instructions || '',
    };
  }
  const { fm, body } = parseFrontmatter(content);
  return { name: fm.name || base(filePath), description: fm.description || '', tools: fm.tools, body: body.trim() };
}

export function readInstructions(filePath: string, name: string): NormalizedArtifact {
  const content = readFileSync(filePath, 'utf-8');
  return { name, description: '', body: content };
}

// ── Target paths ───────────────────────────────────────────────────

/** Where `name`'s command file lives under `tool` (user scope). */
function commandPath(tool: ToolId, name: string): string {
  switch (tool) {
    case 'claude':   return join(CLAUDE.commandsDir(), `${name}.md`);
    case 'agy':      return join(join(AGY.homeDir(), 'commands'), `${name}.toml`);
    case 'gemini':   return join(GEMINI.commandsDir(), `${name}.toml`);
    case 'opencode': return join(OPENCODE.commandsDir(), `${name}.md`);
    case 'codex':    return join(CODEX.promptsDir(), `${name}.md`);
    case 'cursor':   return join(cursorHomeDir(), 'commands', `${name}.md`);
  }
}

function agentPath(tool: ToolId, name: string): string {
  switch (tool) {
    case 'claude':   return join(CLAUDE.agentsDir(), `${name}.md`);
    case 'agy':      return join(join(AGY.homeDir(), 'agents'), `${name}.md`);
    case 'gemini':   return join(GEMINI.agentsDir(), `${name}.md`);
    case 'opencode': return join(OPENCODE.agentsDir(), `${name}.md`);
    case 'codex':    return join(CODEX.agentsDir(), `${name}.toml`);
    case 'cursor':   return join(cursorHomeDir(), 'agents', `${name}.md`);
  }
}

/** Instruction filename a tool reads. */
export function instructionsFilename(tool: ToolId): string {
  switch (tool) {
    case 'claude': return 'CLAUDE.md';
    case 'agy':
    case 'gemini': return 'GEMINI.md';
    case 'opencode':
    case 'codex':
    // Cursor reads AGENTS.md too (alongside .cursor/rules and CLAUDE.md).
    case 'cursor': return 'AGENTS.md';
  }
}

/**
 * Instruction target. With a `projectPath` we mirror within that project
 * (the sensible cross-tool op); without one we target the tool's global
 * instruction file.
 */
function instructionsPath(tool: ToolId, projectPath?: string): string {
  const file = instructionsFilename(tool);
  if (projectPath) return join(projectPath, file);
  switch (tool) {
    case 'claude':   return join(CLAUDE.homeDir(), file);
    case 'agy':      return join(AGY.homeDir(), file);
    case 'gemini':   return join(GEMINI.homeDir(), file);
    case 'codex':    return join(CODEX.homeDir(), file);
    case 'opencode': return join(homedir(), '.config', 'opencode', file);
    // Cursor has no single user-scope instructions FILE — user-level guidance
    // is User Rules plus ~/.cursor/rules/*.mdc. AGENTS.md at the home root is
    // the closest equivalent and is what a mirror can actually write.
    case 'cursor':   return join(cursorHomeDir(), file);
  }
}

// ── Emit ───────────────────────────────────────────────────────────

/** Produce the exact file a target tool needs for this artifact. */
export function emit(
  type: CodecType,
  art: NormalizedArtifact,
  toTool: ToolId,
  projectPath?: string,
): EmittedFile {
  if (type === 'instructions') {
    return { path: instructionsPath(toTool, projectPath), content: art.body.endsWith('\n') ? art.body : art.body + '\n' };
  }
  if (type === 'command') {
    if (toTool === 'gemini' || toTool === 'agy') {
      return { path: commandPath(toTool, art.name),
        content: stringifyScalarToml({ description: art.description, prompt: art.body }) };
    }
    return { path: commandPath(toTool, art.name),
      content: stringifyFrontmatter({ name: art.name, description: art.description }, art.body) };
  }
  // agent
  if (toTool === 'codex') {
    return { path: agentPath('codex', art.name),
      content: stringifyScalarToml({ name: art.name, description: art.description, developer_instructions: art.body }) };
  }
  return { path: agentPath(toTool, art.name),
    content: stringifyFrontmatter(
      { name: art.name, description: art.description, ...(art.tools ? { tools: art.tools } : {}) },
      art.body) };
}

function base(filePath: string): string {
  const b = filePath.split('/').pop() || filePath;
  return b.replace(/\.(md|toml)$/, '');
}
