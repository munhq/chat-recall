/**
 * A `git-local:` project is a sha1 of its path and carries no name, so the
 * board showed "local 9c548119504c" for a real repo — a label nobody can read
 * or search for. The name is recoverable: it is the basename of the path the
 * store already keeps per project.
 *
 * Pinned because the two endpoints derive it independently and drifting apart
 * is how the list and the tree come to call one project two things.
 */
import { describe, test, expect } from 'vitest';
import { __testing } from './projects.js';

const { parseProjectId } = __testing;

describe('git-local projects are named, not hashed', () => {
  test('uses the basename of the representative path', () => {
    const r = parseProjectId('git-local:9c548119504c', '/Users/alice/code/personal/coolcode');
    expect(r.source).toBe('git-local');
    expect(r.displayName).toBe('coolcode');
  });

  test('reads a Windows path too — sessions are indexed on both', () => {
    expect(parseProjectId('git-local:abc123', 'C:\\Users\\alice\\code\\example-app').displayName)
      .toBe('example-app');
  });

  test('falls back to the hash when no path is known', () => {
    // A project with no items yet has no representative path, and an honest
    // hash beats an invented name.
    expect(parseProjectId('git-local:9c548119504c').displayName).toBe('local 9c548119504c');
    expect(parseProjectId('git-local:9c548119504c', '').displayName).toBe('local 9c548119504c');
  });

  test('a trailing separator does not produce an empty name', () => {
    expect(parseProjectId('git-local:abc123', '/home/user/code/example/').displayName)
      .toBe('example');
  });

  test('every other id shape is unchanged', () => {
    expect(parseProjectId('git:github.com/owner/repo', '/anything')).toEqual(
      { source: 'git-remote', displayName: 'repo' });
    expect(parseProjectId('ws:mono', '/anything')).toEqual(
      { source: 'auto-workspace', displayName: 'mono' });
    expect(parseProjectId('path:/home/user/code/example', '').displayName).toBe('example');
    expect(parseProjectId('user:custom', '').source).toBe('user');
  });
});
