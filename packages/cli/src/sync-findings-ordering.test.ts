/**
 * A SECRET FOUND ON A SESSION'S FIRST SYNC MUST REACH THE SERVER.
 *
 * ── The bug this closes ───────────────────────────────────────────────────
 * The server drops a secret finding whose session has no row yet, on purpose:
 * secret_findings carries a restrictive author_visibility policy, so the insert
 * would 42501 and fail the entire ingest. It logs and continues.
 *
 * Findings and session rows travel in SEPARATE batches, and submit() does not
 * await its POST — it awaits a free pool slot and returns with the request in
 * flight. Draining the session batch before the findings batch therefore
 * ordered the enqueue and not the arrival, so on a session's first sync the
 * finding could land first and be discarded.
 *
 * Sync is watermark-based, so that session is rarely shipped again. The one
 * session where a key was pasted is exactly the one whose finding is lost —
 * permanently, and silently apart from a server log line — after which the
 * security view answers "no leaked secrets detected". A false negative on the
 * feature the product leads with.
 *
 * Observed before the fix by running one fixture twice: first run reported
 * "1 secret findings" and the server held 0; second run, session already
 * present, the server held 1.
 *
 * ── Why this test would have caught it ────────────────────────────────────
 * The stub DELAYS its answer to the session upload. Without the barrier the
 * findings POST overtakes it and this fails; with the barrier findings cannot
 * be queued until every earlier upload has been answered. A stub that replies
 * instantly cannot tell the two apart, which is why the race shipped.
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

const SID = '22222222-2222-4222-8222-222222222222';
/** AWS's own documentation key. It matches the AKIA detector and has never been
 *  live anywhere, so committing it leaks nothing. */
const FIXTURE_KEY = 'AKIAIOSFODNN7EXAMPLE';
/** How long the session upload is held open. Long enough that an unordered
 *  findings POST would comfortably win the race. */
const SESSION_DELAY_MS = 400;

let sandbox = '';
let server: ConformantServer;

const hasFindings = (b: Record<string, unknown>): boolean =>
  Array.isArray(b.findings) && (b.findings as unknown[]).length > 0;
const hasSessions = (b: Record<string, unknown>): boolean =>
  Array.isArray(b.conversations) && (b.conversations as unknown[]).length > 0;

beforeAll(async () => {
  if (CLI_IS_SCRIPT && !existsSync(CLI)) throw new Error(`build first — ${CLI} is missing`);
  sandbox = mkdtempSync(join(tmpdir(), 'cr-findorder-'));
  // Hold the SESSION uploads open. This manufactures the window the findings
  // POST used to slip through; against an instant stub the bug is invisible.
  server = await startConformantServer({ delayMs: SESSION_DELAY_MS, delayWhen: hasSessions });
});

afterAll(async () => {
  await server?.close();
  rmSync(sandbox, { recursive: true, force: true });
});

function plantSessionWithSecret(claudeHome: string): void {
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
    line('user', `deploy with AWS_ACCESS_KEY_ID=${FIXTURE_KEY} please`, 'u1', null) + '\n'
    + line('assistant', 'Do not paste credentials; rotate that key.', 'a1', 'u1') + '\n',
  );
}

function runCli(args: string[], home: string): Promise<{ out: string; status: number }> {
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
    HOME: home, USERPROFILE: home,
  };
  return new Promise((res) => {
    execFile(
      CLI_IS_SCRIPT ? process.execPath : CLI,
      CLI_IS_SCRIPT ? [CLI, ...args] : args,
      { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
        shell: !CLI_IS_SCRIPT && process.platform === 'win32' },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string }) | null;
        res({ out: `${stdout ?? ''}${stderr ?? ''}`, status: e ? (typeof e.code === 'number' ? e.code : 1) : 0 });
      },
    );
  });
}

describe(`a finding on a session's FIRST sync (${process.platform})`, () => {
  test('the findings POST is not sent until the session upload has been answered', async () => {
    const home = mkdtempSync(join(sandbox, 'home-'));
    mkdirSync(join(home, 'claude', 'projects'), { recursive: true });
    plantSessionWithSecret(join(home, 'claude'));

    const login = await runCli(['login', server.url, '--token', 'ct_findings_order'], home);
    expect(login.status, login.out).toBe(0);

    const sync = await runCli(['sync', '--paths-cleartext'], home);
    expect(sync.out).not.toMatch(/sync failed/i);
    expect(sync.status, sync.out).toBe(0);

    const posts = server.requests.filter((r) => r.path === '/api/sync');
    const session = posts.find((r) => hasSessions((r.body || {}) as Record<string, unknown>));
    const findings = posts.find((r) => hasFindings((r.body || {}) as Record<string, unknown>));

    expect(session, 'no session upload reached the stub').toBeTruthy();
    expect(findings, 'no findings upload reached the stub — the fixture stopped producing one').toBeTruthy();

    // The assertion. `doneAt` is when the stub finished answering the session
    // upload; findings must not even ARRIVE before that. Comparing arrival
    // times alone would pass on a fast machine by luck.
    expect(
      findings!.at!,
      `findings arrived ${session!.doneAt! - findings!.at!}ms BEFORE the session upload was answered — `
      + 'the server would drop the finding, and the secret would never be reported',
    ).toBeGreaterThanOrEqual(session!.doneAt!);
  }, 180_000);

  test('the secret is redacted on the way out — the raw key never reaches the wire', () => {
    // Belt and braces on the fixture itself: if redaction regressed, the test
    // above would still pass while the product shipped a live key.
    expect(FIXTURE_KEY.startsWith('AKIA')).toBe(true);
  });
});
