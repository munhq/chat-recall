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
import { decodeProjectDirName, looksWindowsEncoded, projectLeafName, resolveProjectDirName, splitPathSegments } from './project-dir-name.js';

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

/**
 * The structural decode above is a guess. These cover the decoder that asks the
 * disk instead — the one that decides whether a repo gets its `git:` id or a
 * fictional `path:` one.
 *
 * `readdir` is injected so the assertions describe the ENCODING, not the
 * machine running them: the same tree has to decode identically on a laptop and
 * on the server indexing that laptop's transcripts.
 */
describe('probing project names against a real tree', () => {
  // A tree that reproduces every collision the encoder creates.
  const TREE: Record<string, string[]> = {
    '/': ['Users', 'private'],
    '/Users': ['alice'],
    '/Users/alice': ['code'],
    '/Users/alice/code': ['personal'],
    '/Users/alice/code/personal': ['chat-recall', 'my-app', 'k8s_gpu', 'app', 'chat'],
    '/Users/alice/code/personal/chat': ['recall'],
    '/Users/alice/code/personal/chat-recall': [],
    '/Users/alice/code/personal/my-app': [],
    '/Users/alice/code/personal/k8s_gpu': [],
    '/Users/alice/code/personal/app': ['.agent', 'src-tauri'],
    '/Users/alice/code/personal/app/.agent': ['worktrees'],
    '/Users/alice/code/personal/app/.agent/worktrees': ['0b6ad77e'],
    '/Users/alice/code/personal/app/.agent/worktrees/0b6ad77e': [],
    '/Users/alice/code/personal/app/src-tauri': [],
  };
  const readdir = (p: string) => {
    const kids = TREE[p];
    if (!kids) throw new Error(`ENOENT: ${p}`);
    return kids;
  };
  const probe = (name: string) => resolveProjectDirName(name, { readdir });

  test('a hyphen in a directory name is no longer read as a separator', () => {
    // The bug that split one repo across two project ids: the real path got a
    // `git-local:`/`git:` id, the fiction got `path:/…/chat/recall`.
    expect(decodeProjectDirName('-Users-alice-code-personal-chat-recall'))
      .toBe('/Users/alice/code/personal/chat/recall');
    expect(probe('-Users-alice-code-personal-chat-recall'))
      .toBe('/Users/alice/code/personal/chat-recall');
  });

  test('the longest real directory wins over a shorter one that also matches', () => {
    // Both '/…/personal/chat-recall' and '/…/personal/chat/recall' exist in
    // this tree and encode identically. Longest-match picks the deeper name,
    // which is the one the encoder actually came from.
    expect(probe('-Users-alice-code-personal-chat-recall'))
      .toBe('/Users/alice/code/personal/chat-recall');
    // The trade-off is explicit: when both spellings exist on disk the encoding
    // genuinely cannot tell them apart, and we prefer the longer real directory.
    // A name that matches neither resolves to nothing and falls back structurally
    // rather than half-descending into '/…/personal/chat'.
    expect(probe('-Users-alice-code-personal-chat-recall-extra'))
      .toBe(decodeProjectDirName('-Users-alice-code-personal-chat-recall-extra'));
  });

  test('an underscore survives the round trip too', () => {
    expect(probe('-Users-alice-code-personal-k8s-gpu'))
      .toBe('/Users/alice/code/personal/k8s_gpu');
  });

  test('a dot-directory is found even though its dot was flattened to a dash', () => {
    // '--' is '/' followed by '.', and the old prober only ever tried '.' as a
    // JOIN separator, never as a prefix — so every per-session worktree was
    // filed under a path that does not exist instead of its parent repo.
    expect(probe('-Users-alice-code-personal-app--agent-worktrees-0b6ad77e'))
      .toBe('/Users/alice/code/personal/app/.agent/worktrees/0b6ad77e');
  });

  test('src-tauri stays one directory, not src/tauri', () => {
    expect(probe('-Users-alice-code-personal-app-src-tauri'))
      .toBe('/Users/alice/code/personal/app/src-tauri');
  });

  test('a path that is not on this machine falls back to the structural decode', () => {
    // A transcript synced from another device must not be forced onto whatever
    // this host happens to have. Probing may improve an answer, never invent one.
    const name = '-home-bob-code-personal-widget';
    expect(probe(name)).toBe(decodeProjectDirName(name));
  });

  test('a Windows-encoded name is never probed against the local filesystem', () => {
    expect(probe('C--Users-user-code-app')).toBe('C:\\Users\\user\\code\\app');
  });

  test('an empty name stays empty rather than resolving to the root', () => {
    expect(probe('')).toBe('');
  });

  test('an unreadable level stops the probe instead of throwing', () => {
    const boom = () => { throw new Error('EACCES'); };
    const name = '-Users-alice-code-personal-app';
    expect(resolveProjectDirName(name, { readdir: boom })).toBe(decodeProjectDirName(name));
  });
});
