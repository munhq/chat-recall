import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { cursorBackend } from './cursor.js';
import { cursorProjectSlug } from './cursor-store.js';

let home: string;
let ideHome: string;
const origHome = process.env.CHAT_RECALL_CURSOR_HOME;
const origIde = process.env.CHAT_RECALL_CURSOR_IDE_HOME;

// ── fixture builders ───────────────────────────────────────────────

/**
 * Build a real `store.db`, byte-for-byte in Cursor's own shape: content-addressed
 * blobs plus a protobuf root whose repeated field 1 holds the ordered hashes.
 * Anything less would test the fixture, not the decoder.
 */
function writeStoreChat(chatId: string, cwd: string, messages: object[], opts: {
  createdAtMs?: number; updatedAtMs?: number; hasConversation?: boolean;
} = {}) {
  const md5 = createHash('md5').update(cwd).digest('hex');
  const dir = join(home, 'chats', md5, chatId);
  mkdirSync(dir, { recursive: true });

  const created = opts.createdAtMs ?? 1_787_500_000_000;
  const updated = opts.updatedAtMs ?? created + 60_000;
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    schemaVersion: 1,
    createdAtMs: created,
    updatedAtMs: updated,
    hasConversation: opts.hasConversation ?? true,
    cwd,
  }));

  const db = new DatabaseSync(join(dir, 'store.db'));
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');

  const insert = db.prepare('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)');
  const hashes: Buffer[] = [];
  for (const m of messages) {
    const bytes = Buffer.from(JSON.stringify(m), 'utf8');
    const id = createHash('sha256').update(bytes).digest('hex');
    insert.run(id, bytes);
    hashes.push(Buffer.from(id, 'hex'));
  }

  // repeated field 1, wire type 2: tag 0x0a, length 32, then the hash.
  const rootParts: Buffer[] = [];
  for (const h of hashes) rootParts.push(Buffer.from([0x0a, 0x20]), h);
  // A trailing varint field the decoder must skip rather than misread.
  rootParts.push(Buffer.from([0x28, 0x96, 0x01]));
  const root = Buffer.concat(rootParts);
  const rootId = createHash('sha256').update(root).digest('hex');
  insert.run(rootId, root);

  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    '0',
    Buffer.from(JSON.stringify({
      agentId: chatId, latestRootBlobId: rootId, name: 'New Agent',
      mode: 'default', createdAt: created, blobEncryptionKey: 'f'.repeat(64),
    }), 'utf8').toString('hex'),
  );
  db.close();
  return dir;
}

/** The flattened transcript Cursor writes beside the store. */
function writeTranscript(chatId: string, cwd: string, lines: object[]) {
  const dir = join(home, 'projects', cursorProjectSlug(cwd), 'agent-transcripts', chatId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${chatId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

/** A Cursor IDE globalStorage database with one composer and its bubbles. */
function writeIdeComposer(
  composerId: string,
  workspaceId: string,
  projectPath: string,
  bubbles: Array<Record<string, unknown>>,
) {
  const ws = join(ideHome, 'User', 'workspaceStorage', workspaceId);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'workspace.json'), JSON.stringify({ folder: `file://${projectPath}` }));

  const globalDir = join(ideHome, 'User', 'globalStorage');
  mkdirSync(globalDir, { recursive: true });
  const db = new DatabaseSync(join(globalDir, 'state.vscdb'));
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.exec('CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.exec('CREATE TABLE IF NOT EXISTS composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, '
    + 'createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, '
    + 'recency INTEGER, checkpointAt INTEGER, value TEXT)');

  db.prepare('INSERT OR REPLACE INTO composerHeaders VALUES (?,?,?,?,?,?,?,?,?)').run(
    composerId, workspaceId, 1_787_500_000_000, 1_787_500_060_000, 0, 0, 1_787_500_060_000, null,
    JSON.stringify({
      type: 'head', composerId, createdAt: 1_787_500_000_000, name: 'probe',
      workspaceIdentifier: { id: workspaceId, uri: { fsPath: projectPath, path: projectPath, scheme: 'file' } },
    }),
  );

  const kv = db.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)');
  kv.run(`composerData:${composerId}`, JSON.stringify({
    _v: 18,
    composerId,
    fullConversationHeadersOnly: bubbles.map((b) => ({ bubbleId: b.bubbleId, type: b.type })),
    conversationMap: {},
    status: 'completed',
  }));
  for (const b of bubbles) kv.run(`bubbleId:${composerId}:${b.bubbleId}`, JSON.stringify(b));
  db.close();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cursor-'));
  ideHome = mkdtempSync(join(tmpdir(), 'cursor-ide-'));
  process.env.CHAT_RECALL_CURSOR_HOME = home;
  process.env.CHAT_RECALL_CURSOR_IDE_HOME = ideHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.CHAT_RECALL_CURSOR_HOME;
  else process.env.CHAT_RECALL_CURSOR_HOME = origHome;
  if (origIde === undefined) delete process.env.CHAT_RECALL_CURSOR_IDE_HOME;
  else process.env.CHAT_RECALL_CURSOR_IDE_HOME = origIde;
  rmSync(home, { recursive: true, force: true });
  rmSync(ideHome, { recursive: true, force: true });
});

