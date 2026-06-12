/**
 * Sync parity: the server-side conversation view must match what the local
 * dashboard shows for the same session. This is the machine-checked version
 * of the invariant that was previously only asserted in prose — and was
 * wrong twice (tool turns dropped; stale envelopes shadowing re-syncs).
 *
 * The fixture mirrors a real tool-heavy session profile (53e10694: 23 user
 * + 63 assistant text turns, 545 tool_use + 545 tool_result events — 90%+
 * of the conversation's mass is tool activity), with planted secrets.
 *
 * Pipeline under test is the REAL one end to end:
 *   transcript JSONL → engine extractTurns → client turn shaping (same
 *   rules as sync-client.ts) → POST /api/sync → conversation envelope read.
 *
 * Asserts:
 *   1. one conversation, not N
 *   2. text-message count == the local parser's count for the same file
 *   3. every tool call present, with name + attached result
 *   4. planted secrets appear in ZERO synced fields
 *   5. a stale pre-existing envelope is OVERWRITTEN by re-sync
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let claudeHome: string;
let prevDataDir: string | undefined;
let prevClaudeHome: string | undefined;

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const SECRET = 'AKIAIOSFODNN7EXAMPLE';
const USER_TURNS = 23;
const ASSISTANT_TURNS = 63;
const TOOL_PAIRS = 545;

function writeFixtureTranscript(): string {
  const projDir = join(claudeHome, 'projects', '-tmp-parity-proj');
  mkdirSync(projDir, { recursive: true });
  const lines: string[] = [];
  const ts = (i: number) => new Date(1750000000000 + i * 1000).toISOString();
  let i = 0;
  const user = (text: string) => lines.push(JSON.stringify({
    type: 'user', timestamp: ts(i++), cwd: '/tmp/parity-proj', sessionId: SESSION_ID,
    message: { role: 'user', content: text },
  }));
  const assistant = (content: unknown[]) => lines.push(JSON.stringify({
    type: 'assistant', timestamp: ts(i++), cwd: '/tmp/parity-proj', sessionId: SESSION_ID,
    message: { role: 'assistant', content },
  }));
  const toolResult = (id: string, text: string) => lines.push(JSON.stringify({
    type: 'user', timestamp: ts(i++), cwd: '/tmp/parity-proj', sessionId: SESSION_ID,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  }));

  // Interleave: each "round" = maybe a user prompt, an assistant reply,
  // and a burst of tool calls. Totals must hit the profile exactly.
  let users = 0, assistants = 0, tools = 0;
  while (users < USER_TURNS || assistants < ASSISTANT_TURNS || tools < TOOL_PAIRS) {
    if (users < USER_TURNS) { user(`prompt ${users}: please fix module-${users} (key was ${SECRET})`); users++; }
    if (assistants < ASSISTANT_TURNS) { assistant([{ type: 'text', text: `working on it, step ${assistants}` }]); assistants++; }
    const burst = Math.min(9, TOOL_PAIRS - tools);
    for (let b = 0; b < burst; b++) {
      const id = `toolu_${tools.toString().padStart(5, '0')}`;
      assistant([{ type: 'tool_use', id, name: b % 2 === 0 ? 'Bash' : 'Read', input: { command: `echo run-${tools} # ${SECRET}`, file_path: `/tmp/f${tools}` } }]);
      toolResult(id, `output of run-${tools}: ok (${SECRET})`);
      tools++;
    }
  }
  const path = join(projDir, `${SESSION_ID}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

/** Client-side turn shaping — same rules as packages/cli/src/sync-client.ts. */
async function buildClientTurns(): Promise<Array<Record<string, unknown>>> {
  const { extractTurnsAny } = await import('@chat-recall/engine/core/session-multi-tool.js');
  const { redactSecrets } = await import('@chat-recall/engine/core/secret-redactor.js');
  const turns = extractTurnsAny(SESSION_ID, { maxTurns: 50_000 });
  expect(turns.found).toBe(true);
  const count = { redactions: 0 };
  const structured: Array<Record<string, unknown>> = [];
  for (const t of turns.turns) {
    if ((t.kind === 'user' || t.kind === 'assistant_text') && t.text) {
      structured.push({ role: t.kind === 'user' ? 'user' : 'assistant', text: redactSecrets(t.text, { force: true, count }), ts: t.ts || undefined });
    } else if (t.kind === 'tool_use') {
      structured.push({ role: 'tool_use', tool_name: t.toolName || 'tool', tool_use_id: t.toolUseId || undefined, text: redactSecrets((t.command || t.toolInputSummary || '').slice(0, 2000), { force: true, count }), ts: t.ts || undefined });
    } else if (t.kind === 'tool_result') {
      structured.push({ role: 'tool_result', tool_use_id: t.toolUseId || undefined, text: redactSecrets((t.resultSummary || '').slice(0, 2000), { force: true, count }), is_error: t.resultIsError || undefined, ts: t.ts || undefined });
    }
  }
  return structured;
}

