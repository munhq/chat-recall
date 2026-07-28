/**
 * The tool registry must stay internally consistent. Three lists have to agree
 * and there was nothing enforcing it, so they drifted:
 *
 *   1. the tool DEFINITIONS  (`name: 'recall_…'` in the ListTools response)
 *   2. the DISPATCH switch    (`case 'recall_…':`)
 *   3. the `alwaysAllow` list written into AI-tool configs by `chat-recall init`
 *
 * Before this test, (3) named 11 tools that do not exist — some absorbed into
 * other tools (recall_files_touched → recall_edits_timeline's group_by,
 * recall_similar_sessions → recall_search's like_session), some never built
 * (recall_help, recall_plans) — while omitting 18 that do. Entries for missing
 * tools are inert, but they hid the real defect: a tool that DOES exist and is
 * absent from the list prompts for permission on every single call.
 *
 * Read from source text rather than by importing, because importing mcp.ts
 * starts a server and reads credentials.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mcpSrc = readFileSync(join(here, 'mcp.ts'), 'utf-8');
const cliSrc = readFileSync(join(here, 'cli.ts'), 'utf-8');

const uniq = (xs: string[]) => [...new Set(xs)].sort();
const matchAll = (src: string, re: RegExp) => uniq([...src.matchAll(re)].map((m) => m[1]));

const defined = matchAll(mcpSrc, /name: '(recall_[a-z_]+)'/g);
const dispatched = matchAll(mcpSrc, /case '(recall_[a-z_]+)':/g);

/** The alwaysAllow array literal in cli.ts — quoted entries only, so prose in
 *  comments naming a retired tool can't be mistaken for a live entry. */
const allowListed = (() => {
  const start = cliSrc.indexOf("'recall_search'");
  expect(start, 'alwaysAllow list not found in cli.ts').toBeGreaterThan(-1);
  const end = cliSrc.indexOf('];', start);
  return matchAll(cliSrc.slice(start, end), /'(recall_[a-z_]+)'/g);
})();

describe('MCP tool registry consistency', () => {
  test('every defined tool has a dispatch case', () => {
    expect(defined.filter((t) => !dispatched.includes(t))).toEqual([]);
  });

  test('every dispatch case has a tool definition', () => {
    expect(dispatched.filter((t) => !defined.includes(t))).toEqual([]);
  });

  test('alwaysAllow contains no tool that does not exist', () => {
    expect(allowListed.filter((t) => !defined.includes(t))).toEqual([]);
  });

  test('every tool is in alwaysAllow — otherwise it prompts on every call', () => {
    expect(defined.filter((t) => !allowListed.includes(t))).toEqual([]);
  });

  test('the registry is non-trivial (guards against a broken regex passing vacuously)', () => {
    expect(defined.length).toBeGreaterThan(40);
    expect(allowListed.length).toBe(defined.length);
  });
});