// ── shared fixture content ─────────────────────────────────────────

const CHAT = 'aaaaaaaa-1111-2222-3333-444444444444';
const CWD = '/home/u/code/probe';

const MESSAGES = [
  { role: 'system', content: 'You are an AI coding assistant, powered by Composer.' },
  { role: 'user', content: '<user_info>\nOS Version: linux\n</user_info>' },
  { role: 'user', content: [{ type: 'text', text: '<timestamp>Sun, Aug 23, 2026, 8:58 PM (UTC+3)</timestamp>\n<user_query>\nvalidate add()\n</user_query>' }] },
  { role: 'assistant', id: '1', content: [
    { type: 'redacted-reasoning', data: 'xx', providerOptions: { cursor: { modelName: 'composer-2.5-fast' } } },
    { type: 'text', text: 'On it.' },
    { type: 'tool-call', toolCallId: 'tool_1', toolName: 'Read', args: { path: `${CWD}/math.js` } },
  ] },
  { role: 'tool', id: 'tool_1', content: [
    { type: 'tool-result', toolCallId: 'tool_1', toolName: 'Read', result: 'export function add(a, b) {\n  return a + b;\n}\n' },
  ], providerOptions: { cursor: { highLevelToolCallResult: { isError: false } } } },
  { role: 'assistant', id: '2', content: [
    { type: 'tool-call', toolCallId: 'tool_2', toolName: 'StrReplace', args: {
      path: `${CWD}/math.js`, old_string: 'return a + b;', new_string: 'if (typeof a !== "number") throw new TypeError();\n  return a + b;' } },
    { type: 'tool-call', toolCallId: 'tool_3', toolName: 'Write', args: { path: `${CWD}/NOTES.md`, contents: 'probe run\n' } },
  ] },
  { role: 'tool', id: 'tool_2', content: [
    { type: 'tool-result', toolCallId: 'tool_2', toolName: 'StrReplace', result: 'boom' },
  ], providerOptions: { cursor: { highLevelToolCallResult: { isError: true } } } },
  { role: 'assistant', id: '3', content: [{ type: 'text', text: 'Done.' }] },
];

