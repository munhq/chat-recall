#!/usr/bin/env node
/**
 * Sync the Claude Code plugin from the single source of truth.
 *
 * The chat-recall skills live in packages/cli/skills/ (bundled with the CLI and
 * drop-installed by `chat-recall init`). The plugin/ dir is the Claude-marketplace
 * mirror. This copies the skills across and aligns the plugin version to the CLI
 * version so the two distribution channels never diverge.
 *
 * It also writes chatgpt-plugin/skills, the same skills with the Claude MCP
 * tool-name prefix removed, because the ChatGPT app exposes the bare names.
 *
 * Run:  node scripts/build-plugin.mjs
 */
import { readFileSync, writeFileSync, rmSync, cpSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcSkills = join(root, 'packages', 'cli', 'skills');
const dstSkills = join(root, 'plugin', 'skills');
const dstChatgptSkills = join(root, 'chatgpt-plugin', 'skills');
/** How Claude Code namespaces this server's tools; ChatGPT uses the bare names. */
const MCP_PREFIX = 'mcp__chat-recall__';
const cliPkg = JSON.parse(readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf-8'));
const manifestPath = join(root, 'plugin', '.claude-plugin', 'plugin.json');

if (!existsSync(srcSkills)) { console.error(`no skills at ${srcSkills}`); process.exit(1); }

// Mirror skills (clean copy so removed skills don't linger in the plugin).
rmSync(dstSkills, { recursive: true, force: true });
mkdirSync(dstSkills, { recursive: true });
cpSync(srcSkills, dstSkills, { recursive: true });

// Align the plugin version to the CLI version.
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
manifest.version = cliPkg.version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// The ChatGPT mirror, with the tool names rewritten.
//
// The Claude copies name tools as `mcp__chat-recall__recall_search`, which is
// how Claude Code namespaces an MCP server's tools. The ChatGPT app exposes the
// SAME tools under their bare names — `recall_search` — as OpenAI's own scan of
// https://chatrecall.dev/mcp reports. A skill telling ChatGPT to call
// `mcp__chat-recall__recall_search` names a tool that does not exist there, and
// the model either fails the call or ignores the skill.
//
// So this is a rewrite, not a copy, and it is GENERATED for the same reason
// plugin/ is: three hand-maintained copies of six skills drift, and the drift
// is invisible until an agent silently stops calling a tool.
rmSync(dstChatgptSkills, { recursive: true, force: true });
mkdirSync(dstChatgptSkills, { recursive: true });
cpSync(srcSkills, dstChatgptSkills, { recursive: true });
let rewritten = 0;
for (const entry of readdirSync(dstChatgptSkills, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = join(dstChatgptSkills, entry.name, 'SKILL.md');
  if (!existsSync(file)) continue;
  const before = readFileSync(file, 'utf-8');
  const after = before.split(MCP_PREFIX).join('');
  if (after !== before) rewritten += before.split(MCP_PREFIX).length - 1;
  writeFileSync(file, after);
}

const skills = existsSync(dstSkills)
  ? (await import('fs')).readdirSync(dstSkills, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];
console.log(`plugin synced: ${skills.length} skill(s) @ v${manifest.version} → plugin/skills`);
console.log('  ' + skills.join(', '));
console.log(`chatgpt synced: ${skills.length} skill(s) → chatgpt-plugin/skills (${rewritten} tool name(s) unprefixed)`);
