#!/usr/bin/env node
/**
 * Write the reference data of the docs site from the built product: every MCP
 * tool with its description and parameters, and every CLI command with its
 * options. The docs site renders the pages from this JSON, so the reference
 * names what the shipped server and CLI do.
 *
 *   node scripts/dump-reference.mjs <out.json>
 *
 * Needs `npm run build` first. It reads packages/engine/dist and
 * packages/cli/dist, and runs the CLI only with `--help`, in a temp home.
 *
 * The MCP list is the full profile (CHAT_RECALL_MCP_PROFILE=full). The four
 * code-intelligence tools register only when a `codeindex` binary is on PATH,
 * so a stub one is put there for the listing.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/dump-reference.mjs <out.json>');
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), 'cr-reference-'));
const stubBin = join(home, 'bin');
mkdirSync(stubBin);
writeFileSync(join(stubBin, 'codeindex'), '#!/bin/sh\nexit 0\n');
chmodSync(join(stubBin, 'codeindex'), 0o755);
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CHAT_RECALL_DATA_DIR: join(home, 'data'),
  CHAT_RECALL_MCP_PROFILE: 'full',
  CHAT_RECALL_NO_DAEMON: '1',
  CHAT_RECALL_NO_UPDATE_CHECK: '1',
  NO_COLOR: '1',
  PATH: `${stubBin}:${process.env.PATH ?? ''}`,
};
Object.assign(process.env, env);

// ── MCP tools ────────────────────────────────────────────────────────────────
const dist = (p) => pathToFileURL(join(ROOT, 'packages/engine/dist', p)).href;
const { createMcpServer } = await import(dist('mcp/tools.js'));
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const server = createMcpServer();
await server.connect(serverSide);
const client = new Client({ name: 'dump-reference', version: '0' });
await client.connect(clientSide);
const tools = [];
let cursor;
do {
  const page = await client.listTools(cursor ? { cursor } : {});
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);
await client.close();

const mcp = tools
  .map((t) => ({
    name: t.name,
    title: t.annotations?.title ?? t.title ?? null,
    description: (t.description ?? '').trim(),
    readOnly: t.annotations?.readOnlyHint ?? null,
    destructive: t.annotations?.destructiveHint ?? null,
    params: Object.entries(t.inputSchema?.properties ?? {}).map(([name, s]) => ({
      name,
      type: s.type ?? (s.enum ? 'string' : s.anyOf ? 'any' : null),
      enum: s.enum ?? null,
      default: s.default ?? null,
      required: (t.inputSchema?.required ?? []).includes(name),
      description: (s.description ?? '').trim(),
    })),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// ── CLI commands ─────────────────────────────────────────────────────────────
const cliEntry = join(ROOT, 'packages/cli/dist/cli.js');
const help = (args) => execFileSync(process.execPath, [cliEntry, ...args, '--help'], {
  env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
});

/** The sections of a commander help text: usage, description, options, commands. */
function parseHelp(text) {
  const lines = text.split('\n');
  const usage = (lines.find((l) => l.startsWith('Usage:')) ?? '').replace(/^Usage:\s*/, '').trim();
  const section = (name) => {
    const i = lines.findIndex((l) => l.trim() === `${name}:`);
    if (i < 0) return [];
    const items = [];
    for (const l of lines.slice(i + 1)) {
      if (!l.trim()) { if (items.length) break; continue; }
      if (/^\S/.test(l)) break;
      const m = l.match(/^\s{2}(\S.*?)(?:\s{2,}(.*))?$/);
      if (!m) continue;
      if (m[1] && /^\s{3,}/.test(l) && items.length && !m[2] && l.startsWith('    ')) {
        items[items.length - 1].description += ` ${l.trim()}`;
        continue;
      }
      items.push({ term: m[1].trim(), description: (m[2] ?? '').trim() });
    }
    return items;
  };
  const usageIdx = lines.findIndex((l) => l.startsWith('Usage:'));
  const descLines = [];
  for (const l of lines.slice(usageIdx + 1)) {
    if (/^(Options|Commands|Arguments):/.test(l.trim())) break;
    descLines.push(l.trim());
  }
  return {
    usage,
    description: descLines.join(' ').replace(/\s+/g, ' ').trim(),
    arguments: section('Arguments'),
    options: section('Options').filter((o) => !/^-h, --help/.test(o.term)),
    commands: section('Commands').filter((c) => !/^help \[command\]/.test(c.term)),
  };
}

function walk(path) {
  const h = parseHelp(help(path));
  const node = { path: path.join(' '), usage: h.usage, description: h.description, arguments: h.arguments, options: h.options, commands: [] };
  for (const c of h.commands) {
    const name = c.term.split(/[\s|]/)[0];
    node.commands.push(walk([...path, name]));
  }
  return node;
}
const cli = walk([]);

writeFileSync(out, JSON.stringify({ version: 1, mcp, cli }, null, 2) + '\n');
const count = (n) => n.commands.reduce((s, c) => s + 1 + count(c), 0);
console.log(`dump-reference: ${mcp.length} MCP tools, ${count(cli)} CLI commands → ${out}`);
process.exit(0);
