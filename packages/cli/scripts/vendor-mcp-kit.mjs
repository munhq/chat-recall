#!/usr/bin/env node
/**
 * Copy the host of `@munhq/mcp-kit` into `src/vendor/mcp-kit`.
 *
 * chat-recall installs one host per machine, and it does that on a machine that
 * has only the public package: the kit lives on GitHub Packages and a public
 * install has no token for it. So the CLI carries the host itself, as compiled
 * files with their declarations, and `chat-recall hooks install` runs them from
 * `dist/vendor`. The kit has no token to give here: these four modules read
 * Node's own modules only, and the host holds no secret of its own.
 *
 * A `sourceMappingURL` line points at a map that stays in the kit, so the copy
 * drops it: the map is not here, and a loader that reads the line reports a
 * missing file at every start.
 *
 * `src/vendor/mcp-kit/VERSION` names the version the folder holds. The test
 * `src/vendor-mcp-kit.test.ts` fails when the folder and the pin disagree.
 *
 *   node scripts/vendor-mcp-kit.mjs           copy the pinned version
 *   node scripts/vendor-mcp-kit.mjs 0.24.0    copy another version, and print the pin to write
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The version this repository carries. Change it together with VERSION and the test. */
export const PINNED = '0.23.3';

/** The modules the host needs: its program, its loop, its file of servers, and the machine. */
const FILES = [
  'host.js', 'host.d.ts',
  'host-plain.js', 'host-plain.d.ts',
  'host-main.js', 'host-main.d.ts',
  'registry.js', 'registry.d.ts',
];

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'src', 'vendor', 'mcp-kit');
const wanted = process.argv[2] ?? PINNED;
if (!/^\d+\.\d+\.\d+$/.test(wanted)) throw new Error(`usage: node scripts/vendor-mcp-kit.mjs <version>, for example ${PINNED}`);

/** The installed package. The kit publishes no `./package.json` export, so the folder is found by walking up. */
function installed() {
  for (let dir = here; ; dir = dirname(dir)) {
    const path = join(dir, 'node_modules', '@munhq', 'mcp-kit', 'package.json');
    if (existsSync(path)) return dirname(path);
    if (dirname(dir) === dir) throw new Error('@munhq/mcp-kit is not installed: npm i -D @munhq/mcp-kit@' + wanted);
  }
}

const root = installed();
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (version !== wanted) {
  throw new Error(`@munhq/mcp-kit ${wanted} is not installed (this machine has ${version}). Install it first: npm i -D @munhq/mcp-kit@${wanted}`);
}

const from = join(root, 'dist', 'cli');
for (const file of FILES) {
  const text = readFileSync(join(from, file), 'utf8');
  // A vendored file may import Node's own modules and its own folder, and nothing else: anything more would be a
  // dependency that a public install does not have.
  for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    if (!m[1].startsWith('node:') && !m[1].startsWith('./')) {
      throw new Error(`${file} imports ${m[1]}, so it cannot be vendored`);
    }
  }
}

/** The text to write: the file, with the line that names a map the kit keeps. */
function withoutMap(file) {
  return readFileSync(join(from, file), 'utf8').replace(/^\/\/# sourceMappingURL=.*\n?/gm, '');
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of FILES) writeFileSync(join(out, file), withoutMap(file));
writeFileSync(join(out, 'VERSION'), `@munhq/mcp-kit ${version}\n`);
process.stdout.write(`vendored @munhq/mcp-kit ${version}: ${FILES.length} files in src/vendor/mcp-kit\n`);
if (version !== PINNED) process.stdout.write(`now set PINNED in this script and the version in src/vendor-mcp-kit.test.ts to ${version}\n`);
