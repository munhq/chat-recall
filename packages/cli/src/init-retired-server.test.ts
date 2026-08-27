/**
 * `init` ON A MACHINE WHOSE SAVED SERVER HAS BEEN RETIRED.
 *
 * ── The report ────────────────────────────────────────────────────────────
 * `npx chat-recall@latest init` on macOS, on a machine still logged in to a host
 * that had since stopped serving chat-recall:
 *
 *     2. Connecting to your server...
 *        Connected → https://recall.example.com            <- green, and false
 *     …
 *        Installing your other MCP servers from your account...
 *        Nothing on your account to install yet.           <- also false
 *     …
 *     5. Indexing and uploading your sessions
 *        Sync failed — Unexpected non-whitespace character after JSON at position 4
 *
 * Four separate faults in one run:
 *
 *   1. "Connected" meant "credentials.json has a row". Nothing was probed.
 *   2. A stale target beat the default server, so `init` never even considered
 *      the working one — re-running it could not repair the machine.
 *   3. "Nothing on your account" was printed for a request that had FAILED:
 *      `if (!res.ok) continue` swallowed the 404 and an empty result was
 *      reported as a fact about the user's account.
 *   4. The actual cause arrived three steps later as a JSON parse offset.
 *
 * `doctor` had classified that same host correctly since server-probe.ts was
 * written. `init` just never asked.
 *
 * These tests drive the whole repair: a retired host in credentials.json, a
 * working server at CHAT_RECALL_DEFAULT_SERVER, and the assertion that `init`
 * names the retired one, moves to the working one, and leaves the machine with
 * exactly one usable target.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startHostileServer, type HostileServer } from './hostile-server.js';
import { startConformantServer, type ConformantServer } from './conformant-server.js';

const CLI_OVERRIDE = (process.env.CHAT_RECALL_TEST_CLI || '').trim();
const CLI = CLI_OVERRIDE || resolve(import.meta.dirname, '../dist/cli.js');
const CLI_IS_SCRIPT = CLI.endsWith('.js') || CLI.endsWith('.mjs') || CLI.endsWith('.cjs');

let sandbox = '';
/** The host that has stopped serving chat-recall — a reverse-proxy 404. */
let retired: HostileServer;
/** The host that works, standing in for the hosted service. */
let working: ConformantServer;

beforeAll(async () => {
  if (CLI_IS_SCRIPT && !existsSync(CLI)) throw new Error(`build first — ${CLI} is missing`);
  sandbox = mkdtempSync(join(tmpdir(), 'cr-retired-'));
  retired = await startHostileServer('text404');
  working = await startConformantServer();
});

afterAll(async () => {
  await retired?.close();
  await working?.close();
  rmSync(sandbox, { recursive: true, force: true });
});

interface Run { out: string; status: number; home: string }

/** `init`, with the retired host pre-saved and the working host as the default. */
function runInit(extra: string[] = []): Promise<Run> {
  const home = mkdtempSync(join(sandbox, 'home-'));
  mkdirSync(join(home, 'claude', 'projects'), { recursive: true });
  const dataDir = join(home, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'credentials.json'),
    JSON.stringify({ targets: [{ serverUrl: retired.url, token: 'ct_from_the_old_host' }] }),
  );
  const env = {
    ...process.env,
    CHAT_RECALL_DATA_DIR: dataDir,
    CHAT_RECALL_CLAUDE_HOME: join(home, 'claude'),
    CHAT_RECALL_GEMINI_HOME: join(home, 'gemini'),
    CHAT_RECALL_CODEX_HOME: join(home, 'codex'),
    CHAT_RECALL_AGY_HOME: join(home, 'agy'),
    CHAT_RECALL_CURSOR_HOME: join(home, 'cursor'),
    CHAT_RECALL_CURSOR_IDE_HOME: join(home, 'cursor-ide'),
    CHAT_RECALL_OPENCODE_DB: join(home, 'none.db'),
    CHAT_RECALL_TELEMETRY: '0',
    // NEVER the real service: the switch path starts a login, and against
    // chatrecall.dev that would open a device flow from a test run.
    CHAT_RECALL_DEFAULT_SERVER: working.url,
    HOME: home,
    USERPROFILE: home,
  };
  return new Promise<Run>((res) => {
    execFile(
      CLI_IS_SCRIPT ? process.execPath : CLI,
      CLI_IS_SCRIPT ? [CLI, 'init', ...extra] : ['init', ...extra],
      {
        env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
        shell: !CLI_IS_SCRIPT && process.platform === 'win32',
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string }) | null;
        res({ out: `${stdout ?? ''}${stderr ?? ''}`, status: e ? (typeof e.code === 'number' ? e.code : 1) : 0, home });
      },
    );
  });
}

