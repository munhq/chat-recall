/**
 * A chunked session, synced and rebuilt, as a role that row-level security
 * applies to.
 *
 * The first rebuild staged its copy in a content_cache row of its own source
 * type. sync-chunked.test.ts passed, because it runs on SQLite, which has no
 * RLS. In production every staged head failed:
 *
 *   42501 new row violates row-level security policy "author_visibility"
 *   for table "content_cache"
 *
 * This drives the real client builders and the real route on Postgres, as a
 * device token minted for a named user. It checks that appended messages keep
 * the file's line numbers, and that a stored copy with a gap is rebuilt. The
 * admin connection only edits and reads rows past RLS, and cleans up.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pgAdminUrl, pgTestUrl } from '@chat-recall/engine/test-support/pg-urls.js';

const PG_URL = pgTestUrl();
const TENANT = `sync_chunked_${process.pid}`;
const AUTHOR = 'sync-chunked-author';
const SESSION = '33333333-4444-5555-6666-777777777777';
const PROJECT = '/home/user/code/example';

(PG_URL ? describe : describe.skip)('a chunked session on Postgres (RLS enforced)', () => {
  const saved: Record<string, string | undefined> = {};
  const env: Record<string, string> = { CHAT_RECALL_STORAGE: 'postgres', AUTH_PROVIDER: 'keycloak', CHAT_RECALL_FULL_BUILD_MAX_MB: '8' };
  let admin: pg.Pool;
  let app: express.Express;
  let token: string;
  let dataDir: string;
  let claudeHome: string;

  async function clean(): Promise<void> {
    const tables = (await admin.query(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant' AND t.table_type = 'BASE TABLE'`,
    )).rows.map((r: { table_name: string }) => r.table_name);
    for (const t of tables) {
      await admin.query(`DELETE FROM "${t.replace(/"/g, '""')}" WHERE tenant = $1`, [TENANT]);
    }
  }

  async function storedEnvelope(): Promise<{ messages: Array<{ line: number }>; o?: number; rebuild?: unknown }> {
    const r = await admin.query(
      `SELECT content_json FROM content_cache WHERE tenant = $1 AND id = $2 AND source_type = 'session'`, [TENANT, SESSION]);
    return JSON.parse(r.rows[0].content_json);
  }

  /** ~10 MB: turns, with a state record after every fifth one, as Claude Code writes them. */
  function writeTranscript(): string {
    const dir = join(claudeHome, 'projects', '-home-user-code-example');
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    const pad = 'lorem ipsum dolor sit amet '.repeat(70);
    for (let i = 0; i < 5_000; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      const text = `turn ${i} ${pad}`;
      lines.push(JSON.stringify({
        type: role, timestamp: new Date(1750000000000 + i * 1000).toISOString(), cwd: PROJECT, sessionId: SESSION,
        message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
      }));
      if (i % 5 === 4) lines.push(JSON.stringify({ type: 'mode', mode: 'normal', sessionId: SESSION }));
    }
    const path = join(dir, `${SESSION}.jsonl`);
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cr-chunked-pg-data-'));
    claudeHome = mkdtempSync(join(tmpdir(), 'cr-chunked-pg-home-'));
    env.CHAT_RECALL_DATA_DIR = dataDir;
    env.CHAT_RECALL_CLAUDE_HOME = claudeHome;
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    admin = new pg.Pool({ connectionString: pgAdminUrl(), max: 2 });

    const { createControlPlane } = await import('../imports.js');
    const syncRouter = (await import('./sync.js')).default;
    app = express();
    app.use(express.json({ limit: '64mb' }));
    app.use('/api/sync', syncRouter);

    await clean();
    const cp = await createControlPlane();
    try { token = await cp.mintAgentToken(TENANT, 'sync-chunked-laptop', AUTHOR); }
    finally { await cp.close(); }
  }, 60_000);

  afterAll(async () => {
    try { await clean(); } finally { await admin?.end(); }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  });

  test('the connection really is subject to RLS', async () => {
    const probe = new pg.Client({ connectionString: PG_URL });
    await probe.connect();
    try {
      const me = (await probe.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
      expect(me).toEqual({ rolsuper: false, rolbypassrls: false });
    } finally { await probe.end(); }
  });

  test('appends keep the file\'s line numbers, and a stored copy with a gap is rebuilt', async () => {
    const path = writeTranscript();
    const size = statSync(path).size;
    const { buildConversationSync, buildConversationTail } = await import('../../../cli/src/sync-client.js');
    const { claudeBackend } = await import('@chat-recall/engine/core/backends/claude.js');
    const { getConversation } = await import('../services/parser.js');
    const local = await getConversation(path);
    const localLines = local.map((m: { line: number }) => m.line);

    const loc = claudeBackend.findSession(SESSION)!;
    const ref = {
      toolId: 'claude' as const, rawId: SESSION, prefixedId: SESSION,
      projectPath: loc.projectPath, projectDir: loc.projectDir, fullPath: loc.path,
      created: '', modified: '', mtime: loc.mtime, firstPrompt: '', messageCount: 0,
    };
    const post = (conv: Record<string, unknown>) => request(app)
      .post('/api/sync').set('authorization', `Bearer ${token}`).send({ conversations: [conv] });
    const appendToEnd = async (from: number) => {
      let last: any = null;
      for (let at = from; at < size;) {
        last = await buildConversationTail(ref as any, at);
        const r = await post(last!.conv);
        expect(r.status).toBe(200);
        expect(r.body.full_resync_needed ?? []).toEqual([]);
        at = last!.newOffset;
      }
      return last;
    };

    const built = await buildConversationSync(ref as any, Math.floor(loc.mtime), { includeRaw: true, includeMeta: true });
    const head = (built as any).conv;
    expect(head.from_offset).toBeLessThan(size);
    expect((await post(head)).status).toBe(200);
    await appendToEnd(head.from_offset);
    const first = await storedEnvelope();
    expect(first.messages.map((m) => m.line)).toEqual(localLines);

    // A stored copy with a gap. Its head is staged, not refused, and the
    // final append replaces the stored copy.
    const gapped = { ...first, messages: [...first.messages.slice(0, 1000), ...first.messages.slice(1029)] };
    await admin.query(
      `UPDATE content_cache SET content_json = $3 WHERE tenant = $1 AND id = $2 AND source_type = 'session'`,
      [TENANT, SESSION, JSON.stringify(gapped)]);
    const staged = await post({ ...head, chunk_head: true });
    expect(staged.status).toBe(200);
    expect(staged.body.rebuild_staged).toEqual([SESSION]);
    expect((await storedEnvelope()).messages.length).toBe(local.length - 29);
    const lastTail = await appendToEnd(head.from_offset);
    expect(lastTail.conv.final).toBe(true);
    const rebuilt = await storedEnvelope();
    expect(rebuilt.messages.map((m) => m.line)).toEqual(localLines);
    expect(rebuilt.rebuild).toBeUndefined();
  }, 120_000);
});
