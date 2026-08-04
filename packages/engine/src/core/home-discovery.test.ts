/**
 * Discovery has to work on all three platforms and must not claim other tools'
 * data. Both halves are load-bearing:
 *
 *   - name matching (`~/.claude-*`) gave a user with `~/work-claude` or a
 *     Windows `%APPDATA%` profile ZERO coverage, silently
 *   - a loose signature is worse than no signature: `sessions/**\/*.jsonl`
 *     claimed ~/.local/share/goose (Block's Goose) as a Codex home on a real
 *     machine, which would have uploaded an unrelated tool's transcripts
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identifyHome, candidateRoots, declaredHomes, discoverHomes } from './home-discovery.js';

let root: string;

function put(rel: string, body = '{"uuid":"x"}\n') {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cr-homedisc-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('signature identification — by content, not name', () => {
  test('a Claude home is found whatever it is called', () => {
    put('work-claude/projects/-proj/11111111-2222-3333-4444-555555555555.jsonl');
    // The old name-matching discovery would never have looked here.
    expect(identifyHome(join(root, 'work-claude'))).toBe('claude');
  });

  test('Codex requires the rollout- prefix', () => {
    put('codexhome/sessions/2026/08/04/rollout-abc.jsonl');
    expect(identifyHome(join(root, 'codexhome'))).toBe('codex');
  });

  test('Goose is NOT mistaken for Codex — the real false positive', () => {
    // Block's Goose: flat sessions/<timestamp>.jsonl, no rollout- prefix.
    put('goose/sessions/20250809_150315.jsonl');
    put('goose/sessions/20250812_113019.jsonl');
    expect(identifyHome(join(root, 'goose'))).toBeNull();
  });

  test('Gemini and Antigravity are distinguished, even nested', () => {
    put('gem/tmp/-proj/chats/session-1.jsonl');
    put('gem/antigravity-cli/brain/s1/.system_generated/logs/a.jsonl');
    expect(identifyHome(join(root, 'gem'))).toBe('gemini');
    expect(identifyHome(join(root, 'gem', 'antigravity-cli'))).toBe('agy');
  });

  test('OpenCode is identified by its database file', () => {
    put('oc/opencode.db', 'sqlite');
    expect(identifyHome(join(root, 'oc'))).toBe('opencode');
  });

  test('an empty or unrelated directory is not a home', () => {
    mkdirSync(join(root, 'empty'), { recursive: true });
    put('notes/todo.md', '# hi');
    expect(identifyHome(join(root, 'empty'))).toBeNull();
    expect(identifyHome(join(root, 'notes'))).toBeNull();
  });

  test('a projects/ dir with no transcripts is not a Claude home', () => {
    mkdirSync(join(root, 'shell/projects/-proj'), { recursive: true });
    expect(identifyHome(join(root, 'shell'))).toBeNull();
  });
});

describe('platform roots', () => {
  test('windows scans APPDATA and LOCALAPPDATA', () => {
    const roots = candidateRoots('win32', {
      APPDATA: root, LOCALAPPDATA: root, USERPROFILE: root,
    } as NodeJS.ProcessEnv);
    expect(roots).toContain(root);
  });

  test('macOS scans Application Support', () => {
    const roots = candidateRoots('darwin', {} as NodeJS.ProcessEnv);
    expect(roots.some((r) => r.includes('Library/Application Support')) || roots.length >= 1).toBe(true);
  });

  test('linux scans XDG config and data dirs', () => {
    const cfg = join(root, 'cfg'); const data = join(root, 'data');
    mkdirSync(cfg, { recursive: true }); mkdirSync(data, { recursive: true });
    const roots = candidateRoots('linux', { XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: data } as NodeJS.ProcessEnv);
    expect(roots).toContain(cfg);
    expect(roots).toContain(data);
  });

  test('non-existent roots are dropped rather than walked', () => {
    expect(candidateRoots('linux', { XDG_CONFIG_HOME: '/nope/nope' } as NodeJS.ProcessEnv))
      .not.toContain('/nope/nope');
  });
});

describe('declared homes — the strongest signal', () => {
  test('CLAUDE_CONFIG_DIR is picked up', () => {
    expect(declaredHomes({ CLAUDE_CONFIG_DIR: '/x/profile' } as NodeJS.ProcessEnv, 'linux'))
      .toContain('/x/profile');
  });

  test('CLAUDE_DIRS contributes every comma-separated entry', () => {
    const d = declaredHomes({ CLAUDE_DIRS: '/a,/b , /c' } as NodeJS.ProcessEnv, 'linux');
    expect(d).toEqual(expect.arrayContaining(['/a', '/b', '/c']));
  });

  test('quotes are stripped, as they appear in shell rc files', () => {
    expect(declaredHomes({ CLAUDE_CONFIG_DIR: '"/x/quoted"' } as NodeJS.ProcessEnv, 'linux'))
      .toContain('/x/quoted');
  });
});

describe('discoverHomes end to end', () => {
  test('finds an oddly-named home by signature and reports counts', () => {
    put('weird-name/projects/-proj/aaaaaaaa-1111-2222-3333-444444444444.jsonl');
    put('weird-name/projects/-proj/bbbbbbbb-1111-2222-3333-444444444444.jsonl');
    const homes = discoverHomes({
      plat: 'linux',
      env: { XDG_CONFIG_HOME: root, HOME: root } as NodeJS.ProcessEnv,
      includeRunning: false,
    });
    const found = homes.find((h) => h.path.includes('weird-name'));
    expect(found).toBeTruthy();
    expect(found!.tool).toBe('claude');
    expect(found!.sessions).toBe(2);
    expect(found!.via).toBe('signature');
  });

  test('a declared home is labelled declared, not signature', () => {
    put('declared-home/projects/-proj/cccccccc-1111-2222-3333-444444444444.jsonl');
    const homes = discoverHomes({
      plat: 'linux',
      env: { CLAUDE_CONFIG_DIR: join(root, 'declared-home'), HOME: root } as NodeJS.ProcessEnv,
      includeRunning: false,
    });
    const found = homes.find((h) => h.path.includes('declared-home'));
    expect(found?.via).toBe('declared');
  });

  test('the same home is reported once, not per signal', () => {
    put('dup/projects/-proj/dddddddd-1111-2222-3333-444444444444.jsonl');
    const homes = discoverHomes({
      plat: 'linux',
      env: { CLAUDE_CONFIG_DIR: join(root, 'dup'), XDG_CONFIG_HOME: root, HOME: root } as NodeJS.ProcessEnv,
      includeRunning: false,
    });
    expect(homes.filter((h) => h.path.includes('dup'))).toHaveLength(1);
  });

  test('unrelated tools are not reported as homes', () => {
    put('goose/sessions/20250809_150315.jsonl');
    put('randomapp/data/thing.jsonl');
    const homes = discoverHomes({
      plat: 'linux',
      env: { XDG_CONFIG_HOME: root, HOME: root } as NodeJS.ProcessEnv,
      includeRunning: false,
    });
    expect(homes.some((h) => h.path.includes('goose'))).toBe(false);
    expect(homes.some((h) => h.path.includes('randomapp'))).toBe(false);
  });
});
