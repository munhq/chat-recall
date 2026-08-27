/**
 * THE CLI, RUN AS A SUBPROCESS, AGAINST SERVERS THAT ANSWER BADLY.
 *
 * This is the gate that was missing. Every install bug found on 2026-08-27 was
 * found by a person on a laptop, and every one of them reproduces in under a
 * second with no network: CI installed the tarball and ran `--version` and
 * `status`, never the three commands a new user actually runs (`init`, `login`,
 * `sync`), and never against anything but a healthy server or nothing at all.
 *
 * So these tests spawn the BUILT cli and assert on what a user would read:
 *
 *   1. the message names the real cause (a retired host, a dead port, a name
 *      that does not resolve) — not a JSON parse offset, not SSO;
 *   2. `init` SURVIVES a failed connection and still does its local work,
 *      because it used to exit at step 2 and leave MCP unconfigured;
 *   3. no failure path mentions OIDC or an issuer, which is the specific red
 *      herring that cost a round trip;
 *   4. a host that is NOT chat-recall never becomes a sync target, however
 *      cheerfully it answers 200.
 *
 * Asserting on user-visible strings is deliberate. The unit tests already cover
 * the classification; what broke was the wiring between it and the output, and a
 * test of the internals would have passed throughout.
 *
 * ── WHY EVERY SPAWN HERE IS ASYNCHRONOUS ──────────────────────────────────
 * The first version used execFileSync. That blocks this process's event loop for
 * the whole life of the child — so the hostile server, which runs IN this
 * process, could not accept a single connection. Every request timed out, and
 * four assertions "passed" because a timeout message also happens to contain no
 * JSON-parse offset. One test then hung for the full 180-second limit. A
 * synchronous spawn and an in-process server cannot be combined; `hits` is
 * asserted below so this can never silently come back.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startHostileServer, refusedUrl, unresolvableUrl, type HostileServer } from './hostile-server.js';

/**
 * WHICH CLI IS UNDER TEST.
 *
 * By default the built bundle, because the bug was in what shipped rather than
 * in the source. `CHAT_RECALL_TEST_CLI` re-points these same assertions at a
 * DIFFERENT artifact — the fresh-install workflow sets it to `chat-recall`, the
 * globally installed binary from the packed tarball, so the tarball a customer
 * runs faces the identical hostile servers on Linux, macOS and Windows. One set
 * of assertions, two artifacts: a second copy of them would drift.
 */
const CLI_OVERRIDE = (process.env.CHAT_RECALL_TEST_CLI || '').trim();
const CLI = CLI_OVERRIDE || resolve(import.meta.dirname, '../dist/cli.js');
/** A path is run through `node`; a bare command name is run as itself. */
const CLI_IS_SCRIPT = CLI.endsWith('.js') || CLI.endsWith('.mjs') || CLI.endsWith('.cjs');

let sandbox = '';

beforeAll(() => {
  if (CLI_IS_SCRIPT && !existsSync(CLI)) throw new Error(`build first — ${CLI} is missing`);
  sandbox = mkdtempSync(join(tmpdir(), 'cr-hostile-'));
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

interface RunOpts {
  /** Pre-seed credentials.json, so `sync` has a target without a real login. */
  credentialsFor?: string;
}

interface Run {
  out: string;
  status: number | null;
  /** The throwaway home this run wrote into, for asserting on what it left. */
  home: string;
}

/**
 * Run the CLI with EVERY tool home redirected into a throwaway tree.
 *
 * Not optional: `init` writes MCP config and skills into ~/.claude, ~/.codex,
 * ~/.gemini, ~/.config/opencode and ~/.cursor. A test that forgets one edits the
 * developer's real machine — which happened while this was being written.
 */
async function runCli(args: string[], opts: RunOpts = {}): Promise<Run> {
  const home = mkdtempSync(join(sandbox, 'home-'));
  mkdirSync(join(home, 'claude', 'projects'), { recursive: true });
  const dataDir = join(home, 'data');
  mkdirSync(dataDir, { recursive: true });
  if (opts.credentialsFor) {
    writeFileSync(
      join(dataDir, 'credentials.json'),
      JSON.stringify({ targets: [{ serverUrl: opts.credentialsFor, token: 'ct_seeded_for_test' }] }),
    );
  }
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
    // Never report a test run to anyone's server.
    CHAT_RECALL_TELEMETRY: '0',
    // Keep the MCP-client writers inside the sandbox too.
    HOME: home,
    USERPROFILE: home,
  };
  return new Promise<Run>((resolvePromise) => {
    execFile(
      CLI_IS_SCRIPT ? process.execPath : CLI,
      CLI_IS_SCRIPT ? [CLI, ...args] : args,
      {
        env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
        // A global npm bin on Windows is `chat-recall.cmd`, and CreateProcess
        // will not run a .cmd without a shell.
        shell: !CLI_IS_SCRIPT && process.platform === 'win32',
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string }) | null;
        resolvePromise({
          out: `${stdout ?? ''}${stderr ?? ''}`,
          status: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
          home,
        });
      },
    );
  });
}

