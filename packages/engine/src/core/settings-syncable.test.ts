/**
 * Opt-in selective-sync predicate (pure). Proves 'all' ships everything and
 * 'only' ships strictly the allowlisted projects (by id or path substring).
 */
import { describe, test, expect } from 'vitest';
import { isProjectSyncable } from './settings.js';

const GIT = 'git:github.com/org/repo';
const PATH = '/home/u/code/repo';

describe('isProjectSyncable', () => {
  test("'all' (and unset) ship everything", () => {
    const s = new Set<string>();
    expect(isProjectSyncable(GIT, PATH, { syncMode: 'all', syncOnly: s })).toBe(true);
    expect(isProjectSyncable(GIT, PATH, { syncOnly: s })).toBe(true); // unset → 'all'
    expect(isProjectSyncable('', '/anything', { syncMode: 'all', syncOnly: s })).toBe(true);
  });

  test("'only' ships a project whose id is allowlisted", () => {
    const s = new Set([GIT]);
    expect(isProjectSyncable(GIT, PATH, { syncMode: 'only', syncOnly: s })).toBe(true);
  });

  test("'only' blocks a project not in the allowlist", () => {
    const s = new Set(['git:github.com/org/other']);
    expect(isProjectSyncable(GIT, PATH, { syncMode: 'only', syncOnly: s })).toBe(false);
  });

  test("'only' also matches a path substring entry", () => {
    const s = new Set(['/home/u/code/repo']);
    expect(isProjectSyncable('', PATH, { syncMode: 'only', syncOnly: s })).toBe(true);
    expect(isProjectSyncable('', '/home/u/code/elsewhere', { syncMode: 'only', syncOnly: s })).toBe(false);
  });

  test("'only' with an empty allowlist ships nothing", () => {
    const s = new Set<string>();
    expect(isProjectSyncable(GIT, PATH, { syncMode: 'only', syncOnly: s })).toBe(false);
  });
});
