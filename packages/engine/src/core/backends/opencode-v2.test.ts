/**
 * OpenCode 2.x storage through the 1.x readers.
 *
 * OpenCode 2.x writes sessions to `session_v2` and turns to `session_message`;
 * the 1.x tables stop growing. Before the views, every session written after
 * the upgrade was invisible to chat-recall: on one machine 127 of 411 sessions,
 * three weeks of work, never synced.
 *
 * The fixture holds both stores the way OpenCode leaves them after its
 * migration: one session in both (messages copied to 2.x), one only in 1.x
 * (its messages were never copied), and one only in 2.x.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { OpencodeBackend } from './opencode.js';
import { openOpencodeDb } from './opencode-v2.js';

let dir: string;
let dbPath: string;
let saved: string | undefined;

function build(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT,
      version TEXT, share_url TEXT, summary_additions INT, summary_deletions INT, summary_files INT, summary_diffs TEXT,
      revert TEXT, permission TEXT, time_created INT, time_updated INT, time_compacting INT, time_archived INT,
      workspace_id TEXT, path TEXT, agent TEXT, model TEXT, cost REAL, tokens_input INT, tokens_output INT,
      tokens_reasoning INT, tokens_cache_read INT, tokens_cache_write INT, metadata TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INT, time_updated INT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INT, time_updated INT, data TEXT);
    CREATE TABLE session_v2 AS SELECT * FROM session WHERE 0;
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INT, time_created INT, time_updated INT, data TEXT);
    INSERT INTO project VALUES ('p1', '/home/user/code/example');
  `);
  const sess = db.prepare(`INSERT INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?, 'p1', '/home/user/code/example', ?, ?, ?)`);
  const sess2 = db.prepare(`INSERT INTO session_v2 (id, project_id, directory, title, time_created, time_updated) VALUES (?, 'p1', '/home/user/code/example', ?, ?, ?)`);
  const msg = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  const m2 = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');

  // ses_both: in both stores; its 1.x copy says "old text", its 2.x copy the real turns.
  sess.run('ses_both', 'both', 1000, 2000);
  sess2.run('ses_both', 'both', 1000, 2000);
  msg.run('msg_b1', 'ses_both', 1000, 1000, JSON.stringify({ role: 'user' }));
  part.run('prt_b1', 'msg_b1', 'ses_both', 1000, 1000, JSON.stringify({ type: 'text', text: 'old text' }));

  // ses_old: only in 1.x message/part (OpenCode copied the session row, not its messages).
  sess.run('ses_old', 'old', 500, 600);
  sess2.run('ses_old', 'old', 500, 600);
  msg.run('msg_o1', 'ses_old', 500, 500, JSON.stringify({ role: 'user' }));
  part.run('prt_o1', 'msg_o1', 'ses_old', 500, 500, JSON.stringify({ type: 'text', text: 'a question from before the upgrade' }));

  // ses_new: only in 2.x.
  sess2.run('ses_new', 'new', 3000, 4000);
  for (const id of ['ses_both', 'ses_new']) {
    m2.run(`${id}_u`, id, 'user', 1, 3000, 3000, JSON.stringify({ time: { created: 3000 }, text: 'fix the parser please' }));
    m2.run(`${id}_a`, id, 'assistant', 2, 3010, 3020, JSON.stringify({
      time: { created: 3010, completed: 3020 },
      model: { id: 'example-model', providerID: 'example' },
      cost: 0.25,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 0, write: 0 } },
      content: [
        { type: 'reasoning', text: 'look at the file first' },
        { type: 'tool', id: 'call_1', name: 'read', state: { status: 'completed', input: { filePath: 'src/parser.ts' }, content: [{ type: 'text', text: 'export function parse() {}' }] } },
        { type: 'text', text: 'The parser is fixed.' },
      ],
    }));
    m2.run(`${id}_i`, id, 'idle', 3, 3030, 3030, JSON.stringify({ outcome: 'completed' }));
  }
  db.close();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-recall-oc2-'));
  dbPath = join(dir, 'opencode.db');
  build(dbPath);
  saved = process.env.CHAT_RECALL_OPENCODE_DB;
  process.env.CHAT_RECALL_OPENCODE_DB = dbPath;
});

afterAll(() => {
  if (saved === undefined) delete process.env.CHAT_RECALL_OPENCODE_DB;
  else process.env.CHAT_RECALL_OPENCODE_DB = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe('OpenCode 2.x views', () => {
  it('list every session of session_v2, also the ones the 1.x table never had', () => {
    const ids = new OpencodeBackend().listSessions({}).map((r) => r.prefixedId).sort();
    expect(ids).toEqual(['opencode_ses_both', 'opencode_ses_new', 'opencode_ses_old']);
  });

  it('read a 2.x session: the prompt, the reply text, and the tool call with its output', () => {
    const events = new OpencodeBackend().readEvents('opencode_ses_new');
    expect(events.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual(['fix the parser please']);
    expect(events.filter((e) => e.kind === 'assistant_text').map((e) => e.text)).toEqual(['The parser is fixed.']);
    const call = events.find((e) => e.kind === 'tool_use');
    expect(call).toMatchObject({ toolName: 'read', toolUseId: 'call_1', toolInput: { filePath: 'src/parser.ts' } });
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ toolUseId: 'call_1', resultBody: 'export function parse() {}' });
  });

  it('keep the order of a reply: reasoning, then the tool call, then the text', () => {
    const kinds = new OpencodeBackend().readEvents('opencode_ses_new').map((e) => e.kind);
    expect(kinds.indexOf('tool_use')).toBeLessThan(kinds.indexOf('assistant_text'));
  });

  it('read a session in both stores from 2.x only, so nothing is counted twice', () => {
    const texts = new OpencodeBackend().readEvents('opencode_ses_both').filter((e) => e.kind === 'user').map((e) => e.text);
    expect(texts).toEqual(['fix the parser please']);
  });

  it('read a session whose messages exist only in 1.x', () => {
    const texts = new OpencodeBackend().readEvents('opencode_ses_old').filter((e) => e.kind === 'user').map((e) => e.text);
    expect(texts).toEqual(['a question from before the upgrade']);
  });

  it('give each reply a step-finish part with its cost and tokens', () => {
    const db = openOpencodeDb(dbPath)!;
    try {
      const row = db.prepare(`SELECT SUM(json_extract(data, '$.cost')) AS cost, SUM(json_extract(data, '$.tokens.input')) AS input
        FROM part WHERE session_id = ? AND data LIKE '%step-finish%'`).get('ses_new') as { cost: number; input: number };
      expect(row).toEqual({ cost: 0.25, input: 100 });
    } finally { db.close(); }
  });

  it('leave a 1.x-only database as it is', () => {
    const p = join(dir, 'v1.db');
    const db1 = new DatabaseSync(p);
    db1.exec("CREATE TABLE session (id TEXT); INSERT INTO session VALUES ('ses_x');");
    db1.close();
    const db = openOpencodeDb(p)!;
    try {
      expect((db.prepare('SELECT count(*) AS n FROM session').get() as { n: number }).n).toBe(1);
      expect(db.prepare("SELECT name FROM temp.sqlite_master WHERE type = 'view'").all()).toEqual([]);
    } finally { db.close(); }
  });
});