/** The sync targets a run left behind — empty when it persisted nothing. */
function persistedTargets(home: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'data', 'credentials.json'), 'utf8')) as
      { targets?: Array<{ serverUrl?: string }> };
    return (raw.targets ?? []).map((t) => t.serverUrl ?? '');
  } catch {
    return [];
  }
}

const INIT_LOCAL_ONLY = ['--skip-mcp', '--skip-codeindex', '--skip-service', '--skip-sync'];

describe('init against a server that cannot be reached', () => {
  test('a name that does not resolve is reported AS a name that does not resolve', async () => {
    const { out } = await runCli(['init', '--server', unresolvableUrl(), ...INIT_LOCAL_ONLY]);
    expect(out).toMatch(/resolve/i);
    expect(out).toMatch(/ENOTFOUND|EAI_AGAIN/);
  });

  test('a refused port says refused, not "fetch failed"', async () => {
    const { out } = await runCli(['init', '--server', await refusedUrl(), ...INIT_LOCAL_ONLY]);
    expect(out).toMatch(/refused/i);
    // The bare five characters, with no cause beside them, are the regression.
    expect(out).not.toMatch(/Not connected\.\s*fetch failed\s*$/m);
  });

  test('THE RED HERRING: no unreachable-server path mentions OIDC or an issuer', async () => {
    for (const url of [unresolvableUrl(), await refusedUrl()]) {
      const { out } = await runCli(['init', '--server', url, ...INIT_LOCAL_ONLY]);
      expect(out).not.toMatch(/OIDC/i);
      expect(out).not.toMatch(/issuer/i);
      expect(out).not.toMatch(/Keycloak/i);
    }
  });

  test('init CONTINUES past a failed connection and still configures MCP', async () => {
    // The regression that mattered most: runLogin called process.exit(1), so the
    // whole command died at step 2 and the user was left with nothing wired.
    const { out } = await runCli(['init', '--server', await refusedUrl(), '--skip-codeindex', '--skip-service', '--skip-sync']);
    expect(out).toMatch(/Configuring MCP server/i);
    expect(out).toMatch(/Setup complete/i);
  });

  test('the step numbers are contiguous — a hole reads as a missed step', async () => {
    const { out } = await runCli(['init', '--server', await refusedUrl(), ...INIT_LOCAL_ONLY]);
    const steps = [...out.matchAll(/^(\d)\. /gm)].map((m) => Number(m[1]));
    const unique = [...new Set(steps)].sort((a, b) => a - b);
    expect(unique).toEqual(Array.from({ length: unique.length }, (_, i) => i + 1));
  });

  test('the version is on the first line, so a report can be attributed to a build', async () => {
    const { out } = await runCli(['init', '--server', await refusedUrl(), ...INIT_LOCAL_ONLY]);
    expect(out.split('\n')[0]).toMatch(/chat-recall init\s+v\d+\.\d+\.\d+/);
  });
});

describe('a host that stopped serving chat-recall', () => {
  const servers: HostileServer[] = [];
  afterAll(async () => { for (const s of servers) await s.close(); });

  async function hostile(mode: Parameters<typeof startHostileServer>[0]): Promise<HostileServer> {
    const s = await startHostileServer(mode);
    servers.push(s);
    return s;
  }

  test('a plain-text 404 is named, NOT reported as a JSON parse offset', async () => {
    // The exact shape of the failure a user hit: the reverse proxy answers
    // `404 page not found` in text/plain, JSON.parse reads 404 as a number and
    // dies at position 4, and the user is shown
    // "Unexpected non-whitespace character after JSON at position 4".
    const s = await hostile('text404');
    const { out } = await runCli(['login', s.url, '--token', 'ct_definitely_not_valid']);
    // Proof the server was actually consulted — see the header of this file.
    expect(s.hits.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/non-whitespace character after JSON/i);
    expect(out).not.toMatch(/JSON at position/i);
    expect(out).toMatch(/404/);
  });

  test('an HTML page on a 200 is not mistaken for our API', async () => {
    const s = await hostile('html200');
    const { out, home } = await runCli(['login', s.url, '--token', 'ct_definitely_not_valid']);
    expect(s.hits.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/Unexpected token|JSON at position/i);
    expect(out).not.toMatch(/Logged in/i);
    // THE ONE THAT MATTERED. A 200 from a login wall used to be accepted as a
    // no-auth self-host, and the host was written to credentials.json — so the
    // next sync uploaded this machine's transcripts to a stranger.
    expect(persistedTargets(home)).toEqual([]);
  });

  test('a 502 blames the server, not the token', async () => {
    const s = await hostile('gateway502');
    const { out } = await runCli(['login', s.url, '--token', 'ct_definitely_not_valid']);
    expect(s.hits.length).toBeGreaterThan(0);
    expect(out).toMatch(/502/);
    expect(out).toMatch(/server/i);
    expect(out).not.toMatch(/OIDC|issuer/i);
  });

  test('a different JSON API on the same host never becomes a sync target', async () => {
    const s = await hostile('notOurApi');
    const { out, home } = await runCli(['init', '--server', s.url, ...INIT_LOCAL_ONLY]);
    expect(s.hits.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/OIDC|issuer/i);
    expect(out).not.toMatch(/Logged in/i);
    expect(persistedTargets(home)).toEqual([]);
  });

  test('doctor describes the same host the same way login does', async () => {
    // Two surfaces, one probe module. They disagreed before: doctor classified,
    // login printed "fetch failed".
    const s = await hostile('text404');
    const login = (await runCli(['login', s.url, '--token', 'ct_definitely_not_valid'])).out;
    const doctor = (await runCli(['doctor'])).out;
    expect(login).not.toMatch(/JSON at position/i);
    expect(doctor).not.toMatch(/JSON at position/i);
  });
});

