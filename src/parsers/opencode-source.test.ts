import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { OpenCodeSource } from './opencode-source.js';

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'oc-'));
  dbPath = join(tmp, 'opencode.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, name TEXT);
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT,
      summary_files INTEGER, summary_additions INTEGER, summary_deletions INTEGER,
      summary_diffs TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER
    );
    CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
  `);
  db.prepare('INSERT INTO project (id, worktree, name) VALUES (?, ?, ?)').run('p1', '/proj', 'proj');
  db.prepare(`INSERT INTO session (id, project_id, title, time_created, time_updated, summary_files, summary_additions, summary_deletions, summary_diffs)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('ses_1', 'p1', 'Refactor auth', 1000, 2000, 5, 80, 20, JSON.stringify([{ path: '/proj/src/auth.ts' }]));
  // Add a step-finish part for cost/tokens
  db.prepare('INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)')
    .run('part1', 'msg1', 'ses_1', JSON.stringify({ type: 'step-finish', cost: 0.05, tokens: { input: 100, output: 50 } }), 1500);
  // Tool part
  db.prepare('INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)')
    .run('part2', 'msg1', 'ses_1', JSON.stringify({ type: 'tool', tool: 'edit' }), 1600);
  // Text part for first-message preview
  db.prepare('INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)')
    .run('part3', 'msg1', 'ses_1', JSON.stringify({ type: 'text', text: 'fix the auth bug' }), 1100);
  db.close();
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function collect(): Promise<any[]> {
  const src = new OpenCodeSource(dbPath);
  const out: any[] = [];
  for await (const i of src.discover()) out.push(i);
  return out;
}

describe('OpenCodeSource', () => {
  test('discovers a session with project + cost summary', async () => {
    const items = await collect();
    expect(items).toHaveLength(1);
    const s = items[0];
    expect(s.id).toBe('opencode_ses_1');
    expect(s.extra.tool).toBe('opencode');
    expect(s.projectPath).toBe('/proj');
    expect(s.title).toBe('Refactor auth');
  });

  test('extracts filesModified from summary_diffs JSON', async () => {
    const items = await collect();
    expect(items[0].extra.filesModified).toContain('/proj/src/auth.ts');
  });

  test('extracts toolsUsed from tool-typed parts', async () => {
    const items = await collect();
    expect(items[0].extra.toolsUsed).toContain('edit');
  });

  test('returns empty when db is missing', async () => {
    const src = new OpenCodeSource(join(tmp, 'nope.db'));
    const out: any[] = [];
    for await (const i of src.discover()) out.push(i);
    expect(out).toEqual([]);
  });
});
