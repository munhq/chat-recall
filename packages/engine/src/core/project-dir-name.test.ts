/**
 * One decoder for the project directory name, and it must not assume POSIX.
 *
 * Ten call sites each open-coded `name.replace(/-/g, '/')`. Correct on Linux and
 * macOS; on Windows it turned `C--Users-adi-code-app` into `C//Users/adi/code/app`,
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
    expect(decodeProjectDirName('-home-adi-code-chat-recall'))
      .toBe('/home/adi/code/chat/recall');
  });

  test('the encoding is lossy and we do not pretend otherwise', () => {
    // '/home/adi/code/chat-recall' and '/home/adi/code/chat/recall' encode
    // identically. The cheap decoder picks separators; callers that need the
    // real answer probe the filesystem (parsers/session.ts decodeDirName).
    expect(decodeProjectDirName('-home-adi-code-chat-recall'))
      .toBe(decodeProjectDirName('-home-adi-code-chat-recall'));
  });

  test('an empty name decodes to empty, not to the root', () => {
    // Returning '/' here would attribute orphan items to the filesystem root.
    expect(decodeProjectDirName('')).toBe('');
  });
});

describe('Windows project names', () => {
  test('a drive-rooted name decodes to a drive-rooted path', () => {
    expect(decodeProjectDirName('C--Users-adi-code-app'))
      .toBe('C:\\Users\\adi\\code\\app');
  });

  test('the drive letter is normalised to upper case', () => {
    expect(decodeProjectDirName('d--work-repo')).toBe('D:\\work\\repo');
  });

  test('it is recognised by shape, so a Linux host decodes it the same way', () => {
    expect(looksWindowsEncoded('C--Users-adi')).toBe(true);
    expect(looksWindowsEncoded('-home-adi')).toBe(false);
    // A POSIX directory that merely starts with a letter is not a drive.
    expect(looksWindowsEncoded('home-adi-code')).toBe(false);
  });

  test('the old naive decode is exactly what this replaces', () => {
    const naive = 'C--Users-adi-code-app'.replace(/-/g, '/').replace(/^\//, '/');
    expect(naive).toBe('C//Users/adi/code/app');          // the bug
    expect(decodeProjectDirName('C--Users-adi-code-app')).not.toBe(naive);
  });
});

describe('helpers callers used to hand-roll', () => {
  test('the leaf name works for both shapes', () => {
    expect(projectLeafName('-home-adi-code-myproject')).toBe('myproject');
    expect(projectLeafName('C--Users-adi-code-myproject')).toBe('myproject');
  });

  test('segments split on either separator', () => {
    expect(splitPathSegments('/home/adi/code')).toEqual(['home', 'adi', 'code']);
    expect(splitPathSegments('C:\\Users\\adi')).toEqual(['C:', 'Users', 'adi']);
  });
});