/**
 * SYNC, which is where the reported failure actually surfaced.
 *
 * `login` and `doctor` had been taught to classify a bad server; `sync` had its
 * own `.json()` on `/api/capabilities` with no status check, so it kept printing
 * parse offsets long after the other two stopped. Credentials are seeded
 * directly here — the point is the sync path, not the login path.
 */
describe('sync against a host that is no longer chat-recall', () => {
  const servers: HostileServer[] = [];
  afterAll(async () => { for (const s of servers) await s.close(); });

  async function syncAgainst(mode: Parameters<typeof startHostileServer>[0]): Promise<{ out: string; hits: string[] }> {
    const s = await startHostileServer(mode);
    servers.push(s);
    const { out } = await runCli(['sync'], { credentialsFor: s.url });
    return { out, hits: s.hits };
  }

  test('a plain-text 404 does not become "Unexpected non-whitespace character…"', async () => {
    const { out, hits } = await syncAgainst('text404');
    expect(hits.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/non-whitespace character after JSON/i);
    expect(out).not.toMatch(/JSON at position/i);
    // And it names the host and the fix.
    expect(out).toMatch(/404/);
    expect(out).toMatch(/chat-recall login/);
  });

  test('an HTML 200 does not become "Unexpected token \'<\'"', async () => {
    const { out, hits } = await syncAgainst('html200');
    expect(hits.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/Unexpected token/i);
    expect(out).not.toMatch(/is not valid JSON/i);
    expect(out).toMatch(/not the chat-recall API|check the URL/i);
  });

  test('a 502 is reported once, not nested inside itself', async () => {
    const { out, hits } = await syncAgainst('gateway502');
    expect(hits.length).toBeGreaterThan(0);
    // The doubled wrap: the sentence appeared twice, the second copy inside the
    // first, because the catch that handles a failed fetch also caught the
    // refusal thrown by its own !res.ok branch and described it again.
    const occurrences = out.match(/Cannot read the server-side sync rules/g)?.length ?? 0;
    expect(occurrences).toBeLessThanOrEqual(1);
    expect(out).toMatch(/502/);
  });
});

/**
 * THE READ COMMANDS, which are most of the CLI.
 *
 * `recent`, `search`, `show`, `tasks` and the rest go through five generic
 * helpers (serverGet / serverGetSoft / serverPost / serverPatch / serverDelete).
 * Each checked `!res.ok` and then called `.json()` — and a captive portal, a
 * corporate SSO wall or a parked domain answers 200 with HTML for every path it
 * does not recognise. So the status check passed and thirty-odd commands could
 * report `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, which names
 * no host, no status and no fix.
 */
describe('a read command against a host that answers 200 with HTML', () => {
  const servers: HostileServer[] = [];
  afterAll(async () => { for (const s of servers) await s.close(); });

  // `search` goes through serverPost, `status` through serverGet — the two
  // helpers every other read command is built on.
  for (const cmd of [['search', 'marker'], ['status']]) {
    test(`\`${cmd[0]}\` names what answered instead of dying in JSON.parse`, async () => {
      const s = await startHostileServer('html200');
      servers.push(s);
      const { out } = await runCli(cmd, { credentialsFor: s.url });
      expect(s.hits.length).toBeGreaterThan(0);
      expect(out).not.toMatch(/Unexpected token|is not valid JSON|JSON at position/i);
      expect(out).toMatch(/not JSON/i);
      expect(out).toMatch(/proxy|captive portal/i);
    });
  }

  test('a plain-text 404 on a read command keeps its status', async () => {
    const s = await startHostileServer('text404');
    servers.push(s);
    const { out } = await runCli(['search', 'marker'], { credentialsFor: s.url });
    expect(out).not.toMatch(/JSON at position/i);
    expect(out).toMatch(/HTTP 404/);
  });
});

describe('the Node floor', () => {
  // Reads the bundle as text, so it only applies when the artifact under test IS
  // the bundle. Against an installed binary the same guard is covered by the
  // fresh-install workflow, which runs on a pristine machine.
  test.skipIf(!CLI_IS_SCRIPT)('the CLI reads its own floor from engines, so the guard cannot drift', () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
    expect(pkg.engines?.node).toMatch(/\d+/);
    // And the guard exists in the shipped artifact, naming the version found.
    const built = readFileSync(CLI, 'utf8');
    expect(built).toMatch(/needs Node .* or newer/);
    expect(built).toMatch(/process\.versions\.node/);
  });
});
