/**
 * Skills must reach EVERY Claude profile, not just the primary home.
 *
 * `CLAUDE_CONFIG_DIR=~/.claude-work` makes that directory the entire config
 * root for a session: Claude Code reads skills from `<that home>/skills` and
 * nowhere else. The installer used to resolve one home, so a profile ran with
 * zero recall skills while its transcripts indexed normally — measured on a
 * real machine (2026-08-15): `~/.claude/skills` held all six, `~/.claude-work`
 * held none, and every other check reported green. The scan side had fanned out
 * over profiles since day one; only the write side was single-home.
 *
 * The dedupe half is load-bearing in the other direction: multi-profile setups
 * usually symlink each profile's `skills/` back to the primary, and without
 * resolving real paths one directory is reported as four separate installs.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useHomeDir } from '@chat-recall/engine/test-support/home-env.js';

let home: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['HOME', 'CHAT_RECALL_CLAUDE_HOME', 'CLAUDE_DIRS', 'CHAT_RECALL_DATA_DIR'];

/** The modules read env at call time; import fresh so nothing is cached. */
async function mods() {
  return await import('./install-skills.js');
}

/** A Claude home is a directory with `projects/` — that is what makes it an
 *  install rather than a directory someone happened to create. */
function claudeHome(name: string, opts: { withProjects?: boolean } = {}): string {
  const dir = join(home, name);
  if (opts.withProjects !== false) mkdirSync(join(dir, 'projects', '-proj'), { recursive: true });
  else mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'cr-skills-'));
  useHomeDir(home);
  // A home override disables sibling discovery, so it must be clear.
  delete process.env.CHAT_RECALL_CLAUDE_HOME;
  delete process.env.CLAUDE_DIRS;
  process.env.CHAT_RECALL_DATA_DIR = join(home, '.chat-recall');
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('skill targets across Claude profiles', () => {
  test('a sibling profile is a target of its own — the regression', async () => {
    claudeHome('.claude');
    claudeHome('.claude-work');
    const { skillTargets } = await mods();

    const claude = skillTargets().filter((t) => t.id.startsWith('claude'));
    const dirs = claude.map((t) => t.dir);
    expect(dirs).toContain(join(home, '.claude', 'skills'));
    expect(dirs).toContain(join(home, '.claude-work', 'skills'));
    // Both are real installs, so both are eligible without --all-tools.
    expect(claude.every((t) => t.available)).toBe(true);
  });

  test('the primary keeps the bare `claude` id, so existing output is stable', async () => {
    claudeHome('.claude');
    claudeHome('.claude-work');
    const { skillTargets } = await mods();

    const claude = skillTargets().filter((t) => t.id.startsWith('claude'));
    expect(claude[0].id).toBe('claude');
    expect(claude[0].dir).toBe(join(home, '.claude', 'skills'));
    expect(claude.map((t) => t.id)).toContain('claude:.claude-work');
  });

  test('a profile whose skills/ symlinks to the primary is counted once', async () => {
    claudeHome('.claude');
    const t1 = claudeHome('.claude-t1');
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(home, '.claude', 'skills'), join(t1, 'skills'));
    const { skillTargets } = await mods();

    const dirs = skillTargets().filter((t) => t.id.startsWith('claude')).map((t) => t.dir);
    expect(dirs).toEqual([join(home, '.claude', 'skills')]);
  });

  test('a `.claude-*` directory with no projects/ is not an install to configure', async () => {
    claudeHome('.claude');
    claudeHome('.claude-backups', { withProjects: false });
    const { skillTargets } = await mods();

    const backups = skillTargets().find((t) => t.id === 'claude:.claude-backups');
    expect(backups).toBeDefined();          // discovered, so --all-tools can reach it
    expect(backups!.available).toBe(false); // but never installed to by default
  });

  test('.claude-code is excluded — same carve-out as the scan side', async () => {
    claudeHome('.claude');
    claudeHome('.claude-code');
    const { skillTargets } = await mods();

    expect(skillTargets().some((t) => t.id === 'claude:.claude-code')).toBe(false);
  });
});

