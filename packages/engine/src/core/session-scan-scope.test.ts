/**
 * The session-file lookups are the collector's hottest filesystem path, and the
 * cache that makes them cheap is only safe because its window is explicit.
 * These tests pin both halves: it must be FAST inside a scope and FRESH outside
 * one.
 *
 * The numbers that motivated this: locating a session probed every project
 * directory in every profile home, per session, and the sync walk asks twice
 * per session. On a 15,724-session corpus that was ~6.6M syscalls and 62.8
 * seconds of pure filesystem work, to discover that 2 sessions had changed.
 * Listing the directories once instead brought it to 196 ms. The Gemini backend
 * was worse still: on a basename miss it opened and PARSED every chat file in
 * every project, 30.4 s of the total.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSessionFile, findSessionFiles, findGeminiSessionFile,
  withSessionScanScope, invalidateSessionFileIndex, invalidateGeminiSessionIndex,
} from './live-session-scan.js';

let home: string;
let alt: string;
let gem: string;
const saved: Record<string, string | undefined> = {};

function writeSession(root: string, project: string, id: string, body = '{"type":"user"}\n'): string {
  const dir = join(root, 'projects', project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, body);
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cr-scan-home-'));
  alt = mkdtempSync(join(tmpdir(), 'cr-scan-alt-'));
  gem = mkdtempSync(join(tmpdir(), 'cr-scan-gem-'));
  for (const k of ['CHAT_RECALL_CLAUDE_HOME', 'CLAUDE_DIRS', 'CHAT_RECALL_GEMINI_HOME']) saved[k] = process.env[k];
  process.env.CHAT_RECALL_CLAUDE_HOME = home;
  process.env.CLAUDE_DIRS = `${home},${alt}`;
  process.env.CHAT_RECALL_GEMINI_HOME = gem;
  invalidateSessionFileIndex();
  invalidateGeminiSessionIndex();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  invalidateSessionFileIndex();
  invalidateGeminiSessionIndex();
  for (const d of [home, alt, gem]) rmSync(d, { recursive: true, force: true });
});

describe('claude session lookup', () => {
  test('finds a session, and reports its project path', () => {
    writeSession(home, '-home-user-proj', 'aaaaaaaa-1111-2222-3333-444444444444');
    const hit = findSessionFile('aaaaaaaa-1111-2222-3333-444444444444');
    expect(hit?.projectDir).toBe('-home-user-proj');
    expect(hit?.projectPath).toBe('/home/user/proj');
  });

  test('a missing session is null, not a throw', () => {
    expect(findSessionFile('nope-nope-nope')).toBeNull();
    expect(findSessionFiles('nope-nope-nope')).toEqual([]);
  });

  // findSessionFile is documented as "the first of findSessionFiles", and
  // project grouping and titles depend on that being the primary home's copy.
  // The multi-home UNION itself is owned by cross-home-union.test.ts, which
  // also sets up the directory approval this lookup honours.
  test('findSessionFile is the first entry of findSessionFiles', () => {
    const id = 'bbbbbbbb-1111-2222-3333-444444444444';
    const primary = writeSession(home, '-home-user-proj', id);
    expect(findSessionFiles(id)[0].path).toBe(primary);
    expect(findSessionFile(id)?.path).toBe(primary);
  });

  test('the returned array is a copy — a caller sorting it cannot corrupt the index', () => {
    const id = 'cccccccc-1111-2222-3333-444444444444';
    writeSession(home, '-home-user-proj', id);
    const first = findSessionFiles(id);
    first.length = 0;                        // caller mutates its own array
    expect(findSessionFiles(id)).toHaveLength(1);
  });
});

describe('scan scope', () => {
  // FRESHNESS is the default. Outside a scope every lookup reads the disk, so a
  // session created a moment ago is findable — which is what every interactive
  // caller (resume guard, MCP tool, CLI command) needs.
  test('outside a scope, a newly created session is found immediately', () => {
    const id = 'dddddddd-1111-2222-3333-444444444444';
    expect(findSessionFile(id)).toBeNull();
    writeSession(home, '-home-user-proj', id);
    expect(findSessionFile(id)).not.toBeNull();
  });

  // SPEED inside. Proving the cache is live without timing anything: a file
  // created mid-scope is deliberately NOT visible, because the scope promises
  // the answer cannot change while it is open.
  test('inside a scope the listing is reused, and it is dropped on exit', async () => {
    const id = 'eeeeeeee-1111-2222-3333-444444444444';
    await withSessionScanScope(async () => {
      expect(findSessionFile(id)).toBeNull();     // builds the index
      writeSession(home, '-home-user-proj', id);  // appears on disk, not in the index
      expect(findSessionFile(id)).toBeNull();     // served from the index
    });
    expect(findSessionFile(id)).not.toBeNull();   // scope closed → fresh again
  });

  test('nesting does not drop the outer scope\'s index early', async () => {
    const id = 'ffffffff-1111-2222-3333-444444444444';
    await withSessionScanScope(async () => {
      expect(findSessionFile(id)).toBeNull();
      await withSessionScanScope(async () => { writeSession(home, '-home-user-proj', id); });
      expect(findSessionFile(id)).toBeNull();     // outer index survived the inner exit
    });
    expect(findSessionFile(id)).not.toBeNull();
  });

  test('a throw inside the scope still releases it', async () => {
    await expect(withSessionScanScope(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const id = '99999999-1111-2222-3333-444444444444';
    writeSession(home, '-home-user-proj', id);
    expect(findSessionFile(id)).not.toBeNull();   // not stuck in a stale scope
  });
});

describe('gemini session lookup', () => {
  const writeChat = (project: string, base: string, sessionId: string): string => {
    const dir = join(gem, 'tmp', project, 'chats');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${base}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ sessionId })}\n`);
    return path;
  };

  test('resolves by exact basename', () => {
    const p = writeChat('projA', 'session-2026-05-06T06-37-de4e8d4c', 'inner-id-1');
    expect(findGeminiSessionFile('session-2026-05-06T06-37-de4e8d4c')?.path).toBe(p);
  });

  // The CLI tacks a short hex tail onto the basename and callers pass an id
  // that STARTS WITH that tail.
  test('resolves by the basename tail', () => {
    const p = writeChat('projA', 'session-2026-05-06T06-37-de4e8d4c', 'inner-id-2');
    expect(findGeminiSessionFile('de4e8d4c-extra-suffix')?.path).toBe(p);
  });

  // The expensive path: the id lives INSIDE the file. It must still resolve —
  // it just may not re-read every file on every lookup any more.
  test('falls back to the id stored inside the file', () => {
    writeChat('projA', 'session-aaaa-11111111', 'not-the-one');
    const p = writeChat('projB', 'session-bbbb-22222222', 'the-inner-one');
    expect(findGeminiSessionFile('the-inner-one')?.path).toBe(p);
  });

  test('an unknown id is null', () => {
    writeChat('projA', 'session-aaaa-11111111', 'inner');
    expect(findGeminiSessionFile('totally-unknown')).toBeNull();
  });
});