const TRANSCRIPT = [
  { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Sun, Aug 23, 2026, 8:58 PM (UTC+3)</timestamp>\n<user_query>\nvalidate add()\n</user_query>' }] } },
  { role: 'assistant', message: { content: [
    { type: 'text', text: 'On it.' },
    { type: 'tool_use', name: 'StrReplace', input: { path: `${CWD}/math.js`, old_string: 'return a + b;', new_string: 'guarded' } },
  ] } },
  { type: 'turn_ended', status: 'success' },
];

// ── CLI: the store.db path ─────────────────────────────────────────

describe('CursorBackend — cursor-agent CLI store', () => {
  test('decodes the protobuf root into the recorded message order', () => {
    writeStoreChat(CHAT, CWD, MESSAGES);
    const events = cursorBackend.readEvents(CHAT);
    expect(events.map((e) => e.kind)).toEqual([
      'user', 'assistant_text', 'tool_use',
      'tool_result',
      'tool_use', 'tool_use',
      'tool_result',
      'assistant_text',
    ]);
  });

  test('drops the system prompt and the injected <user_info> block', () => {
    writeStoreChat(CHAT, CWD, MESSAGES);
    const users = cursorBackend.readEvents(CHAT).filter((e) => e.kind === 'user');
    expect(users).toHaveLength(1);
    // The timestamp/user_query wrapper is stripped, leaving what was typed.
    expect(users[0].text).toBe('validate add()');
  });

  test('the user turn timestamp comes from the wrapper, not the file mtime', () => {
    writeStoreChat(CHAT, CWD, MESSAGES);
    const user = cursorBackend.readEvents(CHAT).find((e) => e.kind === 'user')!;
    expect(user.ts).toBe(Date.parse('Sun, Aug 23, 2026, 8:58 PM'.replace(/,([^,]*)$/, '$1')) || user.ts);
    expect(new Date(user.ts).getUTCFullYear()).toBe(2026);
  });

  test('tool results pair by toolCallId and carry the error flag', () => {
    writeStoreChat(CHAT, CWD, MESSAGES);
    const results = cursorBackend.readEvents(CHAT).filter((e) => e.kind === 'tool_result');
    expect(results.map((r) => r.toolUseId)).toEqual(['tool_1', 'tool_2']);
    expect(results[0].resultIsError).toBe(false);
    expect(results[1].resultIsError).toBe(true);
  });

  test('meta.json gives the project path outright — no path sniffing', () => {
    writeStoreChat(CHAT, CWD, MESSAGES);
    const loc = cursorBackend.findSession(CHAT)!;
    expect(loc.projectPath).toBe(CWD);
    expect(loc.format).toBe('sqlite');
  });

  test('listSessions honours projectFilter, sinceMs and limit', () => {
    writeStoreChat(CHAT, CWD, MESSAGES, { updatedAtMs: 2000 });
    writeStoreChat('bbbbbbbb-1111-2222-3333-444444444444', '/home/u/code/other', MESSAGES, { updatedAtMs: 3000 });
    expect(cursorBackend.listSessions()).toHaveLength(2);
    expect(cursorBackend.listSessions({ projectFilter: 'probe' })).toHaveLength(1);
    expect(cursorBackend.listSessions({ sinceMs: 2500 })).toHaveLength(1);
    expect(cursorBackend.listSessions({ limit: 1 })).toHaveLength(1);
    // Newest first.
    expect(cursorBackend.listSessions()[0].projectPath).toBe('/home/u/code/other');
  });

  test('a chat created but never used is not a session', () => {
    writeStoreChat(CHAT, CWD, [], { hasConversation: false });
    expect(cursorBackend.listSessions()).toHaveLength(0);
  });

  test('StrReplace and Write yield before/after deltas — the key is `contents`', () => {
    expect(cursorBackend.extractEditDelta('StrReplace', { old_string: 'a', new_string: 'b' }))
      .toEqual({ before: 'a', after: 'b' });
    expect(cursorBackend.extractEditDelta('Write', { contents: 'hi' }))
      .toEqual({ before: '', after: 'hi' });
    expect(cursorBackend.extractEditDelta('Read', { path: '/x' })).toBeNull();
  });

  test('replay reconstructs the files the agent actually changed', () => {
    writeStoreChat(CHAT, CWD, MESSAGES);
    const diff = cursorBackend.replay(CHAT);
    expect(diff.found).toBe(true);
    expect(diff.files.map((f) => f.file).sort()).toEqual([`${CWD}/NOTES.md`, `${CWD}/math.js`]);
  });

  test('ids round-trip through the cursor_ prefix', () => {
    expect(cursorBackend.matchesId(`cursor_${CHAT}`)).toBe(true);
    expect(cursorBackend.matchesId(`agy_${CHAT}`)).toBe(false);
    expect(cursorBackend.toRawId(`cursor_${CHAT}`)).toBe(CHAT);
    expect(cursorBackend.toPrefixedId(CHAT)).toBe(`cursor_${CHAT}`);
    expect(cursorBackend.toPrefixedId(`cursor_${CHAT}`)).toBe(`cursor_${CHAT}`);
  });

  test('exportRawSession ships decoded JSONL plus meta, never the raw .db', () => {
    writeStoreChat(CHAT, CWD, MESSAGES);
    const exp = cursorBackend.exportRawSession(CHAT)!;
    expect(exp.tool).toBe('cursor');
    expect(exp.files.map((f) => f.name).sort()).toEqual([`${CHAT}.jsonl`, 'meta.json']);
    expect(exp.files.every((f) => !f.name.endsWith('.db'))).toBe(true);
  });
});

// ── CLI: the JSONL fallback ────────────────────────────────────────

describe('CursorBackend — JSONL fallback when store.db cannot be decoded', () => {
  test('an unreadable store.db falls back to the flattened transcript', () => {
    const dir = writeStoreChat(CHAT, CWD, MESSAGES);
    writeTranscript(CHAT, CWD, TRANSCRIPT);
    // Simulate the encryption case: the file is there, the blobs are not JSON.
    writeFileSync(join(dir, 'store.db'), 'NOT-A-SQLITE-FILE');

    const events = cursorBackend.readEvents(CHAT);
    expect(events.map((e) => e.kind)).toEqual(['user', 'assistant_text', 'tool_use']);
    expect(events[0].text).toBe('validate add()');
  });

  test('the fallback still reconstructs edits, only tool results are lost', () => {
    const dir = writeStoreChat(CHAT, CWD, MESSAGES);
    writeTranscript(CHAT, CWD, TRANSCRIPT);
    writeFileSync(join(dir, 'store.db'), 'NOT-A-SQLITE-FILE');

    const events = cursorBackend.readEvents(CHAT);
    expect(events.some((e) => e.kind === 'tool_result')).toBe(false);
    expect(cursorBackend.replay(CHAT).files.map((f) => f.file)).toEqual([`${CWD}/math.js`]);
  });

  test('no store.db and no transcript yields nothing rather than throwing', () => {
    const dir = writeStoreChat(CHAT, CWD, MESSAGES);
    writeFileSync(join(dir, 'store.db'), 'NOT-A-SQLITE-FILE');
    expect(cursorBackend.readEvents(CHAT)).toEqual([]);
  });

  test('the project slug matches Cursor\'s own, which is lossy by design', () => {
    // Synthetic paths only. This asserted against a real home directory and a
    // real private project, which put a username and a side project into a
    // public repo to test a slash-to-dash substitution that cares about neither.
    expect(cursorProjectSlug('/home/user/code/personal/example')).toBe('home-user-code-personal-example');
    expect(cursorProjectSlug('/tmp/a__b/c')).toBe('tmp-a-b-c');
  });
});

// ── IDE ────────────────────────────────────────────────────────────

describe('CursorBackend — Cursor IDE composers', () => {
  const COMPOSER = 'cccccccc-1111-2222-3333-444444444444';
  const WS = '62259c73ac9b87cf5e3feeeafff6a580';
  const IDE_PROJECT = '/home/u/code/ide-probe';

  const BUBBLES: Array<Record<string, unknown>> = [
    { bubbleId: 'b1', type: 1, text: 'add validation', createdAt: 1_787_500_001_000 },
    { bubbleId: 'b2', type: 2, text: 'Editing now.', createdAt: 1_787_500_002_000,
      thinking: { text: 'plan it' },
      toolFormerData: {
        name: 'search_replace',
        toolCallId: 'ide_tool_1',
        // params is JSON encoded INSIDE the JSON — it must be parsed twice.
        params: JSON.stringify({ target_file: `${IDE_PROJECT}/math.js`, old_string: 'a + b', new_string: 'guarded' }),
        result: 'applied',
        additionalData: { status: 'completed' },
      } },
    { bubbleId: 'b3', type: 2, text: 'Done.', createdAt: 1_787_500_003_000,
      codeBlocks: [{ content: 'export const x = 1;', languageId: 'ts' }] },
  ];

  test('finds composers through the composerHeaders table', () => {
    writeIdeComposer(COMPOSER, WS, IDE_PROJECT, BUBBLES);
    const refs = cursorBackend.listSessions();
    expect(refs).toHaveLength(1);
    expect(refs[0].prefixedId).toBe(`cursor_${COMPOSER}`);
    expect(refs[0].projectPath).toBe(IDE_PROJECT);
    expect(refs[0].firstPrompt).toBe('add validation');
  });

  test('bubbles decode in fullConversationHeadersOnly order, not row order', () => {
    writeIdeComposer(COMPOSER, WS, IDE_PROJECT, BUBBLES);
    const events = cursorBackend.readEvents(COMPOSER);
    expect(events[0]).toMatchObject({ kind: 'user', text: 'add validation' });
    // thinking, then prose, then the tool call and its result.
    expect(events.map((e) => e.kind)).toEqual([
      'user', 'assistant_text', 'assistant_text', 'tool_use', 'tool_result', 'assistant_text',
    ]);
  });

  test('double-encoded tool params are parsed and normalised onto file_path', () => {
    writeIdeComposer(COMPOSER, WS, IDE_PROJECT, BUBBLES);
    const use = cursorBackend.readEvents(COMPOSER).find((e) => e.kind === 'tool_use')!;
    expect(use.toolName).toBe('search_replace');
    // Without this rewrite the generic engine cannot see the file at all.
    expect((use.toolInput as Record<string, unknown>).file_path).toBe(`${IDE_PROJECT}/math.js`);
  });

  test('the IDE edit reaches replay through the same generic engine', () => {
    writeIdeComposer(COMPOSER, WS, IDE_PROJECT, BUBBLES);
    expect(cursorBackend.replay(COMPOSER).files.map((f) => f.file)).toEqual([`${IDE_PROJECT}/math.js`]);
  });

  test('workspace.json maps the generated workspace id back to the project', () => {
    writeIdeComposer(COMPOSER, WS, IDE_PROJECT, BUBBLES);
    const loc = cursorBackend.findSession(COMPOSER)!;
    expect(loc.projectPath).toBe(IDE_PROJECT);
    expect(loc.projectDir).toBe(WS);
  });

  test('CLI chats and IDE composers list side by side under one tool', () => {
    writeStoreChat(CHAT, CWD, MESSAGES, { updatedAtMs: 1000 });
    writeIdeComposer(COMPOSER, WS, IDE_PROJECT, BUBBLES);
    const refs = cursorBackend.listSessions();
    expect(refs).toHaveLength(2);
    expect(refs.every((r) => r.toolId === 'cursor')).toBe(true);
  });
});
