import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpencodeBackend, DEFAULT_DUMP_MAX_BYTES, dumpMaxBytes } from './opencode.js';

describe('dumpMaxBytes', () => {
  it('defaults to 64 MiB', () => {
    expect(dumpMaxBytes({})).toBe(DEFAULT_DUMP_MAX_BYTES);
    expect(DEFAULT_DUMP_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it('reads the override, and ignores a value that is not a positive number', () => {
    expect(dumpMaxBytes({ CHAT_RECALL_OPENCODE_DUMP_MAX_BYTES: '1048576' })).toBe(1048576);
    expect(dumpMaxBytes({ CHAT_RECALL_OPENCODE_DUMP_MAX_BYTES: '0' })).toBe(DEFAULT_DUMP_MAX_BYTES);
    expect(dumpMaxBytes({ CHAT_RECALL_OPENCODE_DUMP_MAX_BYTES: 'nope' })).toBe(DEFAULT_DUMP_MAX_BYTES);
  });
});

describe('exportRawSession stays inside the dump budget', () => {
  let dbDir: string;
  let savedDb: string | undefined;
  let savedBudget: string | undefined;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'cr-oc-dump-'));
    savedDb = process.env.CHAT_RECALL_OPENCODE_DB;
    savedBudget = process.env.CHAT_RECALL_OPENCODE_DUMP_MAX_BYTES;
    process.env.CHAT_RECALL_OPENCODE_DB = join(dbDir, 'opencode.db');
  });

  afterEach(() => {
    if (savedDb === undefined) delete process.env.CHAT_RECALL_OPENCODE_DB;
    else process.env.CHAT_RECALL_OPENCODE_DB = savedDb;
    if (savedBudget === undefined) delete process.env.CHAT_RECALL_OPENCODE_DUMP_MAX_BYTES;
    else process.env.CHAT_RECALL_OPENCODE_DUMP_MAX_BYTES = savedBudget;
    rmSync(dbDir, { recursive: true, force: true });
  });

  /** One session with `partCount` parts of `partBytes` each. */
  function seedDb(partCount: number, partBytes: number): void {
    const db = new DatabaseSync(join(dbDir, 'opencode.db'));
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE INDEX part_message_id_id_idx ON part (message_id, id);
    `);
    db.prepare(`INSERT INTO session VALUES ('ses_big', 'p1', '/home/user/code/example', 't', 1000, 5000)`).run();
    db.prepare(`INSERT INTO message VALUES ('msg_1', 'ses_big', 1000, 1000, ?)`).run(JSON.stringify({ role: 'user' }));
    const part = db.prepare(`INSERT INTO part VALUES (?, 'msg_1', 'ses_big', ?, ?, ?)`);
    for (let i = 0; i < partCount; i++) {
      part.run(`prt_${i}`, i, i, JSON.stringify({ type: 'text', text: 'x'.repeat(partBytes) }));
    }
    db.close();
  }

  it('keeps the rows that fit and says how many it skipped', () => {
    seedDb(20, 100_000);
    process.env.CHAT_RECALL_OPENCODE_DUMP_MAX_BYTES = '500000';
    const exp = new OpencodeBackend().exportRawSession('opencode_ses_big');
    expect(exp).not.toBeNull();
    const bytes = exp!.files[0].bytes;
    // The budget bounds the dump; the marker line is the only thing past it.
    expect(bytes.length).toBeLessThan(500_000 + 200);
    const lines = bytes.toString('utf-8').trimEnd().split('\n');
    expect(JSON.parse(lines[0]).kind).toBe('session');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.kind).toBe('truncated');
    expect(last.skipped_rows).toBeGreaterThan(0);
    expect(last.limit_bytes).toBe(500000);
  });

  it('writes no marker when the whole session fits', () => {
    seedDb(3, 1_000);
    const exp = new OpencodeBackend().exportRawSession('opencode_ses_big');
    const lines = exp!.files[0].bytes.toString('utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.some((l) => l.includes('truncated'))).toBe(false);
  });
});
