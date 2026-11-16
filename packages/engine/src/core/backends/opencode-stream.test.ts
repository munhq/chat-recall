/**
 * The lines of an OpenCode dump are read one row at a time, its size is summed
 * in SQLite, and the transcript parse cuts a tool state as its row is read. Each
 * must give what the whole-dump read and the trim after the parse give.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpencodeBackend } from './opencode.js';
import { parseOpenCodeTranscript, parseOpenCodeSubagents } from '../../transcript/opencode.js';
import { trimTranscriptForSync, SYNC_PAYLOAD_CAP } from '../../transcript/index.js';

describe('OpenCode streaming reads', () => {
  let dbDir: string;
  let savedDb: string | undefined;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'cr-oc-stream-'));
    savedDb = process.env.CHAT_RECALL_OPENCODE_DB;
    process.env.CHAT_RECALL_OPENCODE_DB = join(dbDir, 'opencode.db');
    const db = new DatabaseSync(join(dbDir, 'opencode.db'));
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, parent_id TEXT, time_archived INTEGER, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    db.prepare(`INSERT INTO session (id, project_id, directory, title, time_created, time_updated) VALUES ('ses_a', 'p1', '/home/user/code/example', 't', 1000, 5000)`).run();
    db.prepare(`INSERT INTO session (id, project_id, directory, title, parent_id, time_created, time_updated) VALUES ('ses_child', 'p1', '/home/user/code/example', '@explorer look', 'ses_a', 1100, 5000)`).run();
    const msg = db.prepare(`INSERT INTO message VALUES (?, ?, ?, ?, ?)`);
    const part = db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)`);
    msg.run('msg_u', 'ses_a', 1000, 1000, JSON.stringify({ role: 'user' }));
    msg.run('msg_a', 'ses_a', 1001, 1001, JSON.stringify({ role: 'assistant' }));
    msg.run('msg_c', 'ses_child', 1101, 1101, JSON.stringify({ role: 'assistant' }));
    part.run('prt_1', 'msg_u', 'ses_a', 1, 1, JSON.stringify({ type: 'text', text: 'start the work' }));
    part.run('prt_2', 'msg_a', 'ses_a', 2, 2, JSON.stringify({ type: 'text', text: 'on it' }));
    part.run('prt_3', 'msg_a', 'ses_a', 3, 3, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', output: 'o'.repeat(30_000) } }));
    part.run('prt_4', 'msg_a', 'ses_a', 4, 4, JSON.stringify({ type: 'tool', tool: 'read' }));
    part.run('prt_5', 'msg_c', 'ses_child', 5, 5, JSON.stringify({ type: 'tool', tool: 'grep', state: { output: 'g'.repeat(20_000) } }));
    db.close();
  });

  afterEach(() => {
    if (savedDb === undefined) delete process.env.CHAT_RECALL_OPENCODE_DB;
    else process.env.CHAT_RECALL_OPENCODE_DB = savedDb;
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('gives the lines of the dump, one row at a time', () => {
    const backend = new OpencodeBackend();
    const exp = backend.exportRawSession('opencode_ses_a')!;
    const whole = exp.files[0].bytes.toString('utf-8');
    const lines = [...backend.iterateRawSessionLines('opencode_ses_a')];
    expect(lines.join('')).toBe(whole);
    expect(lines.every((l) => l.endsWith('\n'))).toBe(true);
  });

  it('sums the bytes of the dump rows in SQLite', () => {
    const backend = new OpencodeBackend();
    const bytes = backend.rawSessionBytes('opencode_ses_a');
    const parts = [...backend.iterateRawSessionLines('opencode_ses_a')].slice(1).map((l) => JSON.parse(l).row);
    const expected = parts.reduce((n: number, r: any) => n + Buffer.byteLength(r.part_data) + Buffer.byteLength(r.message_data), 0);
    expect(bytes).toBe(expected);
    expect(backend.rawSessionBytes('opencode_ses_missing')).toBe(0);
  });

  it('cuts a tool state as its row is read, to what trimTranscriptForSync gives', async () => {
    const whole = await parseOpenCodeTranscript('opencode_ses_a');
    const cut = await parseOpenCodeTranscript('opencode_ses_a', { payloadCap: SYNC_PAYLOAD_CAP });
    const expected = trimTranscriptForSync({ messages: whole, subagents: [] }).messages;
    expect(JSON.parse(JSON.stringify(cut))).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(whole.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'assistant']);
    expect(JSON.stringify(cut).length).toBeLessThan(JSON.stringify(whole).length);
  });

  it('cuts the states of a child session too', async () => {
    const subs = await parseOpenCodeSubagents('opencode_ses_a', { payloadCap: SYNC_PAYLOAD_CAP });
    expect(subs).toHaveLength(1);
    const state = subs[0].messages[0].toolCalls?.[0].input as { output: string };
    expect(state.output.length).toBeLessThan(20_000);
    expect(state.output.endsWith(`… [+${20_000 - SYNC_PAYLOAD_CAP} chars]`)).toBe(true);
  });
});
