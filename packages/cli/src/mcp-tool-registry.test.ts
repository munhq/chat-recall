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

  test('the setup-complete banner is derived, not hand-typed', () => {
    // `init` ends by printing the tool list — the last thing a new user reads.
    // It was a hardcoded literal claiming 42 tools, naming ten that do not
    // exist (recall_help, recall_plans, recall_files_touched,
    // recall_similar_sessions, recall_suggest_resume, recall_memory_status,
    // recall_plan_show, recall_outcome, recall_session_files, recall_kv_list)
    // while omitting the ones that do. It now prints DEFAULT_ALLOW, which the
    // tests above pin to the real registry. Assert no literal crept back.
    const banner = cliSrc.slice(cliSrc.indexOf('Setup complete!'));
    const hardcoded = [...banner.matchAll(/console\.log\('[^']*(recall_[a-z_]+)[^']*'\)/g)];
    expect(hardcoded.map((m) => m[1])).toEqual([]);
  });

  test('the registry is non-trivial (guards against a broken regex passing vacuously)', () => {
    expect(defined.length).toBeGreaterThan(40);
    expect(allowListed.length).toBe(defined.length);
  });
});

/**
 * Annotations are how a host learns that 40 of these tools only read. Without
 * them every call looks like it could mutate the user's memory, so the client
 * asks before each one — and Glama's "Behavioral Transparency" dimension, 20%
 * of its tool-quality score, has nothing to read.
 */
describe('MCP tool annotations', () => {
  const setNames = (name: string) => {
    const start = mcpSrc.indexOf(`const ${name} = new Set<string>([`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    return matchAll(mcpSrc.slice(start, mcpSrc.indexOf(']);', start)), /'(recall_[a-z_]+)'/g);
  };
  const writes = setNames('WRITE_TOOLS');
  const destructive = setNames('DESTRUCTIVE_TOOLS');
  const idempotent = setNames('IDEMPOTENT_TOOLS');

  test('both ListTools return paths annotate — lean and full', () => {
    expect(mcpSrc).toContain('return { tools: all.map(annotate) }');
    expect(mcpSrc).toContain('return { tools: lean.map(annotate) }');
  });

  test('no annotation set names a tool that does not exist', () => {
    expect(writes.filter((t) => !defined.includes(t))).toEqual([]);
    expect(destructive.filter((t) => !defined.includes(t))).toEqual([]);
    expect(idempotent.filter((t) => !defined.includes(t))).toEqual([]);
  });

  test('destructive and idempotent only qualify tools that write', () => {
    expect(destructive.filter((t) => !writes.includes(t))).toEqual([]);
    expect(idempotent.filter((t) => !writes.includes(t))).toEqual([]);
  });

  test('the obvious writers are declared — a missed one is a false read-only claim', () => {
    for (const t of ['recall_index', 'recall_kg_add', 'recall_diary_write', 'recall_set',
      'recall_task_create', 'recall_decision_record']) {
      expect(writes, `${t} mutates state and must not be marked read-only`).toContain(t);
    }
  });

  test('search and show are never marked as writers', () => {
    for (const t of ['recall_search', 'recall_show', 'recall_recent', 'recall_smart_resume']) {
      expect(writes).not.toContain(t);
    }
  });
});

/**
 * The published tool count must match the registry, by the SAME rule the site
 * uses. `chat-recall-site/check-parity.mjs` counts `recall_*` definitions and
 * excludes `recall_help`, because that tool is a directory of the others rather
 * than a capability. Two repos quoting one number need one rule, so this test
 * mirrors it — otherwise fixing the docs here breaks the deploy gate there.
 */
const ADVERTISED = defined.filter((t) => t !== 'recall_help').length;

describe('published tool count', () => {
  const repoRoot = join(here, '..', '..', '..');
  for (const rel of ['README.md', 'CLAUDE.md', 'docs/REGISTRIES.md']) {
    test(`${rel} states the advertised count`, () => {
      const text = readFileSync(join(repoRoot, rel), 'utf-8');
      const claims = [...text.matchAll(/(\d+)\s+(?:MCP\s+)?tools/g)].map((m) => Number(m[1]));
      const wrong = claims.filter((n) => n > 40 && n !== ADVERTISED);
      expect(wrong, `${rel} claims ${wrong.join(', ')} but ${ADVERTISED} are advertised`).toEqual([]);
    });
  }
});