describe('installing into every profile', () => {
  test('each profile gets the skills, and a user-owned skill is never clobbered', async () => {
    claudeHome('.claude');
    claudeHome('.claude-work');
    const { installSkills, bundledSkillNames } = await mods();
    const names = bundledSkillNames();
    expect(names.length).toBeGreaterThan(0);

    // A skill of the user's own that collides on name, with no managed marker.
    const mine = join(home, '.claude-work', 'skills', names[0]);
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'SKILL.md'), 'mine, not theirs\n');

    const res = installSkills();
    const work = res.perTarget.find((t) => t.id === 'claude:.claude-work')!;

    expect(work.installed).toEqual(names.slice(1));
    expect(work.skippedUserOwned).toEqual([names[0]]);
    expect(readFileSync(join(mine, 'SKILL.md'), 'utf-8')).toBe('mine, not theirs\n');
    // The rest really landed, marker and all.
    for (const n of names.slice(1)) {
      expect(existsSync(join(home, '.claude-work', 'skills', n, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.claude-work', 'skills', n, '.chat-recall-managed'))).toBe(true);
    }
  });

  test('a profile missing its skills makes the refresh check fire', async () => {
    claudeHome('.claude');
    claudeHome('.claude-work');
    const { installSkills, skillsNeedRefresh } = await mods();

    expect(skillsNeedRefresh()).toBe(true);
    installSkills();
    expect(skillsNeedRefresh()).toBe(false);

    // Losing ONE profile's copy is enough to need a refresh again — this is
    // what makes the MCP server self-heal a profile added after install.
    rmSync(join(home, '.claude-work', 'skills'), { recursive: true, force: true });
    expect(skillsNeedRefresh()).toBe(true);
  });

  test('an EDITED skill refreshes without a version bump — the stranding bug', async () => {
    // The gate compared the package version. A skill edit shipped between
    // releases left bundled content changed, `version()` unchanged, the
    // installed marker matching, and the new text reaching nobody. Measured on
    // a real machine (2026-08-19): two tools were added to the catalog, every
    // marker read 0.5.0, the bundled skills read 0.5.0, and skillsNeedRefresh()
    // said false. Editing a skill is far more common than cutting a release, so
    // the gate keys on content.
    claudeHome('.claude');
    const { installSkills, skillsNeedRefresh, skillsSourceDir, bundledSkillNames } = await mods();

    installSkills();
    expect(skillsNeedRefresh()).toBe(false);

    // Edit a bundled skill in place. The package version does NOT move.
    const target = join(skillsSourceDir(), bundledSkillNames()[0], 'SKILL.md');
    const original = readFileSync(target, 'utf-8');
    try {
      writeFileSync(target, original + '\n<!-- edited between releases -->\n');
      expect(skillsNeedRefresh()).toBe(true);

      // …and the refresh actually delivers the new bytes.
      installSkills();
      expect(skillsNeedRefresh()).toBe(false);
      const delivered = readFileSync(
        join(home, '.claude', 'skills', bundledSkillNames()[0], 'SKILL.md'), 'utf-8');
      expect(delivered).toContain('edited between releases');
    } finally {
      writeFileSync(target, original);
    }
  });

  test('a marker from an older release refreshes once', async () => {
    // Existing installs hold a bare version string. It can never equal the
    // `<version> <hash>` stamp, so they self-heal on the next MCP start rather
    // than staying stranded on whatever text they were installed with.
    claudeHome('.claude');
    const { installSkills, skillsNeedRefresh, bundledSkillNames } = await mods();
    installSkills();
    expect(skillsNeedRefresh()).toBe(false);

    const marker = join(home, '.claude', 'skills', bundledSkillNames()[0], '.chat-recall-managed');
    writeFileSync(marker, '0.5.0\n'); // the pre-fix format
    expect(skillsNeedRefresh()).toBe(true);
  });

  test('uninstall reaches every profile', async () => {
    claudeHome('.claude');
    claudeHome('.claude-work');
    const { installSkills, uninstallSkills, bundledSkillNames } = await mods();
    installSkills();

    const res = uninstallSkills();
    const work = res.perTarget.find((t) => t.id === 'claude:.claude-work')!;
    expect(work.removed.sort()).toEqual(bundledSkillNames().sort());
    for (const n of bundledSkillNames()) {
      expect(existsSync(join(home, '.claude-work', 'skills', n))).toBe(false);
    }
  });
});
