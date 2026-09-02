#!/usr/bin/env node
/**
 * Build the .mcpb bundle — the thing Claude Desktop installs, and the part
 * Smithery's API refuses a stdio release without.
 *
 * ── Why a bundle at all, for an npm package ───────────────────────────────
 *
 * codeindex bundles a compiled binary, so its bundle spares the user a
 * toolchain. chat-recall is an npm package, so this one is thinner: a manifest,
 * and a launcher that runs the published CLI through npx. That is still worth
 * shipping, because the bundle is what a one-click install in Claude Desktop
 * consumes, and because Smithery answers `400 Missing required part: bundle`
 * without it.
 *
 * ── Why one-click actually works here ─────────────────────────────────────
 *
 * A user installing this has no credentials and has never run the CLI. They do
 * not need to: the MCP server spawns `chat-recall init` on the first tool call
 * that needs an account (mcp.ts), opens the browser, and that init installs the
 * skills, registers the server with their other AI tools and runs the first
 * sync. So the bundle lands them in a working product rather than in sixty tools
 * that all answer "run login first".
 *
 * ── What is NOT in it ─────────────────────────────────────────────────────
 *
 * No CLI, no skills, no node_modules. The launcher is `npx -y -p chat-recall
 * chat-recall-mcp`, so the bundle stays a few kilobytes and can never ship a
 * stale copy of a package npm already serves. The skills reach the user through
 * that same init, from the version they actually installed.
 *
 * Usage:
 *   node scripts/smithery/build-mcpb.mjs --out chat-recall-<version>.mcpb [--card card.json]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const pkg = JSON.parse(readFileSync(path.join(repo, 'packages/cli/package.json'), 'utf8'));

const argv = process.argv.slice(2);
const argOf = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};

// Resolved, because zip runs with cwd set to the staging directory: a relative
// --out would be created inside a temp dir that is deleted moments later.
const out = path.resolve(argOf('--out', `chat-recall-${pkg.version}.mcpb`));
const cardPath = argOf('--card');

/** The tool list, when a card was captured. Declared in the manifest so a client
 *  can show what it is installing before it runs anything. */
let tools = [];
if (cardPath) {
  const card = JSON.parse(readFileSync(cardPath, 'utf8'));
  const list = card.tools || card.result?.tools || [];
  tools = list.map((t) => ({ name: t.name, description: t.description || '' }));
}

const stage = mkdtempSync(path.join(tmpdir(), 'chat-recall-mcpb-'));
try {
  mkdirSync(path.join(stage, 'server'));

  // The launcher. `-p chat-recall` then the BIN name: `npx -y chat-recall-mcp`
  // looks right and is E404, because chat-recall-mcp is a bin inside the
  // chat-recall package rather than a package of its own — the same mistake that
  // sat in smithery.yaml until it was found.
  writeFileSync(
    path.join(stage, 'server', 'launch.js'),
    `#!/usr/bin/env node
// Run the published MCP server. The bundle deliberately carries no copy of it:
// npx resolves the version on npm, so an install can never be pinned to whatever
// happened to be vendored on the day the bundle was built.
import { spawn } from 'node:child_process';

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['-y', '-p', 'chat-recall', 'chat-recall-mcp'],
  { stdio: 'inherit', env: process.env },
);
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
child.on('error', (err) => {
  process.stderr.write(\`chat-recall: could not start the MCP server (\${err.message}).\\n\`);
  process.stderr.write('Node 22+ and npx are required; install Node and try again.\\n');
  process.exit(1);
});
`,
  );
  writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify({ name: 'chat-recall-mcpb', version: pkg.version, private: true, type: 'module' }, null, 2)}\n`,
  );

  const manifest = {
    manifest_version: '0.3',
    name: 'chat-recall',
    display_name: 'chat-recall',
    version: pkg.version,
    description:
      'One searchable memory across Claude Code, Gemini CLI, Codex, OpenCode, Antigravity and Cursor sessions.',
    long_description:
      'Your AI tools cannot read each other\'s history. chat-recall indexes the transcripts they already write, '
      + 'redacts credentials on your machine before anything uploads, and gives the agent tools to resume prior '
      + 'sessions, search past work and recall decisions across every tool you use. Also finds credentials you '
      + 'pasted and checks which ones still work.',
    author: { name: 'munhq', url: 'https://github.com/munhq' },
    homepage: 'https://chatrecall.dev',
    repository: { type: 'git', url: 'https://github.com/munhq/chat-recall' },
    license: 'Elastic-2.0',
    keywords: ['mcp', 'memory', 'context', 'claude-code', 'session-history'],
    // Referenced by URL rather than packed in, so the bundle stays small.
    icons: [
      { src: 'https://chatrecall.dev/apple-touch-icon.png', size: '180x180' },
    ],
    server: {
      type: 'node',
      entry_point: 'server/launch.js',
      mcp_config: { command: 'node', args: ['${__dirname}/server/launch.js'] },
    },
    tools,
    tools_generated: false,
    compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=22.5.0' } },
  };
  writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  rmSync(out, { force: true });
  // zip, not a JS zip library: this runs on a release runner and in a terminal,
  // and both have it. A dependency here would be the only one this script needs.
  execFileSync('zip', ['-qr', out, '.'], { cwd: stage });
} finally {
  rmSync(stage, { recursive: true, force: true });
}

const bytes = readFileSync(out);
process.stdout.write(
  `${path.basename(out)}  ${statSync(out).size} bytes  sha256=${createHash('sha256').update(bytes).digest('hex')}\n`
  + `  version ${pkg.version}, ${tools.length} tool(s) declared\n`,
);
