import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { OpenCodeTodoSource } from './opencode-todo-source.js';

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'oc-todo-'));
  dbPath = join(tmp, 'opencode.db');
  // Build a minimal opencode-shaped DB.
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
      title TEXT, directory TEXT
    );
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE todo (
      session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
  `);
  db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run('p1', '/proj');
  db.prepare('INSERT INTO session (id, project_id, time_created, time_updated, title) VALUES (?,?,?,?,?)')
    .run('ses_1', 'p1', 1000, 2000, 'Session A');
  for (const t of [
    { c: 'Fix the auth bug', s: 'completed', pos: 0 },
    { c: 'Write tests',      s: 'in_progress', pos: 1 },
  ]) {
    db.prepare('INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?,?,?,?,?,?,?)')
      .run('ses_1', t.c, t.s, 'high', t.pos, 1500, 1500);
  }
  db.close();
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function collect(): Promise<any[]> {
  const src = new OpenCodeTodoSource(dbPath);
  const out: any[] = [];
  for await (const i of src.discover()) out.push(i);
  return out;
}

describe('OpenCodeTodoSource', () => {
  test('discovers todos as task items tagged opencode', async () => {
    const items = await collect();
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].extra.tool).toBe('opencode');
  });

  test('returns empty when db file is missing', async () => {
    const src = new OpenCodeTodoSource(join(tmp, 'nope.db'));
    const out: any[] = [];
    for await (const i of src.discover()) out.push(i);
    expect(out).toEqual([]);
  });
});
