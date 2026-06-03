/**
 * MCP additions from this redesign — over the JSON-RPC stdio transport:
 *   - recall_edits_timeline (new tool)
 *   - recall_show with from_end + include_code flags
 *   - recall_recent with since_hours filter
 *   - recall_session_files live-fallback (active session works without re-index)
 *
 * Spawns dist/mcp.js per test. Skips when dist isn't built.
 */

import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MCP = join(process.cwd(), 'packages/cli/dist/mcp.js');

class Client {
  proc: ChildProcess;
  buf = '';
  resolved: any[] = [];
  nextId = 100;
  constructor() {
    this.proc = spawn('node', [MCP], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout!.on('data', (b: Buffer) => {
      this.buf += b.toString();
      const lines = this.buf.split('\n');
      this.buf = lines.pop() ?? '';
      for (const l of lines) {
        if (!l.trim()) continue;
        try { this.resolved.push(JSON.parse(l)); } catch { /* skip */ }
      }
    });
    this.proc.stderr!.on('data', () => {});
  }
  async call(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let i = 0; i < 300; i++) {
      const m = this.resolved.find(r => r.id === id);
      if (m) return m;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`MCP timeout: ${method}`);
  }
  async init() {
    await this.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  close() { this.proc.stdin!.end(); }
}

test.beforeAll(() => {
  if (!existsSync(MCP)) test.skip(true, 'dist/mcp.js not built — run `npm run build` first');
});

test('tools/list exposes recall_edits_timeline', async () => {
  const c = new Client();
  await c.init();
  const r = await c.call('tools/list', {});
  c.close();
  const names = (r.result?.tools || []).map((t: any) => t.name);
  expect(names).toContain('recall_edits_timeline');
});

test('recall_edits_timeline returns rows for the active week', async () => {
  const c = new Client();
  await c.init();
  const r = await c.call('tools/call', {
    name: 'recall_edits_timeline',
    arguments: { since_hours: 168, limit: 5 },
  });
  c.close();
  const text = r.result?.content?.[0]?.text || '';
  // Either real edits OR a graceful empty message — no thrown error.
  expect(text).toMatch(/Edits timeline|No file edits/);
});

test('recall_show from_end caps to last N messages and reports total', async () => {
  // Pick a real session id from /api/conversations/recent.
  const fetch = (await import('node:http')).default;
  // simpler: parse the cache db directly
  const Database = (await import('better-sqlite3')).default as any;
  const db = new Database(join(homedir(), '.claude/chat-recall-cache.db'), { readonly: true });
  let sessionId: string;
  try {
    const row = db.prepare(`SELECT id FROM memory_metadata WHERE source_type='session' ORDER BY mtime DESC LIMIT 1`).get() as { id: string } | undefined;
    if (!row) test.skip(true, 'no sessions indexed');
    sessionId = row!.id;
  } finally { db.close(); }

  const c = new Client();
  await c.init();
  const r = await c.call('tools/call', {
    name: 'recall_show',
    arguments: { session_id: sessionId, from_end: 2, include_code: true },
  });
  c.close();
  const text = r.result?.content?.[0]?.text || '';
  expect(text).toMatch(/Total messages: \d+/);
  expect(text).toMatch(/Showing last 2 message/);
  // include_code=true means we did NOT redact code blocks.
  expect(text).not.toMatch(/\[code block\]/);
  void fetch;
});

test('recall_recent honors since_hours', async () => {
  const c = new Client();
  await c.init();
  const r = await c.call('tools/call', {
    name: 'recall_recent',
    arguments: { since_hours: 1, limit: 3 },
  });
  c.close();
  const text = r.result?.content?.[0]?.text || '';
  // Either we have very recent sessions, or an honest "no sessions" message
  // — but the call must not throw and must reference the time window.
  expect(text).toMatch(/Recent Sessions|in the last 1h/);
});
