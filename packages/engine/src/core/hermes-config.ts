/**
 * Hermes keeps its MCP servers under `mcp_servers:` in `config.yaml`. The file
 * is the whole Hermes configuration and carries comments, so every change is a
 * Document edit: the rest of the file is written back as it was read.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse, parseDocument, isMap } from 'yaml';
import { hermesHomeDir } from './tool-paths.js';

export function hermesConfigPath(): string {
  return join(hermesHomeDir(), 'config.yaml');
}

/** Every MCP server in the config, keyed by name, or null when the file is absent or unreadable. */
export function readHermesMcpServers(path = hermesConfigPath()): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try {
    const cfg = parse(readFileSync(path, 'utf-8')) as { mcp_servers?: Record<string, any> } | null;
    return cfg?.mcp_servers && typeof cfg.mcp_servers === 'object' ? cfg.mcp_servers : null;
  } catch {
    return null;
  }
}

/**
 * The fields Hermes reads for one server. Other fields in a source config
 * (`alwaysAllow`, `type`) belong to other tools and are left out.
 */
export function hermesServerEntry(entry: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(entry.command)) {
    out.command = String(entry.command[0] ?? '');
    const rest = (entry.command as unknown[]).slice(1).map(String);
    if (rest.length) out.args = rest;
  } else if (entry.command) {
    out.command = String(entry.command);
  }
  if (!out.args && Array.isArray(entry.args) && entry.args.length) out.args = entry.args.map(String);
  if (entry.url) out.url = String(entry.url);
  if (entry.env && typeof entry.env === 'object' && Object.keys(entry.env).length) out.env = entry.env;
  return out;
}

/** The new config text with the server added, or null when a server of that name already exists. */
export function addHermesMcpServer(text: string, name: string, entry: Record<string, unknown>): string | null {
  const doc = parseDocument(text);
  const servers = doc.get('mcp_servers');
  if (isMap(servers) && servers.has(name)) return null;
  doc.setIn(['mcp_servers', name], doc.createNode(entry));
  return doc.toString();
}

/** The new config text with the server removed, or null when no server of that name exists. */
export function deleteHermesMcpServer(text: string, name: string): string | null {
  const doc = parseDocument(text);
  const servers = doc.get('mcp_servers');
  if (!isMap(servers) || !servers.has(name)) return null;
  doc.deleteIn(['mcp_servers', name]);
  return doc.toString();
}
