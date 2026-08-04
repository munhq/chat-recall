/**
 * A session is a SET OF RECORDS, not a file to choose between.
 *
 * Claude Code writes to whichever home `CLAUDE_CONFIG_DIR` points at, so one
 * session resumed under a second profile ends up as two files with the SAME id
 * in different homes, holding DISJOINT records. Measured on a real machine
 * (2026-08-02): `~/.claude` held 955 messages, `~/.claude-t2` held 20, zero
 * shared uuids.
 *
 * `findSessionFile` returns the first match and stops, and the primary home is
 * scanned first — so the live half was never read, indexed or synced, and the
 * session looked frozen for 24 hours. On Linux a cron job papered over this by
 * consolidating the files; macOS and Windows have no such job, so there the
 * records were simply lost. These tests pin the union so the fix does not
 * depend on a platform-specific script existing.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;
let prevHome: string | undefined;
let prevClaudeHome: string | undefined;
let prevClaudeDirs: string | undefined;
let prevDataDir: string | undefined;

const SID = '11111111-2222-3333-4444-555555555555';
const PROJ = '-home-user-code-demo';

/** One transcript record with a stable uuid. */
function rec(uuid: string, text: string): string {
  return JSON.stringify({
    uuid, type: 'user', timestamp: '2026-08-02T09:00:00.000Z',
    message: { role: 'user', content: text },
  });
}

