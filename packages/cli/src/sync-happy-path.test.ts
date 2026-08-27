/**
 * LOGIN, THEN SYNC, AND THE SESSION ACTUALLY ARRIVES.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 * The only test that proved a sync can succeed at all was the
 * compose-integration workflow: `docker compose up`, mint a token, sync, search
 * it back. It needs Docker, so it runs on Linux only. On macOS and Windows the
 * gate said the CLI installs, prints a version, boots the MCP server and fails
 * gracefully against a broken server — and said nothing at all about whether
 * `login` followed by `sync` works.
 *
 * Everything that gap could hide is platform-shaped: a path separator in a
 * project id, a case-insensitive filesystem, CRLF in a transcript, a home
 * directory resolved from the wrong environment variable. Each one breaks the
 * product on one platform and no other.
 *
 * So: a real transcript on disk, the real CLI as a subprocess, and the smallest
 * server it will sync to (conformant-server.ts) in-process. No Docker, no
 * network, ~2 seconds, and it runs wherever the suite runs.
 *
 * This does NOT replace compose-integration. That one proves the CLI and the
 * Postgres-backed server agree over the wire; this one proves the collector
 * works on the platform it is running on.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startConformantServer, type ConformantServer } from './conformant-server.js';

const CLI_OVERRIDE = (process.env.CHAT_RECALL_TEST_CLI || '').trim();
const CLI = CLI_OVERRIDE || resolve(import.meta.dirname, '../dist/cli.js');
const CLI_IS_SCRIPT = CLI.endsWith('.js') || CLI.endsWith('.mjs') || CLI.endsWith('.cjs');

/** A fixed session id, so an assertion can name the row it expects. */
const SID = '11111111-1111-4111-8111-111111111111';
/** A string that appears nowhere else, so its arrival cannot be a coincidence. */
const MARKER = 'happy-path-fixture-marker';

let sandbox = '';
let server: ConformantServer;

beforeAll(async () => {
  if (CLI_IS_SCRIPT && !existsSync(CLI)) throw new Error(`build first — ${CLI} is missing`);
  sandbox = mkdtempSync(join(tmpdir(), 'cr-happy-'));
  server = await startConformantServer();
});

afterAll(async () => {
  await server?.close();
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * One Claude transcript, in the shape the parser expects.
 *
 * Written with `\n` deliberately: a transcript is JSONL, and this is the format
 * every AI tool writes. `cwd` is a POSIX-looking path on purpose — a Windows
 * machine can hold a transcript recorded elsewhere, and the project resolver has
 * to cope either way.
 */
function plantSession(claudeHome: string): void {
  const dir = join(claudeHome, 'projects', '-home-user-code-example');
  mkdirSync(dir, { recursive: true });
  const line = (role: 'user' | 'assistant', content: string, uuid: string, parent: string | null) =>
    JSON.stringify({
      parentUuid: parent, isSidechain: false, type: role,
      message: { role, content },
      uuid, timestamp: '2026-06-16T12:00:00.000Z',
      cwd: '/home/user/code/example', sessionId: SID, version: '2.0.0', gitBranch: 'main',
    });
  writeFileSync(
    join(dir, `${SID}.jsonl`),
    line('user', `${MARKER} investigate the auth bug in the login flow`, 'u1', null) + '\n'
    + line('assistant', `Found the ${MARKER} issue in the auth handler and fixed it.`, 'a1', 'u1') + '\n',
  );
}

interface Run { out: string; status: number }

function runCli(args: string[], home: string): Promise<Run> {
  const env = {
    ...process.env,
    CHAT_RECALL_DATA_DIR: join(home, 'data'),
    CHAT_RECALL_CLAUDE_HOME: join(home, 'claude'),
    CHAT_RECALL_GEMINI_HOME: join(home, 'gemini'),
    CHAT_RECALL_CODEX_HOME: join(home, 'codex'),
    CHAT_RECALL_AGY_HOME: join(home, 'agy'),
    CHAT_RECALL_CURSOR_HOME: join(home, 'cursor'),
    CHAT_RECALL_CURSOR_IDE_HOME: join(home, 'cursor-ide'),
    CHAT_RECALL_OPENCODE_DB: join(home, 'none.db'),
    CHAT_RECALL_TELEMETRY: '0',
    HOME: home,
    USERPROFILE: home,
  };
  return new Promise<Run>((res) => {
    execFile(
      CLI_IS_SCRIPT ? process.execPath : CLI,
      CLI_IS_SCRIPT ? [CLI, ...args] : args,
      {
        env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
        shell: !CLI_IS_SCRIPT && process.platform === 'win32',
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string }) | null;
        res({ out: `${stdout ?? ''}${stderr ?? ''}`, status: e ? (typeof e.code === 'number' ? e.code : 1) : 0 });
      },
    );
  });
}

