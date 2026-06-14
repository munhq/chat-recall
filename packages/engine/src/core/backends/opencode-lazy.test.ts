/**
 * Laziness guard for the OpenCode backend's optional better-sqlite3 dependency.
 *
 * The thin collector ships WITHOUT better-sqlite3 (it's an optionalDependency,
 * needed only to read OpenCode's own SQLite session DB). Importing the backend
 * — which happens transitively via `backends/index.js` at collector boot — must
 * therefore NOT eagerly load the native module, and must NOT open any DB as an
 * import side-effect. These tests pin that contract.
 *
 * Note: better-sqlite3 IS installed in this test environment, so we cannot
 * simulate its absence here without mangling the module loader. Instead we
 * assert the two things that actually matter for boot safety:
 *   1) importing the module never throws and has no DB-opening side effect, and
 *   2) the lazy path still works (reads real fixtures) when the module IS present
 *      — proving lazy loading didn't change behavior for the installed case.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `chat-recall-${prefix}-`));
}

describe('OpenCode backend lazy better-sqlite3', () => {
  let home: string | undefined;
  let saved: string | undefined;

  afterEach(() => {
    if (saved === undefined) delete process.env.CHAT_RECALL_OPENCODE_DB;
    else process.env.CHAT_RECALL_OPENCODE_DB = saved;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  it('importing the backend module does not throw and opens no DB', async () => {
    // Point the backend at a path that does NOT exist. If the module opened a
    // DB at import/construction time, this would throw or error; instead the
    // import must complete cleanly and isAvailable() must simply report false.
    saved = process.env.CHAT_RECALL_OPENCODE_DB;
    process.env.CHAT_RECALL_OPENCODE_DB = join(tmpdir(), 'definitely-not-a-real.db');

    const mod = await import('./opencode.js');
    expect(mod.opencodeBackend).toBeDefined();
    // No DB exists → unavailable, no crash, sources read nothing.
    expect(mod.opencodeBackend.isAvailable()).toBe(false);
    expect(mod.opencodeBackend.listSessions()).toEqual([]);
    expect(mod.opencodeBackend.readEvents('opencode_nope')).toEqual([]);
  });

  it('lazily loads better-sqlite3 and reads a real DB when present', async () => {
    // Build a minimal OpenCode-shaped DB so the lazy require() path is actually
    // exercised end-to-end — proving deferred loading preserves behavior when
    // the optional dependency IS installed.
    home = tmp('opencode-lazy');
    const dbPath = join(home, 'opencode.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, name TEXT);
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT,
        directory TEXT, time_created INTEGER, time_updated INTEGER,
        time_archived INTEGER,
        summary_files INTEGER, summary_additions INTEGER, summary_deletions INTEGER,
        summary_diffs TEXT
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
        time_created INTEGER, data TEXT
      );
    `);
    db.prepare(`INSERT INTO project VALUES (?,?,?)`).run('p1', '/work/proj', 'proj');
    db.prepare(`INSERT INTO session (id,project_id,title,directory,time_created,time_updated) VALUES (?,?,?,?,?,?)`)
      .run('s1', 'p1', 'A session', '/work/proj', 1000, 2000);
    db.prepare(`INSERT INTO message VALUES (?,?,?)`).run('m1', 's1', JSON.stringify({ role: 'user' }));
    db.prepare(`INSERT INTO part VALUES (?,?,?,?,?)`)
      .run('pt1', 'm1', 's1', 1500, JSON.stringify({ type: 'text', text: 'hello world' }));
    db.close();

    saved = process.env.CHAT_RECALL_OPENCODE_DB;
    process.env.CHAT_RECALL_OPENCODE_DB = dbPath;

    const { OpencodeBackend } = await import('./opencode.js');
    const backend = new OpencodeBackend();
    expect(backend.isAvailable()).toBe(true);

    const sessions = backend.listSessions();
    expect(sessions.map(s => s.rawId)).toContain('s1');

    const events = backend.readEvents('opencode_s1');
    expect(events.some(e => e.kind === 'user' && e.text === 'hello world')).toBe(true);
  });
});
