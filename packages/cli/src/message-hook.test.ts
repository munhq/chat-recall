/**
 * The built message hook, run the way Claude Code runs it, against a small
 * fake server. The waiter's exit code is the contract: 2 makes Claude Code
 * wake the session with stderr, anything else is silent.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'message-hook.js');
const SID = '11111111-0000-4000-8000-000000000001';
const PARENT = '11111111-0000-4000-8000-0000000000f0';

type Handler = (path: string, body: any) => { status: number; json?: unknown };
let root: string;
let server: Server;
let calls: Array<{ path: string; body: any }>;
let handler: Handler;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cr-message-hook-'));
  calls = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url ?? '', body });
      const r = handler(req.url ?? '', body);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'credentials.json'), JSON.stringify({ targets: [{ serverUrl: `http://127.0.0.1:${port}`, token: 't' }] }));
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

function runHook(args: string[], payload: unknown): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK, ...args], {
      env: { ...process.env, CHAT_RECALL_DATA_DIR: join(root, 'data'), CHAT_RECALL_TOKEN: '', CHAT_RECALL_SERVER: '', CHAT_RECALL_WAIT_BACKOFF_UNIT_MS: '10' },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const message = { id: 'm_1', fromSession: PARENT, toSession: SID, body: 'Run the tests.', replyTo: null, createdAt: Date.now(), deliveredAt: null };

describe.skipIf(!existsSync(HOOK))('message hook, the waiter', () => {
  test('a message: stderr carries it, it is acknowledged, and the exit code is 2', async () => {
    handler = (path) => path === '/api/live-sessions/wait'
      ? { status: 200, json: { ended: false, messages: [message], labels: { [PARENT]: 'lead' } } }
      : { status: 200, json: { acked: 1 } };
    const r = await runHook(['--wait'], { session_id: SID, hook_event_name: 'Stop' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('From lead (11111111)');
    expect(r.stderr).toContain('> Run the tests.');
    expect(calls.map((c) => c.path)).toEqual(['/api/live-sessions/wait', '/api/live-sessions/ack']);
    expect(calls[1].body).toEqual({ sessionId: SID, ids: ['m_1'] });
  }, 20_000);

  test('an ended session: exit 0 and nothing on stderr', async () => {
    handler = () => ({ status: 200, json: { ended: true, messages: [] } });
    const r = await runHook(['--wait'], { session_id: SID, hook_event_name: 'SessionStart' });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
  }, 20_000);

  test('a server without the route: it stops after five 404s', async () => {
    handler = () => ({ status: 404 });
    const r = await runHook(['--wait'], { session_id: SID, hook_event_name: 'Stop' });
    expect(r.code).toBe(0);
    expect(calls.filter((c) => c.path === '/api/live-sessions/wait')).toHaveLength(5);
  }, 20_000);

  test('supervised: a stopped waiter says why, so a plugin starts it only when it helps', async () => {
    handler = () => ({ status: 200, json: { ended: true, messages: [] } });
    const ended = await runHook(['--wait', '--supervised'], { session_id: SID, hook_event_name: 'Stop' });
    expect(ended.code).toBe(75);

    const dir = join(root, 'data', 'hook-state', 'messages');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SID}.waiter`), String(process.pid));
    const taken = await runHook(['--wait', '--supervised'], { session_id: SID, hook_event_name: 'Stop' });
    expect(taken.code).toBe(76);
    rmSync(join(dir, `${SID}.waiter`), { force: true });

    const child = await runHook(['--wait', '--supervised'], { session_id: SID, hook_event_name: 'Stop', agent_id: 'a1' });
    expect(child.code).toBe(77);
  }, 20_000);

  test('a second waiter for the same session exits at once', async () => {
    const dir = join(root, 'data', 'hook-state', 'messages');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SID}.waiter`), String(process.pid));     // a live process holds the slot
    handler = () => ({ status: 200, json: { ended: false, messages: [] } });
    const r = await runHook(['--wait'], { session_id: SID, hook_event_name: 'Stop' });
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(0);
  }, 20_000);

  test('inside a subagent the waiter does not run', async () => {
    handler = () => ({ status: 200, json: { ended: false, messages: [message] } });
    const r = await runHook(['--wait'], { session_id: SID, hook_event_name: 'Stop', agent_id: 'a1' });
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(0);
  }, 20_000);
});

describe.skipIf(!existsSync(HOOK))('message hook, a turn run', () => {
  test('SessionStart reports the session and prints its id; the state file records the profile', async () => {
    handler = () => ({ status: 200, json: { session: {}, messages: [] } });
    const r = await runHook([], { session_id: SID, hook_event_name: 'SessionStart', cwd: '/home/user/code/example' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`chat-recall session id: ${SID}`);
    expect(calls[0]).toMatchObject({ path: '/api/live-sessions/event', body: { sessionId: SID, event: 'SessionStart', take: true } });
    const state = JSON.parse(readFileSync(join(root, 'data', 'hook-state', 'messages', `${SID}.json`), 'utf-8'));
    expect(state).toMatchObject({ introduced: true, cwd: '/home/user/code/example' });
    expect(typeof state.configDir).toBe('string');
  }, 20_000);

  test('a server error prints nothing into the turn', async () => {
    handler = () => ({ status: 500 });
    const r = await runHook([], { session_id: SID, hook_event_name: 'UserPromptSubmit' });
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
  }, 20_000);

  test('the turn reports the process kind and pid the tool named', async () => {
    handler = () => ({ status: 200, json: { session: {}, messages: [] } });
    await runHook([], { session_id: SID, hook_event_name: 'SessionStart', kind: 'serve', pid: 4242 });
    expect(calls[0].body).toMatchObject({ sessionId: SID, event: 'SessionStart', kind: 'serve', pid: 4242 });
  }, 20_000);
});

describe.skipIf(!existsSync(HOOK))('message hook, the TUI modes', () => {
  const TUI = 'tui_0123456789abcdef';
  const CWD = '/home/user/code/axon';

  test('presence registers the folder, prints the message and does not acknowledge it', async () => {
    handler = (path) => path === '/api/live-sessions/wait'
      ? { status: 200, json: { ended: false, messages: [message], labels: {} } }
      : { status: 200, json: { session: {} } };
    const r = await runHook(['--tool', 'opencode', '--presence'], { session_id: TUI, cwd: CWD, pid: process.pid });
    expect(r.code).toBe(0);
    expect(calls[0]).toMatchObject({
      path: '/api/live-sessions/register',
      body: { sessionId: TUI, kind: 'tui', cwd: CWD, pid: process.pid },
    });
    const out = JSON.parse(r.stdout.trim());
    expect(out.ids).toEqual(['m_1']);
    expect(out.text).toContain('> Run the tests.');
    // The plugin acknowledges only after the prompt lands.
    expect(calls.map((c) => c.path)).toEqual(['/api/live-sessions/register', '/api/live-sessions/wait']);
  }, 20_000);

  test('presence ends its row when the TUI it reports for is gone', async () => {
    handler = () => ({ status: 200, json: { session: {} } });
    const dead = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['-e', '']);
      child.on('close', () => resolve(child.pid!));
    });
    const r = await runHook(['--tool', 'opencode', '--presence'], { session_id: TUI, cwd: CWD, pid: dead });
    expect(r.code).toBe(0);
    expect(calls).toEqual([{ path: '/api/live-sessions/event', body: { sessionId: TUI, event: 'SessionEnd' } }]);
  }, 20_000);

  test('report marks the session the TUI shows as tui, and ack acknowledges what it delivered', async () => {
    handler = () => ({ status: 200, json: { session: {}, acked: 1 } });
    const reported = await runHook(['--tool', 'opencode', '--report'], { session_id: 'opencode_ses_abc', cwd: CWD, kind: 'tui', pid: 4343 });
    expect(reported.code).toBe(0);
    expect(calls[0]).toMatchObject({
      path: '/api/live-sessions/register',
      body: { sessionId: 'opencode_ses_abc', kind: 'tui', cwd: CWD, pid: 4343 },
    });
    calls = [];
    const acked = await runHook(['--tool', 'opencode', '--ack'], { session_id: TUI, ids: ['m_1', 'm_2'] });
    expect(acked.code).toBe(0);
    expect(calls).toEqual([{ path: '/api/live-sessions/ack', body: { sessionId: TUI, ids: ['m_1', 'm_2'] } }]);
  }, 20_000);
});