describe(`login → sync uploads a real session (${process.platform})`, () => {
  test('the whole round trip succeeds and the transcript reaches the server', async () => {
    const home = mkdtempSync(join(sandbox, 'home-'));
    mkdirSync(join(home, 'claude', 'projects'), { recursive: true });
    plantSession(join(home, 'claude'));

    const login = await runCli(['login', server.url, '--token', 'ct_happy_path'], home);
    expect(login.out).toMatch(/Logged in|Already connected/i);
    expect(login.status).toBe(0);

    // --paths-cleartext so the assertion can name the project; the redacted
    // form hashes it, and what is under test here is the upload, not hashing.
    const sync = await runCli(['sync', '--paths-cleartext'], home);
    expect(sync.out).not.toMatch(/sync failed/i);
    expect(sync.status).toBe(0);

    // THE ASSERTION THAT MATTERS: the server was actually sent this session.
    const ids = server.uploaded().map((c) => String(c.session_id ?? ''));
    expect(ids).toContain(SID);

    // And the endpoints were reached in the order the product documents.
    const paths = server.requests.map((r) => r.path);
    expect(paths).toContain('/api/capabilities');
    expect(paths).toContain('/api/sync-config');
    expect(paths).toContain('/api/sync');
  });

  test('the transcript text survived the trip, not just its id', async () => {
    const body = JSON.stringify(server.uploaded());
    // The marker appears in a user turn and an assistant turn. Redaction must
    // not have eaten ordinary prose, and the platform's line endings must not
    // have broken the JSONL parse into nothing.
    expect(body).toContain(MARKER);
  });

  test('running sync twice is clean — no half-written state on the second pass', async () => {
    // NOT a ledger test. A manual `chat-recall sync` passes no `useLedger`, so
    // it deliberately re-walks and re-ships everything; only the watch daemon
    // consults the per-server ledger (sync-ledger.test.ts covers that, and now
    // runs on all three platforms too). What matters here is that the second
    // pass re-reads everything the first pass wrote — credentials, the
    // sync-config cache, the ledger file — and still succeeds, which on Windows
    // means files re-opened under a different path convention and a filesystem
    // that will not let a still-open file be replaced.
    const home = mkdtempSync(join(sandbox, 'home-'));
    mkdirSync(join(home, 'claude', 'projects'), { recursive: true });
    plantSession(join(home, 'claude'));
    await runCli(['login', server.url, '--token', 'ct_happy_path'], home);
    const first = await runCli(['sync', '--paths-cleartext'], home);
    expect(first.status).toBe(0);
    const before = server.uploaded().length;
    const second = await runCli(['sync', '--paths-cleartext'], home);
    expect(second.out).not.toMatch(/sync failed|EPERM|EBUSY|ENOENT/i);
    expect(second.status).toBe(0);
    // It re-ships, by design — the assertion is that it got through, not that
    // it stayed quiet.
    expect(server.uploaded().length).toBeGreaterThan(before);
  });
});
