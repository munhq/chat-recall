/**
 * The regression this file exists for, in one sentence: `chat-recall exclude
 * project ~/code/chat-recall` did not exclude ~/code/chat-recall.
 *
 * The gate compared the rule against the path decoded from Claude Code's
 * directory name (`-home-user-code-chat-recall` → `/home/user/code/chat/recall`,
 * because the encoding cannot tell a real hyphen from a separator), so the
 * substring test was false and the project kept syncing. Found by driving the
 * real CLI against a real server (scripts/exclusion-e2e.mjs), not by any unit
 * test — every unit test asserted the pure predicate against paths it had
 * written itself in the same form.
 *
 * Every case below pins a direction, not an implementation: what must match, and
 * what must NOT start matching now that the comparison is looser.
 */
import { describe, test, expect } from 'vitest';
import { canonicalProjectPath, projectPathIncludes, projectPathAtOrUnder } from './project-path-match.js';

describe('canonicalProjectPath', () => {
  test('collapses hyphen, underscore and separator to one form', () => {
    expect(canonicalProjectPath('/home/user/code/chat-recall'))
      .toBe(canonicalProjectPath('/home/user/code/chat/recall'));
    expect(canonicalProjectPath('/home/user/code/k8s_gpu'))
      .toBe(canonicalProjectPath('/home/user/code/k8s/gpu'));
  });

  test('a decoded Windows path compares equal to the typed one', () => {
    expect(canonicalProjectPath('C:\\Users\\user\\code\\app'))
      .toBe(canonicalProjectPath('c:/users/user/code/app'));
  });

  test('trailing separators and doubled separators do not change identity', () => {
    expect(canonicalProjectPath('/a/b/')).toBe(canonicalProjectPath('/a//b'));
  });

  test('empty in, empty out — never throws on a missing path', () => {
    expect(canonicalProjectPath('')).toBe('');
    expect(canonicalProjectPath(undefined as unknown as string)).toBe('');
  });
});

describe('projectPathIncludes — the exclude/sync-only relation', () => {
  test('THE BUG: a hyphenated rule matches the structurally decoded path', () => {
    expect(projectPathIncludes('/home/user/code/chat/recall', '/home/user/code/chat-recall')).toBe(true);
  });

  test('and the reverse, because either side may be the decoded one', () => {
    expect(projectPathIncludes('/home/user/code/chat-recall', '/home/user/code/chat/recall')).toBe(true);
  });

  test('an exact path still matches, unchanged', () => {
    expect(projectPathIncludes('/home/user/code/app', '/home/user/code/app')).toBe(true);
  });

  test('a parent path still matches its children (documented substring rule)', () => {
    expect(projectPathIncludes('/home/user/work/client/api', '/home/user/work')).toBe(true);
  });

  test('an unrelated project does NOT start matching', () => {
    expect(projectPathIncludes('/home/user/code/other', '/home/user/code/chat-recall')).toBe(false);
    expect(projectPathIncludes('/home/user/personal/notes', '/home/user/work')).toBe(false);
  });

  test('an empty rule or path matches nothing — never everything', () => {
    expect(projectPathIncludes('/home/user/code/app', '')).toBe(false);
    expect(projectPathIncludes('', '/home/user/code/app')).toBe(false);
  });
});

describe('projectPathAtOrUnder — the denylist relation', () => {
  test('THE BUG, in its stricter form', () => {
    expect(projectPathAtOrUnder('/home/user/code/chat/recall', '/home/user/code/chat-recall')).toBe(true);
  });

  test('the path itself and anything beneath it', () => {
    expect(projectPathAtOrUnder('/home/me/secret', '/home/me/secret')).toBe(true);
    expect(projectPathAtOrUnder('/home/me/secret/sub', '/home/me/secret')).toBe(true);
  });

  test('a SIBLING whose name merely starts the same is not under it', () => {
    // The reason this relation exists instead of a substring test: `/code/app`
    // must not swallow `/code/app-secrets`… but note that after collapsing,
    // app-secrets reads as app/secrets, which IS under app. That is the
    // deliberate over-match — a privacy rule may withhold more, never less.
    expect(projectPathAtOrUnder('/home/me/apples', '/home/me/app')).toBe(false);
  });

  test('an unrelated tree is untouched', () => {
    expect(projectPathAtOrUnder('/home/me/public', '/home/me/secret')).toBe(false);
  });
});
