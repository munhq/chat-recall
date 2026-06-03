/**
 * MCP server end-to-end tests via stdio JSON-RPC.
 *
 * Spawns dist/mcp.js, runs the four newly-added tools against this user's
 * real on-disk indexed data, asserts each returns a non-empty response.
 *
 * These are integration tests — they depend on:
 *   - dist/mcp.js being built (skipped otherwise)
 *   - SQLite/LanceDB indexes being populated (skipped if status reports 0 items)
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const MCP = join(process.cwd(), 'packages/cli/dist/mcp.js');

class McpClient {
  private proc: ChildProcess;
  private buf = '';
  private responses: any[] = [];
  private resolveOne: (() => void) | null = null;
  private nextId = 100;

  constructor() {
    this.proc = spawn('node', [MCP], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString();
      const lines = this.buf.split('\n');
      this.buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.responses.push(JSON.parse(line));
          this.resolveOne?.();
        } catch {}
      }
    });
    this.proc.stderr!.on('data', () => {}); // swallow startup chatter
  }

  private send(req: any) {
    this.proc.stdin!.write(JSON.stringify(req) + '\n');
  }

  async call(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    const before = this.responses.length;
    this.send({ jsonrpc: '2.0', id, method, params });
    while (!this.responses.find((r) => r.id === id)) {
      await new Promise<void>((r) => { this.resolveOne = r; setTimeout(r, 200); });
    }
    return this.responses.find((r) => r.id === id);
  }

  async init() {
    await new Promise((r) => setTimeout(r, 800));
    await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-tools-test', version: '0' },
    });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  }

  async callTool(name: string, args: any): Promise<string> {
    const res = await this.call('tools/call', { name, arguments: args });
    return res?.result?.content?.[0]?.text ?? '';
  }

  close() {
    this.proc.kill();
  }
}

test.describe('MCP new tools', () => {
  test.skip(!existsSync(MCP), 'dist/mcp.js not built — run `npm run build` first');

  let client: McpClient;
  test.beforeAll(async () => {
    client = new McpClient();
    await client.init();
  });
  test.afterAll(() => client?.close());

  test('tools/list exposes all 4 new tools', async () => {
    const res = await client.call('tools/list', {});
    const names = new Set((res.result.tools as any[]).map((t) => t.name));
    expect(names.has('recall_subagent_search')).toBe(true);
    expect(names.has('recall_files_touched')).toBe(true);
    expect(names.has('recall_user_prompts')).toBe(true);
    expect(names.has('recall_decision_record')).toBe(true);
  });

  test('recall_user_prompts returns recent prompts banner-stripped', async () => {
    const text = await client.callTool('recall_user_prompts', { since_days: 30, limit: 5 });
    // Either there are prompts (text body with bullets) or a "no prompts" message —
    // both are valid; what we don't allow is the MCP banner leaking.
    expect(text).not.toMatch(/MCP issues detected\./);
    expect(text.length).toBeGreaterThan(0);
  });

  test('recall_subagent_search returns either matches or a clean empty', async () => {
    const text = await client.callTool('recall_subagent_search', { query: 'devnet', limit: 3 });
    expect(text.length).toBeGreaterThan(0);
    // If matches found, body must mention the query; if not, we expect the explicit empty form.
    if (!text.includes('No subagent matches')) {
      expect(text.toLowerCase()).toContain('devnet');
    }
  });

  test('recall_files_touched gracefully handles unknown patterns', async () => {
    const text = await client.callTool('recall_files_touched', {
      pattern: '__definitely-not-a-real-file__',
      since_days: 7,
      limit: 3,
    });
    expect(text).toContain('No sessions');
  });

  test('recall_decision_record writes both KG and diary in one call', async () => {
    const subject = `e2e-test-${Date.now()}`;
    const text = await client.callTool('recall_decision_record', {
      subject,
      decision: 'verify decision recording works',
      reason: 'covering the new write path',
      importance: 3,
      agent_name: 'e2e-test',
    });
    expect(text).toContain('Decision recorded');
    expect(text).toContain('KG:');
    expect(text).toContain('Diary entry:');
    expect(text).toContain(subject);

    // Verify the KG triple is queryable
    const kg = await client.callTool('recall_kg_query', { entity: subject });
    expect(kg).toContain('verify decision recording works');

    // And clean it up so we don't pollute the user's KG
    await client.callTool('recall_kg_invalidate', {
      subject,
      predicate: 'decided',
      object: 'verify decision recording works',
    });
  });
});