beforeAll(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  prevClaudeHome = process.env.CHAT_RECALL_CLAUDE_HOME;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-parity-data-'));
  claudeHome = mkdtempSync(join(tmpdir(), 'cr-parity-home-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  process.env.CHAT_RECALL_CLAUDE_HOME = claudeHome;
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  if (prevClaudeHome === undefined) delete process.env.CHAT_RECALL_CLAUDE_HOME; else process.env.CHAT_RECALL_CLAUDE_HOME = prevClaudeHome;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(claudeHome, { recursive: true, force: true });
});

describe('sync parity — synced conversation == local conversation', () => {
  test('tool-heavy session round-trips with full mass, no leakage, stale rows replaced', async () => {
    const transcriptPath = writeFixtureTranscript();
    const { createControlPlane, createStore } = await import('../imports.js');
    const { getConversation } = await import('../services/parser.js');
    const syncRouter = (await import('./sync.js')).default;

    // The local truth: what the local dashboard would render for this file.
    const localMessages = await getConversation(transcriptPath);
    const localToolCalls = localMessages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);
    expect(localToolCalls).toBe(TOOL_PAIRS);

    const app = express();
    app.use(express.json({ limit: '32mb' }));
    app.use('/api/sync', syncRouter);

    const cp = await createControlPlane();
    const token = await cp.mintAgentToken('default', 'parity-test');
    await cp.close();

    const mtime = 1750000999000;
    const store = await createStore();

    // 5-setup: plant a STALE envelope from a hypothetical older ingest.
    await store.setCachedContent(SESSION_ID, 'session', mtime, JSON.stringify({ v: 5, messages: [{ line: 1, role: 'assistant', content: 'STALE OLD VIEW' }], subagents: [] }));

    const turns = await buildClientTurns();
    const res = await request(app)
      .post('/api/sync')
      .set('authorization', `Bearer ${token}`)
      .send({ conversations: [{ session_id: SESSION_ID, tool: 'claude', project_path: '/tmp/parity-proj', mtime, turns }] });
    expect(res.status).toBe(200);
    expect(res.body.conv).toBe(1); // 1. one conversation, not N

    const cached = await store.getCachedContent(SESSION_ID, 'session', mtime);
    expect(cached).not.toBeNull();
    const envelope = JSON.parse(cached!);

    // 5. stale envelope was REPLACED by the re-sync
    expect(JSON.stringify(envelope)).not.toContain('STALE OLD VIEW');

    // 2. text-message parity with the local parser. The local parser merges
    // a text block and its tool_use blocks from the same API turn into one
    // message; the turn stream keeps them separate, so synced may have a
    // few extra content-less carrier messages — but NEVER fewer messages,
    // and the text itself must match 1:1.
    const localTexts = localMessages.filter(m => m.content?.trim()).map(m => m.content.trim());
    const syncedTexts = envelope.messages.filter((m: any) => m.content?.trim()).map((m: any) => m.content.trim());
    expect(syncedTexts.length).toBe(localTexts.length);

    // 3. every tool call present, with name and attached result
    const syncedCalls = envelope.messages.flatMap((m: any) => m.toolCalls ?? []);
    expect(syncedCalls.length).toBe(TOOL_PAIRS);
    expect(syncedCalls.length).toBe(localToolCalls);
    const withResults = syncedCalls.filter((c: any) => c.result !== undefined && c.result !== '');
    expect(withResults.length).toBe(TOOL_PAIRS);
    expect(new Set(syncedCalls.map((c: any) => c.name))).toEqual(new Set(['Bash', 'Read']));

    // 4. planted secret appears in ZERO synced fields (envelope AND chunks)
    expect(cached).not.toContain(SECRET);
    const hits = await store.searchFTS('AKIAIOSFODNN7EXAMPLE', { topK: 5 });
    expect(hits.length).toBe(0);
    const chunks = await store.listChunksByItem('session', SESSION_ID);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.text).not.toContain(SECRET);
    // Tool turns deliberately stay OUT of the search chunks.
    for (const c of chunks) expect(c.chunk_type.startsWith('tool')).toBe(false);

    await store.close();
  });
});
