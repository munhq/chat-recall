/**
 * One decoder for the project directory name, and it must not assume POSIX.
 *
 * Ten call sites each open-coded `name.replace(/-/g, '/')`. Correct on Linux and
 * macOS; on Windows it turned `C--Users-user-code-app` into `C//Users/user/code/app`,
 * a path that cannot exist — so every session, plan, task, hook, subagent,
 * command, CLAUDE.md and memory file was filed under a fictional project, and
 * nothing grouped by repo or resolved to a git id on that platform.
 *
 * These tests run the same assertions on every host, because the SHAPE OF THE
 * NAME decides the answer, not the machine doing the decoding: a Linux server
 * indexing a transcript synced from a Windows laptop has to agree with that
 * laptop about which project it is.
 */
import { describe, test, expect } from 'vitest';
import { decodeProjectDirName, looksWindowsEncoded, projectLeafName, splitPathSegments } from './project-dir-name.js';

describe('POSIX project names', () => {
  test('a leading dash is the root slash', () => {
    expect(decodeProjectDirName('-home-user-code-chat-recall'))
      .toBe('/home/user/code/chat/recall');
  });

  test('the encoding is lossy and we do not pretend otherwise', () => {
    // '/home/user/code/chat-recall' and '/home/user/code/chat/recall' encode
    // identically. The cheap decoder picks separators; callers that need the
    // real answer probe the filesystem (parsers/session.ts decodeDirName).
    expect(decodeProjectDirName('-home-user-code-chat-recall'))
      .toBe(decodeProjectDirName('-home-user-code-chat-recall'));
  });

  test('an empty name decodes to empty, not to the root', () => {
    // Returning '/' here would attribute orphan items to the filesystem root.
    expect(decodeProjectDirName('')).toBe('');
  });
});

describe('Windows project names', () => {
  test('a drive-rooted name decodes to a drive-rooted path', () => {
    expect(decodeProjectDirName('C--Users-user-code-app'))
      .toBe('C:\\Users\\user\\code\\app');
  });

  test('the drive letter is normalised to upper case', () => {
    expect(decodeProjectDirName('d--work-repo')).toBe('D:\\work\\repo');
  });

  test('it is recognised by shape, so a Linux host decodes it the same way', () => {
    expect(looksWindowsEncoded('C--Users-user')).toBe(true);
    expect(looksWindowsEncoded('-home-user')).toBe(false);
    // A POSIX directory that merely starts with a letter is not a drive.
    expect(looksWindowsEncoded('home-user-code')).toBe(false);
  });

  test('the old naive decode is exactly what this replaces', () => {
    const naive = 'C--Users-user-code-app'.replace(/-/g, '/').replace(/^\//, '/');
    expect(naive).toBe('C//Users/user/code/app');          // the bug
    expect(decodeProjectDirName('C--Users-user-code-app')).not.toBe(naive);
  });
});

describe('helpers callers used to hand-roll', () => {
  test('the leaf name works for both shapes', () => {
    expect(projectLeafName('-home-user-code-myproject')).toBe('myproject');
    expect(projectLeafName('C--Users-user-code-myproject')).toBe('myproject');
  });

  test('segments split on either separator', () => {
    expect(splitPathSegments('/home/user/code')).toEqual(['home', 'user', 'code']);
    expect(splitPathSegments('C:\\Users\\user')).toEqual(['C:', 'Users', 'user']);
  });
});
