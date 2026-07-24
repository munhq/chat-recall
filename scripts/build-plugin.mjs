#!/usr/bin/env node
/**
 * Sync the Claude Code plugin from the single source of truth.
 *
 * The chat-recall skills live in packages/cli/skills/ (bundled with the CLI and
 * drop-installed by `chat-recall init`). The plugin/ dir is the Claude-marketplace
 * mirror. This copies the skills across and aligns the plugin version to the CLI
 * version so the two distribution channels never diverge.
 *
 * Run:  node scripts/build-plugin.mjs
 */
import { readFileSync, writeFileSync, rmSync, cpSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcSkills = join(root, 'packages', 'cli', 'skills');
const dstSkills = join(root, 'plugin', 'skills');
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

const skills = existsSync(dstSkills)
  ? (await import('fs')).readdirSync(dstSkills, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];
console.log(`plugin synced: ${skills.length} skill(s) @ v${manifest.version} → plugin/skills`);
console.log('  ' + skills.join(', '));
