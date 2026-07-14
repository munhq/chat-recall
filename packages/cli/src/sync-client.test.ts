/**
 * Thin-collector contract: buildConversationSync ships a fully live-computed
 * conversation payload — telemetry, project id, envelope, and KG triples — from
 * the raw transcript ALONE, with NO local SQLite store pre-populated.
 *
 * The whole point of the thin collector is that nothing it ships comes from an
 * index. This test proves that by pointing CHAT_RECALL_DATA_DIR at an EMPTY
 * temp dir (so any accidental store read would find nothing) and asserting the
 * payload still carries parsed telemetry, an extracted KG triple, and an
 * envelope that matches the fixture.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let claudeHome: string;
let prevDataDir: string | undefined;
let prevClaudeHome: string | undefined;

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MTIME = 1750000000000;

/** A small but realistic Claude transcript: two user prompts, two assistant
 *  replies (with model + token usage so telemetry has something to parse), and
 *  a tool_use/tool_result pair. The prompts mention "TypeScript" and "Postgres"
 *  so the entity extractor has known tools to latch onto. */
function writeFixture(): string {
  const projDir = join(claudeHome, 'projects', '-tmp-collector-proj');
  mkdirSync(projDir, { recursive: true });
  const ts = (i: number) => new Date(MTIME + i * 1000).toISOString();
  const lines = [
    JSON.stringify({
      type: 'user', timestamp: ts(0), cwd: '/tmp/collector-proj', sessionId: SESSION_ID,
      gitBranch: 'main',
      message: { role: 'user', content: 'Please refactor the TypeScript module that talks to Postgres.' },
    }),
    JSON.stringify({
      type: 'assistant', timestamp: ts(1), cwd: '/tmp/collector-proj', sessionId: SESSION_ID,
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'tool_use',
        usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
        content: [{ type: 'text', text: 'On it — reading the module first.' }],
      },
    }),
    JSON.stringify({
      type: 'assistant', timestamp: ts(2), cwd: '/tmp/collector-proj', sessionId: SESSION_ID,
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6',
        usage: { input_tokens: 30, output_tokens: 5 },
        content: [{ type: 'tool_use', id: 'toolu_0001', name: 'Read', input: { file_path: '/tmp/collector-proj/db.ts' } }],
      },
    }),
    JSON.stringify({
      type: 'user', timestamp: ts(3), cwd: '/tmp/collector-proj', sessionId: SESSION_ID,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0001', content: 'export const db = ...' }] },
    }),
    JSON.stringify({
      type: 'user', timestamp: ts(4), cwd: '/tmp/collector-proj', sessionId: SESSION_ID,
      message: { role: 'user', content: 'Looks good, ship it.' },
    }),
    JSON.stringify({
      type: 'assistant', timestamp: ts(5), cwd: '/tmp/collector-proj', sessionId: SESSION_ID,
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
        usage: { input_tokens: 80, output_tokens: 20 },
        content: [{ type: 'text', text: 'Shipped. The Postgres client is now leaner.' }],
      },
    }),
  ];
  const path = join(projDir, `${SESSION_ID}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

beforeAll(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  prevClaudeHome = process.env.CHAT_RECALL_CLAUDE_HOME;
  // EMPTY data dir — no index, no store. If the collector secretly read a
  // store, it would find nothing here and the assertions below would fail.
  dataDir = mkdtempSync(join(tmpdir(), 'cr-collector-data-'));
  claudeHome = mkdtempSync(join(tmpdir(), 'cr-collector-home-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  process.env.CHAT_RECALL_CLAUDE_HOME = claudeHome;
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  if (prevClaudeHome === undefined) delete process.env.CHAT_RECALL_CLAUDE_HOME; else process.env.CHAT_RECALL_CLAUDE_HOME = prevClaudeHome;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(claudeHome, { recursive: true, force: true });
});

describe('thin collector — buildConversationSync ships live-computed data, no store', () => {
  test('telemetry + KG + envelope all come from the raw transcript', async () => {
    writeFixture();

    // Import AFTER the env overrides so paths/home resolve to the temp dirs.
    const { buildConversationSync } = await import('./sync-client.js');
    const { listAvailableBackends } = await import('@chat-recall/engine/core/tool-backend.js');
    const { extractEntities } = await import('@chat-recall/engine/core/entity-extractor.js');
    await import('@chat-recall/engine/core/backends/index.js');

    // Real session discovery — the same walk syncToTarget does.
    const refs = listAvailableBackends().flatMap((b) => {
      try { return b.listSessions(); } catch { return []; }
    });
    const ref = refs.find((r) => r.prefixedId === SESSION_ID);
    expect(ref, 'fixture session should be discovered by the backend').toBeDefined();

    const built = await buildConversationSync(ref!, MTIME, { includeRaw: false, includeMeta: true });
    expect(built, 'a parseable session must produce a payload').not.toBeNull();
    const conv = built!.conv as any;

    // (a) Live telemetry parsed from the fixture — NOT from any store.
    expect(conv.meta.messageCount).toBeGreaterThan(0);
    expect(conv.meta.modelsUsed).toContain('claude-sonnet-4-6');
    // inputTokens = full context (input + cache_read + cache_creation) summed
    // across assistant turns: (1200+50+10) + 30 + 80 = 1370.
    expect(conv.meta.inputTokens).toBe(1370);
    expect(conv.meta.gitBranch).toBe('main');
    // Project id resolved live from the transcript's real cwd (not the
    // mangled dir-name decode), so it is non-empty.
    expect(typeof conv.project_id).toBe('string');
    expect(conv.project_id.length).toBeGreaterThan(0);

    // (b) At least one KG triple extracted live from the redacted text.
    const triples = extractEntities(built!.kgText, { projectPath: built!.projectPath, sourceType: 'session', sessionId: SESSION_ID });
    expect(triples.length).toBeGreaterThan(0);
    // Postgres is mentioned twice → a `<project> uses postgres` DEPENDENCY triple.
    // (The extractor deliberately no longer emits `is_a` glossary triples, and a
    // single passing mention like "TypeScript" is treated as a topic, not a dep —
    // see entity-extractor.ts: needs mentions>=2 or a linguistic tech-context.)
    const uses = triples.filter((t) => t.predicate === 'uses').map((t) => t.object.toLowerCase());
    expect(uses).toContain('postgres');

    // (c) The envelope messages match the fixture: both user prompts and both
    //     assistant text replies survive, with the tool call attached.
    expect(conv.envelope.v).toBeGreaterThan(0);
    const texts = conv.envelope.messages.filter((m: any) => m.content?.trim()).map((m: any) => m.content);
    expect(texts.some((t: string) => t.includes('refactor the TypeScript module'))).toBe(true);
    expect(texts.some((t: string) => t.includes('Looks good, ship it'))).toBe(true);
    expect(texts.some((t: string) => t.includes('Postgres client is now leaner'))).toBe(true);
    const toolCalls = conv.envelope.messages.flatMap((m: any) => m.toolCalls ?? []);
    expect(toolCalls.map((c: any) => c.name)).toContain('Read');

    // session id + mtime echo back unchanged.
    expect(conv.session_id).toBe(SESSION_ID);
    expect(conv.mtime).toBe(MTIME);
  }, 60_000); // cold-transpiling the engine import graph takes ~20s on first load

  test('content-hash gate: identical content + matching priorContentHash → unchanged bail', async () => {
    writeFixture();
    const { buildConversationSync } = await import('./sync-client.js');
    const { listAvailableBackends } = await import('@chat-recall/engine/core/tool-backend.js');
    await import('@chat-recall/engine/core/backends/index.js');

    const refs = listAvailableBackends().flatMap((b) => { try { return b.listSessions(); } catch { return []; } });
    const ref = refs.find((r) => r.prefixedId === SESSION_ID)!;
    expect(ref).toBeDefined();

    // First build: full payload, exposes the content fingerprint.
    const first = await buildConversationSync(ref, MTIME, { includeRaw: false, includeMeta: true });
    expect(first).not.toBeNull();
    expect('unchanged' in first!).toBe(false);
    const srcHash = (first as any).srcHash as string;
    expect(typeof srcHash).toBe('string');
    expect(srcHash.length).toBeGreaterThan(0);

    // Second build with the same content and the matching prior hash → the whole
    // rebuild (parse/redact/KG/git-replay) is skipped; only { unchanged, srcHash }.
    const again = await buildConversationSync(ref, MTIME, { includeRaw: false, includeMeta: true, priorContentHash: srcHash });
    expect(again && 'unchanged' in again).toBe(true);
    expect((again as any).unchanged).toBe(true);
    expect((again as any).srcHash).toBe(srcHash);
    expect((again as any).conv).toBeUndefined();

    // A stale/non-matching prior hash must NOT bail — real content still ships.
    const stale = await buildConversationSync(ref, MTIME, { includeRaw: false, includeMeta: true, priorContentHash: 'deadbeef' });
    expect(stale && 'unchanged' in stale).toBe(false);
    expect((stale as any).conv?.session_id).toBe(SESSION_ID);
  }, 60_000);
});