function writeSession(claudeHome: string, lines: string[]): string {
  const dir = join(home, claudeHome, 'projects', PROJ);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${SID}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

/** The modules read env at call time; import fresh so nothing is cached. */
async function mods() {
  const scan = await import('./live-session-scan.js');
  const { claudeBackend } = await import('./backends/index.js');
  return { ...scan, claudeBackend };
}

beforeEach(() => {
  prevHome = process.env.HOME;
  prevClaudeHome = process.env.CHAT_RECALL_CLAUDE_HOME;
  prevClaudeDirs = process.env.CLAUDE_DIRS;
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  home = mkdtempSync(join(tmpdir(), 'cr-crosshome-'));
  process.env.HOME = home;
  // A home override disables sibling discovery, so it must be clear.
  delete process.env.CHAT_RECALL_CLAUDE_HOME;
  delete process.env.CLAUDE_DIRS;
  process.env.CHAT_RECALL_DATA_DIR = join(home, '.chat-recall');
});

afterEach(() => {
  for (const [k, v] of Object.entries({
    HOME: prevHome,
    CHAT_RECALL_CLAUDE_HOME: prevClaudeHome,
    CLAUDE_DIRS: prevClaudeDirs,
    CHAT_RECALL_DATA_DIR: prevDataDir,
  })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('a session split across two homes', () => {
  test('every copy is found, primary first', async () => {
    const { findSessionFiles } = await mods();
    const primary = writeSession('.claude', [rec('a', 'one'), rec('b', 'two')]);
    const secondary = writeSession('.claude-t2', [rec('x', 'three')]);

    const found = findSessionFiles(SID).map((f) => f.path);
    expect(found).toHaveLength(2);
    expect(found[0]).toBe(primary);           // canonical location is still first
    expect(found).toContain(secondary);
  });

  test('records are UNIONED, not chosen between — the regression', async () => {
    const { resolveSessionContentGroups, readSessionGroupText } = await mods();
    // Primary is LARGER and disjoint — exactly the shape that made first-match
    // and every size-based heuristic drop the live half.
    writeSession('.claude', [rec('a', 'one'), rec('b', 'two'), rec('c', 'three')]);
    writeSession('.claude-t2', [rec('x', 'live-one'), rec('y', 'live-two')]);

    const groups = resolveSessionContentGroups(SID);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('main');
    expect(groups[0].paths).toHaveLength(2);

    const { text } = readSessionGroupText(groups[0]);
    for (const u of ['a', 'b', 'c', 'x', 'y']) {
      expect(text, `record ${u} missing from the union`).toContain(`"uuid":"${u}"`);
    }
    expect(text.trim().split('\n')).toHaveLength(5);
  });

  test('duplicate records across homes are not double-counted', async () => {
    const { resolveSessionContentGroups, readSessionGroupText } = await mods();
    writeSession('.claude', [rec('a', 'one'), rec('b', 'two')]);
    writeSession('.claude-t2', [rec('b', 'two'), rec('c', 'three')]);  // 'b' overlaps

    const { text } = readSessionGroupText(resolveSessionContentGroups(SID)[0]);
    expect(text.trim().split('\n')).toHaveLength(3);
    expect(text.match(/"uuid":"b"/g)).toHaveLength(1);
  });

  test('readEvents replays the whole conversation, not one half', async () => {
    const { claudeBackend } = await mods();
    writeSession('.claude', [rec('a', 'one'), rec('b', 'two'), rec('c', 'three')]);
    writeSession('.claude-t2', [rec('x', 'live-one')]);

    const events = claudeBackend.readEvents(SID);
    // Before the fix this returned only the primary home's 3 records.
    expect(events.length).toBe(4);
  });

  test('a home appearing AFTER onboarding is pending, so it is not scanned yet', async () => {
    const { claudeBackend } = await mods();
    const { homeDecision } = await import('./home-approval.js');
    writeSession('.claude', [rec('a', 'one')]);
    const before = claudeBackend.fileSize(SID);           // primes the one-shot migration

    // A second profile created later needs a decision — silence must not mean
    // "we started uploading a work account".
    const secondary = writeSession('.claude-t2', [rec('x', 'live')]);
    expect(homeDecision(secondary.replace(/\/projects\/.*$/, ''))).toBe('pending');
    expect(claudeBackend.fileSize(SID)).toBe(before);      // not scanned while pending
  });

  test('once approved, fileSize counts it, so growth in a secondary is detected', async () => {
    const { claudeBackend } = await mods();
    const { approveHome } = await import('./home-approval.js');
    writeSession('.claude', [rec('a', 'one')]);
    const before = claudeBackend.fileSize(SID);

    const secondary = writeSession('.claude-t2', [rec('x', 'a much longer live record'.repeat(4))]);
    approveHome(secondary.replace(/\/projects\/.*$/, ''));

    // A frozen primary + growing secondary previously reported a constant size,
    // so append-only change detection never fired and the session never re-synced.
    expect(claudeBackend.fileSize(SID)).toBeGreaterThan(before);
  });

  test('findSession reports the NEWEST mtime across homes', async () => {
    const { claudeBackend } = await mods();
    const { utimesSync } = await import('node:fs');
    const primary = writeSession('.claude', [rec('a', 'one')]);
    const secondary = writeSession('.claude-t2', [rec('x', 'live')]);

    const old = new Date('2026-07-01T00:00:00Z');
    const fresh = new Date('2026-08-02T12:00:00Z');
    utimesSync(primary, old, old);
    utimesSync(secondary, fresh, fresh);

    const loc = claudeBackend.findSession(SID);
    expect(loc).toBeTruthy();
    expect(loc!.path).toBe(primary);                       // canonical path unchanged
    expect(loc!.mtime).toBe(fresh.getTime());              // freshness from the live half
  });

  test('the raw export ships the union, not the primary half', async () => {
    const { claudeBackend } = await mods();
    writeSession('.claude', [rec('a', 'one'), rec('b', 'two')]);
    writeSession('.claude-t2', [rec('x', 'live')]);

    const exported = claudeBackend.exportRawSession(SID);
    expect(exported).toBeTruthy();
    const main = exported!.files.find((f) => f.name.endsWith(`${SID}.jsonl`));
    expect(main).toBeTruthy();
    const text = main!.bytes.toString('utf-8');
    for (const u of ['a', 'b', 'x']) expect(text).toContain(`"uuid":"${u}"`);
  });
});

describe('the single-home case is unchanged', () => {
  test('one home behaves exactly as before', async () => {
    const { findSessionFiles, resolveSessionContentGroups, readSessionGroupText, claudeBackend } = await mods();
    writeSession('.claude', [rec('a', 'one'), rec('b', 'two')]);

    expect(findSessionFiles(SID)).toHaveLength(1);
    const groups = resolveSessionContentGroups(SID);
    expect(groups).toHaveLength(1);
    expect(groups[0].paths).toHaveLength(1);
    expect(readSessionGroupText(groups[0]).text.trim().split('\n')).toHaveLength(2);
    expect(claudeBackend.readEvents(SID).length).toBe(2);
  });

  test('an unknown session yields nothing rather than throwing', async () => {
    const { findSessionFiles, resolveSessionContentGroups, claudeBackend } = await mods();
    expect(findSessionFiles('does-not-exist')).toEqual([]);
    expect(resolveSessionContentGroups('does-not-exist')).toEqual([]);
    expect(claudeBackend.readEvents('does-not-exist')).toEqual([]);
    expect(claudeBackend.fileSize('does-not-exist')).toBe(0);
  });
});
