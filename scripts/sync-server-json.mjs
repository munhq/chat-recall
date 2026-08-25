/**
 * Write the CLI's version into server.json, the MCP registry manifest.
 *
 * WHY THIS EXISTS. The two versions must match — the registry publishes what
 * server.json says, so drift points the listing at the wrong tarball — and
 * server-json-parity.test.ts asserts it. But the bump was a manual step nobody
 * could see, so the sequence was: bump packages/cli/package.json, tag, push, the
 * image publishes, and THEN the release fails on a version field. It has happened
 * twice: once left the registry advertising a version five releases old
 * (d95f6574), once failed the 0.5.13 npm publish after the image had already
 * shipped.
 *
 * Run it as part of a version bump: `npm run version:sync`.
 *
 * It only ever copies — the CLI's package.json is the single source of the
 * number, so this cannot invent a version or disagree with the tag check in
 * release-npm.yml.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliVersion = JSON.parse(readFileSync(resolve(root, 'packages/cli/package.json'), 'utf8')).version;
const path = resolve(root, 'server.json');
const raw = readFileSync(path, 'utf8');
const manifest = JSON.parse(raw);

const before = [manifest.version, ...(manifest.packages ?? []).map((p) => p.version)];
manifest.version = cliVersion;
for (const p of manifest.packages ?? []) p.version = cliVersion;

// Preserve the file's trailing newline convention rather than reformatting it:
// a version bump should produce a one-line diff, not a whitespace rewrite.
const out = `${JSON.stringify(manifest, null, 2)}${raw.endsWith('\n') ? '\n' : ''}`;
if (out === raw) {
  console.log(`server.json already at ${cliVersion} — nothing to do`);
} else {
  writeFileSync(path, out);
  console.log(`server.json ${before.join('/')} -> ${cliVersion}`);
}
