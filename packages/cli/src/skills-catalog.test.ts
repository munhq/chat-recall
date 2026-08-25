/**
 * The shipped skills are the only thing telling an agent WHEN to reach for a
 * recall_* tool. A tool that no skill names is, in practice, a tool the agent
 * never calls — the MCP server offers 50 names and, with deferred tool loading,
 * not even their descriptions until something prompts a lookup.
 *
 * The hub carried a `BEGIN GENERATED TOOL CATALOG (scripts/gen-skills.ts — do
 * not edit by hand)` fence. That script was never written and is in no commit,
 * so the catalog was hand-maintained while telling contributors not to touch
 * it. It drifted: 13 registered tools appeared in no skill at all, including
 * the entire shared task board and team view, so "what are my open tasks"
 * routed nowhere.
 *
 * Same shape as mcp-tool-registry.test.ts, and for the same reason: lists that
 * must agree, with nothing enforcing it, drift. Read from source text rather
 * than by importing, because importing mcp.ts starts a server and reads
 * credentials.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, '..', 'skills');
/** The marketplace-published copy. See the plugin-parity block at the bottom. */
const pluginSkillsDir = join(here, '..', '..', '..', 'plugin', 'skills');

const defined = [...new Set(
  [...readFileSync(join(here, '../../engine/src/mcp/tools.ts'), 'utf-8').matchAll(/name: '(recall_[a-z_]+)'/g)].map((m) => m[1]),
)].sort();

/** Every SKILL.md we ship, as { name, text }. */
const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')))
  .map((e) => ({ name: e.name, text: readFileSync(join(skillsDir, e.name, 'SKILL.md'), 'utf-8') }));

const allSkillText = skills.map((s) => s.text).join('\n');
const hub = skills.find((s) => s.name === 'chat-recall')!;

/** Tool names a body of text mentions, in either the bare or the mcp__ form. */
function mentioned(text: string): Set<string> {
  return new Set(defined.filter((t) => text.includes(t)));
}

describe('skill / tool-catalog consistency', () => {
  test('every registered tool is named by at least one skill', () => {
    const covered = mentioned(allSkillText);
    expect(defined.filter((t) => !covered.has(t))).toEqual([]);
  });

  test('the hub catalog lists every tool — it claims to, and agents trust it', () => {
    const covered = mentioned(hub.text);
    expect(defined.filter((t) => !covered.has(t))).toEqual([]);
  });

  test('no skill names a tool that does not exist', () => {
    // Strip the qualified prefix FIRST: `\brecall_[a-z_]+\b` against
    // `mcp__chat-recall__recall_show` matches from the `-` boundary and yields
    // `recall__recall_show`, which is a bug in the check, not in the skill.
    const bare = allSkillText.replace(/mcp__chat-recall__/g, '');
    const named = [...new Set(
      [...bare.matchAll(/\b(recall_[a-z_]+)\b/g)].map((m) => m[1]),
    )].sort();
    expect(named.filter((t) => !defined.includes(t))).toEqual([]);
  });

  test('the fixture is non-trivial (a broken regex must not pass vacuously)', () => {
    expect(defined.length).toBeGreaterThan(40);
    expect(skills.length).toBeGreaterThanOrEqual(6);
  });

  test('no skill points at the generator that never existed', () => {
    // Kept as a test rather than a comment: the marker told contributors their
    // hand edit was wrong and sent them looking for a script that is not there.
    expect(allSkillText).not.toContain('gen-skills');
    expect(allSkillText).not.toContain('GENERATED TOOL CATALOG');
  });

  test('every skill has a name and a description in its frontmatter', () => {
    for (const s of skills) {
      expect(s.text.startsWith('---\n'), `${s.name}: no frontmatter`).toBe(true);
      const fm = s.text.slice(4, s.text.indexOf('\n---', 4));
      expect(fm, `${s.name}: no name:`).toMatch(/(^|\n)name:\s*\S/);
      expect(fm, `${s.name}: no description:`).toMatch(/(^|\n)description:/);
      expect(fm.match(/(^|\n)name:\s*(\S+)/)![2]).toBe(s.name);
    }
  });
});

describe('write tools are flagged as writes', () => {
  // "read-mostly and safe to call proactively" used to cover the whole catalog,
  // including the eight tools that mutate stored memory. An agent that reads
  // only the hub would fire those unprompted.
  const WRITES = [
    'recall_kg_add', 'recall_kg_invalidate', 'recall_decision_record',
    'recall_diary_write', 'recall_set', 'recall_task_create', 'recall_task_update',
    'recall_security_dismiss', 'recall_rename_session', 'recall_index',
    // Conditional: a read until `create_tasks: true`, which opens cards on the
    // shared board. Listed here because the hub must still warn about it — an
    // agent reading only the catalog would otherwise fire it unprompted.
    'recall_improvements',
  ];

  test('the hub does not describe every tool as safe to call proactively', () => {
    expect(hub.text).not.toMatch(/They are read-mostly and safe to call proactively/);
  });

  test('the hub names each write tool in its writes warning', () => {
    const warning = hub.text.slice(hub.text.indexOf('Reads are safe'), hub.text.indexOf('## Route'));
    expect(WRITES.filter((w) => !warning.includes(w))).toEqual([]);
  });
});

/**
 * `plugin/skills/` is a SECOND copy of these six files — it is what
 * `/plugin marketplace add munhq/chat-recall` publishes. Nothing synced it and
 * nothing tested it, so the copy the marketplace ships could drift silently
 * from the copy `chat-recall install-hooks` writes.
 *
 * It did. Two tools were added, the catalog above was updated, this file passed
 * because it only globs `packages/cli/skills`, and plugin users got skills that
 * never named the new tools.
 *
 * The two directories are byte-identical by design, so assert exactly that: any
 * edit has to land in both, or this fails and says which file was forgotten.
 */
describe('plugin skill parity', () => {
  const pluginSkills = readdirSync(pluginSkillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(pluginSkillsDir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();

  test('the plugin ships the same set of skills as the CLI', () => {
    expect(pluginSkills).toEqual(skills.map((s) => s.name).sort());
  });

  test.each(skills.map((s) => s.name))('%s is byte-identical in plugin/skills', (name) => {
    const pluginFile = join(pluginSkillsDir, name, 'SKILL.md');
    expect(existsSync(pluginFile), `plugin/skills/${name}/SKILL.md is missing`).toBe(true);
    expect(
      readFileSync(pluginFile, 'utf-8'),
      `plugin/skills/${name}/SKILL.md drifted from packages/cli/skills/${name}/SKILL.md — copy it across`,
    ).toBe(skills.find((s) => s.name === name)!.text);
  });

  test('the plugin catalog therefore names every registered tool too', () => {
    const pluginText = pluginSkills
      .map((n) => readFileSync(join(pluginSkillsDir, n, 'SKILL.md'), 'utf-8'))
      .join('\n');
    expect(defined.filter((t) => !pluginText.includes(t))).toEqual([]);
  });
});
