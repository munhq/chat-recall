/**
 * Tool descriptions are a PUBLIC SURFACE, and now a reviewed one.
 *
 * They ship three ways: into every user's assistant as the MCP tool list, into
 * the official registry, and — since the connector submission — into a directory
 * listing a reviewer reads line by line. A wrong description is not cosmetic:
 * the model treats it as fact about the very system it is querying.
 *
 * Two failures already happened and are pinned here:
 *
 *   1. PRIVATE NAMES. `recall_commits` illustrated multi-repo support with two
 *      of the maintainer's real private projects, and `recall_project_context`
 *      named another two. CLAUDE.md documents this exact failure — a client name
 *      once reached a description in this file — and explains why it recurs:
 *      writing an example needs a concrete value, and the nearest concrete value
 *      is the real one. Invent it.
 *   2. STALE FACTS. Examples named LanceDB and SQLite FTS5. The product uses
 *      neither; search is Postgres FTS. An example naming the wrong datastore
 *      teaches the model something false about the thing it is querying.
 */
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'tools.ts'), 'utf-8');

/**
 * Only the text that SHIPS.
 *
 * Scanning the whole file is wrong in both directions: it flags internal code
 * comments nobody outside ever reads (a note about lazy-importing lancedb is not
 * a claim about the product), and it would miss nothing it should catch, since
 * every published string is either a `description:` or a `.describe(...)`.
 */
const shipped = [
  ...src.matchAll(/\.describe\(\s*(['"`])([\s\S]*?)\1\s*\)/g),
  ...src.matchAll(/description:\s*(['"`])([\s\S]*?)\1/g),
].map((m) => m[2]).join('\n');

describe('tool descriptions are safe to publish', () => {
  test('the extraction is non-trivial — a broken regex must not pass vacuously', () => {
    expect(shipped.length).toBeGreaterThan(20_000);
    expect(shipped).toMatch(/Search for relevant past sessions/);
  });

  test('no private project, machine or account name appears', () => {
    // The names themselves are NOT listed here, and that is the point: a
    // denylist of private names hardcoded in a public repository leaks exactly
    // what it guards. (The pre-commit hook refused an earlier version of this
    // file for precisely that.)
    //
    // So the operator's list is read from outside the repo — the same file the
    // hook checks — and the test simply skips where that file does not exist,
    // which is CI and every contributor's machine. The shape checks below run
    // everywhere and are what actually generalises.
    const listPath = join(homedir(), '.config', 'chat-recall', 'private-names.txt');
    if (!existsSync(listPath)) return;
    const names = readFileSync(listPath, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('[') && l.length > 3);
    // A name the project's own README publishes is not private. Some entries on
    // the operator's list are their own PUBLIC repos, documented here by name —
    // they are listed because they own them, not because they are secret. The
    // README is this project's public face, so it is the honest arbiter of what
    // has already been said out loud.
    const readme = readFileSync(resolve(here, '../../../../README.md'), 'utf-8').toLowerCase();
    for (const name of names) {
      if (readme.includes(name.toLowerCase())) continue;
      expect(shipped, `"${name}" must not appear in a shipped tool description`)
        .not.toMatch(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
    }
  });

  test('no home directory of a real person', () => {
    expect(shipped).not.toMatch(/~\/code\/personal\//);
    expect(shipped).not.toMatch(/\/home\/adi\b/);
  });

  test('examples do not name datastores the product does not use', () => {
    // NO embedded SQLite, NO LanceDB — see the product model in CLAUDE.md.
    expect(shipped).not.toMatch(/LanceDB/i);
    expect(shipped).not.toMatch(/FTS5/);
  });

  test('the tools that span every AI tool say so, including Cursor', () => {
    const i = shipped.indexOf('Chronological list of file edits');
    expect(i).toBeGreaterThan(-1);
    expect(shipped.slice(i, i + 300)).toMatch(/Cursor/);
  });
});
