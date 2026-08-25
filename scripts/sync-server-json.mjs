/**
 * Write the CLI's version into every manifest that publishes one.
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
 * It covers TWO files, because the second one drifted the same way and nobody
 * noticed for eight releases: plugin/.claude-plugin/plugin.json sat at 0.5.6
 * while the CLI shipped 0.5.14. That manifest is what the Anthropic plugin
 * directory reads, so the listing would have advertised a version no user could
 * install. A bump that covers one manifest and not the other is the same manual
 * step this script exists to delete.
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
/**
 * Set every version field in one manifest. `stamp` returns the versions it found
 * before writing, so the log says what actually moved.
 */
function sync(relPath, stamp) {
  const path = resolve(root, relPath);
  const raw = readFileSync(path, 'utf8');
  const manifest = JSON.parse(raw);
  const before = stamp(manifest);

  // Preserve the file's trailing newline convention rather than reformatting it:
  // a version bump should produce a one-line diff, not a whitespace rewrite.
  //
  // Note on non-ASCII: JSON.stringify emits real characters, not \uXXXX escapes.
  // If a manifest was previously written with escaped em-dashes, the first run
  // normalises them and the diff is two lines, not one. That happens once.
  const out = `${JSON.stringify(manifest, null, 2)}${raw.endsWith('\n') ? '\n' : ''}`;
  if (out === raw) {
    console.log(`${relPath} already at ${cliVersion} — nothing to do`);
    return;
  }
  writeFileSync(path, out);
  console.log(`${relPath} ${before.join('/')} -> ${cliVersion}`);
}

// The MCP registry manifest: its own version, plus the version of every package
// entry, since the registry validates that the npm tarball actually exists.
sync('server.json', (m) => {
  const before = [m.version, ...(m.packages ?? []).map((p) => p.version)];
  m.version = cliVersion;
  for (const p of m.packages ?? []) p.version = cliVersion;
  return before;
});

// The Claude Code plugin manifest, read by the Anthropic plugin directory.
sync('plugin/.claude-plugin/plugin.json', (m) => {
  const before = [m.version];
  m.version = cliVersion;
  return before;
});
