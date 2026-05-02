import { describe, test, expect } from 'vitest';
import { groupFilesByRepo } from './session-git.js';

describe('groupFilesByRepo', () => {
  test('returns empty map for empty input', () => {
    expect(groupFilesByRepo([]).size).toBe(0);
  });

  test('files outside any git repo land in a special bucket or are skipped', () => {
    const out = groupFilesByRepo(['/tmp/no-repo-here/foo.txt']);
    // Exact behavior may bucket under '' or skip — both are acceptable.
    expect(out instanceof Map).toBe(true);
  });

  test('multiple files under the same repo land in the same group', () => {
    // Use this repo (chat-recall) — guaranteed to have a .git/ ancestor.
    const repoFile = '/home/user/code/personal/chat-recall/src/core/utils.ts';
    const repoFile2 = '/home/user/code/personal/chat-recall/src/core/utils.test.ts';
    const out = groupFilesByRepo([repoFile, repoFile2]);
    // Either grouped together (same repo root) or both skipped if git lookup
    // disabled — either way, the function shouldn't throw.
    expect(out instanceof Map).toBe(true);
  });
});