function targets(home: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'data', 'credentials.json'), 'utf8')) as
      { targets?: Array<{ serverUrl?: string }> };
    return (raw.targets ?? []).map((t) => t.serverUrl ?? '');
  } catch {
    return [];
  }
}

const LOCAL = ['--skip-mcp', '--skip-codeindex', '--skip-service', '--skip-sync'];

describe('init repairs a machine pointed at a retired server', () => {
  test('it never claims "Connected" to a host answering 404', async () => {
    const { out } = await runInit(LOCAL);
    expect(out).toMatch(/no longer serves chat-recall/i);
    expect(out).toMatch(/HTTP 404/);
    // The green claim must not appear for the retired host.
    expect(out).not.toMatch(new RegExp(`Connected\\s*→\\s*${retired.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  test('it switches to the default server and logs in there', async () => {
    const { out, home } = await runInit(LOCAL);
    expect(out).toMatch(/Switching to/);
    expect(out).toContain(working.url);
    expect(out).toMatch(/Logged in|Already connected/i);
    // THE REPAIR: exactly one target, and it is the one that answers.
    expect(targets(home)).toEqual([working.url]);
  });

  test('the retired target is removed, so no later sync fails against it', async () => {
    // Every sync pushes to ALL targets. A host that provably cannot answer,
    // left in place, makes every future sync report a failure and sends the
    // user to fix a server that is not theirs any more.
    const { out, home } = await runInit(LOCAL);
    expect(out).toMatch(/Removed the retired target/);
    expect(targets(home)).not.toContain(retired.url);
  });

  test('THE BURIED SYMPTOM is gone from the whole run', async () => {
    const { out } = await runInit(LOCAL);
    expect(out).not.toMatch(/non-whitespace character after JSON/i);
    expect(out).not.toMatch(/JSON at position/i);
  });

  test('and the sync at step 5 goes to the NEW server, not the retired one', async () => {
    const before = working.requests.length;
    const { out } = await runInit(['--skip-mcp', '--skip-codeindex', '--skip-service']);
    expect(out).not.toMatch(/Sync failed/i);
    expect(working.requests.length).toBeGreaterThan(before);
    // The retired host must not have been asked to ingest anything.
    expect(retired.hits.filter((h) => h.includes('/api/sync'))).toEqual([]);
  });
});

describe('"nothing on your account" is a claim, and needs an answer behind it', () => {
  test('a failed toolkit query says it could not ask, not that the account is empty', async () => {
    // `if (!res.ok) continue` swallowed the retired host's 404, so a user with a
    // dozen registered MCP servers was told they had none. The switch above now
    // repairs the target first, so reach the failure directly: keep the retired
    // host AND make it the default, so there is no working server to move to.
    const home = mkdtempSync(join(sandbox, 'home-'));
    mkdirSync(join(home, 'claude', 'projects'), { recursive: true });
    const dataDir = join(home, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'credentials.json'),
      JSON.stringify({ targets: [{ serverUrl: retired.url, token: 'ct_old' }] }),
    );
    const env = {
      ...process.env,
      CHAT_RECALL_DATA_DIR: dataDir,
      CHAT_RECALL_CLAUDE_HOME: join(home, 'claude'),
      CHAT_RECALL_GEMINI_HOME: join(home, 'gemini'),
      CHAT_RECALL_CODEX_HOME: join(home, 'codex'),
      CHAT_RECALL_AGY_HOME: join(home, 'agy'),
      CHAT_RECALL_CURSOR_HOME: join(home, 'cursor'),
      CHAT_RECALL_CURSOR_IDE_HOME: join(home, 'cursor-ide'),
      CHAT_RECALL_OPENCODE_DB: join(home, 'none.db'),
      CHAT_RECALL_TELEMETRY: '0',
      CHAT_RECALL_DEFAULT_SERVER: retired.url,
      HOME: home,
      USERPROFILE: home,
    };
    const out = await new Promise<string>((res) => {
      execFile(
        CLI_IS_SCRIPT ? process.execPath : CLI,
        CLI_IS_SCRIPT ? [CLI, 'init', '--skip-codeindex', '--skip-service', '--skip-sync']
          : ['init', '--skip-codeindex', '--skip-service', '--skip-sync'],
        {
          env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
          shell: !CLI_IS_SCRIPT && process.platform === 'win32',
        },
        (_e, stdout, stderr) => res(`${stdout ?? ''}${stderr ?? ''}`),
      );
    });
    expect(out).not.toMatch(/Nothing on your account to install yet/);
    expect(out).toMatch(/Could not ask your server/i);
    expect(out).toMatch(/HTTP 404/);
  });
});
