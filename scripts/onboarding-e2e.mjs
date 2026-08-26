#!/usr/bin/env node
/**
 * THE FIRST FIVE MINUTES OF A NEW USER, reproduced exactly.
 *
 * Everything else we test starts from a machine that is already logged in, which
 * is why nobody noticed that a brand-new install could not do anything at all:
 * 27 tools advertised, every one answering "not logged in. Run `chat-recall
 * login`" — a command that `npx -y -p chat-recall chat-recall-mcp` never puts on
 * PATH. The published install pointed at a wall.
 *
 * So this harness refuses to use the repo's node_modules, the developer's HOME,
 * or a linked binary. It does what npm does:
 *
 *   1. `npm pack` the CLI — the exact tarball a release publishes
 *   2. install it into a THROWAWAY prefix, as `npm i -g` would
 *   3. run the MCP from that install, with an empty HOME and no credentials
 *   4. call a tool and read what a real user would be shown
 *   5. (optional) wait while you approve the sign-in in a browser, then prove
 *      the tools start working and report sync progress
 *
 * Steps 1-4 are automatic and assert the things that were broken. Step 5 needs a
 * human to click, so it runs only with --interactive and is the one part a CI
 * job cannot do.
 *
 *   node scripts/onboarding-e2e.mjs                 # automatic checks only
 *   node scripts/onboarding-e2e.mjs --interactive    # + click through a real signup
 *   SERVER=http://localhost:8080 node scripts/onboarding-e2e.mjs
 *
 * Exit code is the verdict.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SERVER = (process.env.SERVER || 'https://chatrecall.dev').replace(/\/+$/, '');
const INTERACTIVE = process.argv.includes('--interactive');
const REPO = process.cwd();
/** How long to wait for a human to click through the browser. */
const APPROVAL_WAIT_MS = Number(process.env.APPROVAL_WAIT_MS || 300_000);

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };
let failures = 0;
const check = (ok, msg) => { console.log(`  ${ok ? c.g('PASS') : c.r('FAIL')} ${msg}`); if (!ok) failures++; };
const step = (s) => console.log(`\n${c.b(s)}`);

/** A sandbox that shares nothing with the developer's machine. */
const ROOT = mkdtempSync(join(tmpdir(), 'cr-onboard-'));
const HOME = join(ROOT, 'home');
const PREFIX = join(ROOT, 'prefix');
execFileSync('mkdir', ['-p', HOME, PREFIX]);

/**
 * Give the sandbox a Claude Code install, because every real user of this has
 * one — they are adding an MCP to an editor they already use.
 *
 * An EMPTY home made two checks lie: `init` detects the AI tools present and
 * installs skills into each, so with none present it correctly installed zero,
 * and the harness read that as a failure. A fixture that cannot occur in the
 * field tests nothing. (Path invented, not read off this machine.)
 */
execFileSync('mkdir', ['-p',
  join(HOME, '.claude', 'projects', '-home-user-code-example'),
  join(HOME, '.claude', 'skills'),
]);

/**
 * And give it TRANSCRIPTS, because "did it sync" is the question the product
 * exists to answer and an empty home cannot answer it.
 *
 * The first version seeded only an empty project dir, so `init` synced the
 * toolkit inventory (the MCP servers and skills it registered) and zero
 * sessions — 13 rows that looked like a working sync until you read the
 * source_type. A marker unique per run is what makes the assertion exact: a hit
 * can only be THIS fixture, never a leftover from a previous run or another
 * tenant.
 */
const SYNC_MARKER = `onboardsync${Math.random().toString(36).slice(2, 10)}`;
const FIXTURE_SESSION = '11111111-2222-4333-8444-555555555555';
{
  const dir = join(HOME, '.claude', 'projects', '-home-user-code-example');
  // Two turns, in the JSONL shape the Claude backend reads: a user prompt
  // carrying the marker, and an assistant reply. Paths are invented.
  const lines = [
    { type: 'user', uuid: 'u1', sessionId: FIXTURE_SESSION, timestamp: new Date(Date.now() - 60_000).toISOString(),
      cwd: '/home/user/code/example',
      message: { role: 'user', content: `Explain the retry logic ${SYNC_MARKER}` } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: FIXTURE_SESSION, timestamp: new Date().toISOString(),
      cwd: '/home/user/code/example',
      message: { role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: `It retries three times with backoff. ${SYNC_MARKER}` }],
        usage: { input_tokens: 120, output_tokens: 40 } } },
  ];
  writeFileSync(join(dir, `${FIXTURE_SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function cleanup() { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } }

/* ── 1. pack, exactly as a release does ──────────────────────────────────── */
step('1. npm pack — the tarball a release publishes');
let tgz;
try {
  execFileSync('npx', ['tsc', '-b'], { cwd: REPO, stdio: 'ignore' });
  execFileSync('npm', ['run', 'build', '--workspace=chat-recall'], { cwd: REPO, stdio: 'ignore' });
  const out = execFileSync('npm', ['pack', '--workspace=chat-recall', '--pack-destination', ROOT], {
    cwd: REPO, encoding: 'utf-8',
  });
  const name = out.trim().split('\n').pop().trim();
  tgz = join(ROOT, name);
  check(existsSync(tgz), `packed ${name}`);
} catch (err) {
  check(false, `pack failed: ${err instanceof Error ? err.message : err}`);
  cleanup(); process.exit(1);
}

/* ── 2. install it like a user would ─────────────────────────────────────── */
step('2. install into a throwaway prefix (as `npm i -g` would)');
try {
  execFileSync('npm', ['install', '-g', '--prefix', PREFIX, tgz], { stdio: 'ignore', env: { ...process.env, HOME } });
} catch (err) {
  check(false, `install failed: ${err instanceof Error ? err.message : err}`);
  cleanup(); process.exit(1);
}
const bin = join(PREFIX, 'bin');
const bins = existsSync(bin) ? readdirSync(bin) : [];
check(bins.includes('chat-recall-mcp'), `the MCP bin is installed (${bins.join(', ') || 'none'})`);

/** The MCP entry inside that install — what a client would spawn. */
const mcpEntry = join(PREFIX, 'lib', 'node_modules', 'chat-recall', 'dist', 'mcp.js');
check(existsSync(mcpEntry), 'the installed package carries dist/mcp.js');

/* ── the MCP, driven over stdio like a real client ───────────────────────── */
function startMcp() {
  const env = {
    ...process.env,
    HOME, USERPROFILE: HOME,
    CHAT_RECALL_SERVER: SERVER,
    // A harness must never pop a browser on the developer's desktop; the link in
    // the response is the thing under test anyway.
    CHAT_RECALL_NO_BROWSER: '1',
  };
  delete env.CHAT_RECALL_TOKEN;
  const proc = spawn(process.execPath, [mcpEntry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const pending = new Map();
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let id = 0;
  return {
    rpc: (method, params) => new Promise((res, rej) => {
      const myId = ++id;
      pending.set(myId, res);
      setTimeout(() => rej(new Error(`${method} timed out`)), 60_000).unref?.();
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    }),
    notify: (method) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'),
    stop: () => proc.kill(),
  };
}

const answer = (r) => r.result?.content?.[0]?.text || r.error?.message || JSON.stringify(r.result ?? {});

async function main() {
  /* ── 3. a fresh install, no account ───────────────────────────────────── */
  step('3. first run: empty HOME, no credentials — what does a new user get?');
  const mcp = startMcp();
  try {
    await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'onboarding-e2e', version: '1' } });
    mcp.notify('notifications/initialized');

    const tools = (await mcp.rpc('tools/list', {})).result?.tools || [];
    check(tools.length > 10, `the server offers ${tools.length} tools`);

    // A human types a prompt before the first tool call; the startup priming
    // needs that moment to fetch the code. Without the wait this asserts a race,
    // not the product.
    await new Promise((r) => setTimeout(r, 3500));

    const first = answer(await mcp.rpc('tools/call', { name: 'recall_search', arguments: { query: 'anything' } }));
    console.log(c.d(first.split('\n').map((l) => `    ${l}`).join('\n')));

    // THE REGRESSION THAT MATTERS. The old message named a command that npx
    // never installs, and offered nothing else.
    check(!/Run `chat-recall login <server-url>`/.test(first),
      'the answer does NOT tell the user to run a command they do not have');
    const url = /(https?:\/\/\S*\/device\S*)/.exec(first)?.[1];
    check(!!url, `the answer carries a sign-in link (${url ? url.slice(0, 60) : 'none'})`);
    check(/\b[A-Z0-9]{6,10}\b/.test(first), 'the answer carries a device code to type');
    check(/trial/i.test(first), 'the answer says what they get (the trial)');

    // recall_smart_resume used to fail with a zod error about a missing
    // session_id — the one field a "continue where we left off" call cannot have.
    const resume = answer(await mcp.rpc('tools/call', { name: 'recall_smart_resume', arguments: {} }));
    check(!/invalid_type|Required/.test(resume),
      'recall_smart_resume with no arguments does not fail on a missing session_id');

    if (!INTERACTIVE) {
      console.log(c.d('\n  (run with --interactive to click through a real signup and prove the tools then work)'));
      return;
    }

    /* ── 4. a human approves, then the tools must work ──────────────────── */
    step('4. approve it in a browser — this is the part CI cannot do');
    console.log(`\n  ${c.b('OPEN THIS:')} ${c.b(url || SERVER + '/device')}\n`);

    // POLLED, not a keypress. Waiting on stdin means this can only be run by a
    // human sitting at a terminal — so it could not be driven by an agent, a
    // remote session, or anything that pipes stdout, which is most of the ways
    // it will actually be used. The credentials file appearing IS the approval,
    // so watch for the real signal rather than asking someone to confirm it.
    const credsPath = join(HOME, '.chat-recall', 'credentials.json');
    const deadline = Date.now() + APPROVAL_WAIT_MS;
    let approved = false;
    while (Date.now() < deadline) {
      if (existsSync(credsPath)) { approved = true; break; }
      await new Promise((r) => setTimeout(r, 2000));
      const left = Math.round((deadline - Date.now()) / 1000);
      if (left % 30 === 0 || left < 5) process.stdout.write(c.d(`  waiting for approval… ${left}s left\r`));
    }
    console.log('');
    check(approved, approved
      ? 'the sign-in was approved and credentials landed'
      : `no approval within ${Math.round(APPROVAL_WAIT_MS / 1000)}s — nothing to verify past this point`);
    if (!approved) return;

    // init keeps working after the token lands (skills, MCP registration,
    // service, first sync). Give it room before asserting what it produced.
    await new Promise((r) => setTimeout(r, 15000));
    // The whole point of spawning `init` rather than `login`: a user who only
    // logged in would have working tools and an empty account forever, because
    // nothing installs the skills, registers the MCP with their other AI tools,
    // or starts the service that ships new conversations.
    const skillDirs = ['.claude/skills', '.codex/skills', '.gemini/skills', '.config/opencode/skills', '.cursor/skills'];
    const withSkills = skillDirs.filter((d) => {
      const p = join(HOME, d);
      return existsSync(p) && readdirSync(p).some((n) => n.startsWith('chat-recall'));
    });
    check(withSkills.length > 0, `skills installed into ${withSkills.length} AI tool dir(s): ${withSkills.join(', ') || 'NONE'}`);

    check(existsSync(join(HOME, '.mcp.json')) || existsSync(join(HOME, '.claude.json')),
      'the MCP was registered with at least one AI tool');

    // Linux only — the unit lands in the sandbox HOME because systemd --user
    // reads XDG paths. On macOS this is a launchd plist; skip rather than fail.
    // NOT asserted, and the reason is worth stating: `systemctl --user` talks to
    // the real user's systemd instance over its session bus, so a unit installed
    // from this sandbox would land in the DEVELOPER's ~/.config/systemd/user and
    // fight their running daemon. A harness that installs a background service
    // on the machine running it is a harness nobody runs twice. Verify the
    // service separately with `chat-recall doctor` on a real install.
    if (process.platform === 'linux') {
      console.log(c.d('  SKIP  background service — cannot be checked from a sandbox HOME '
        + '(systemctl --user is per-real-user); verify with `chat-recall doctor`'));
    }

    // THE PAYOFF: is the planted session on the server and searchable back?
    // init syncs after login, so retry rather than asserting on the first look.
    let found = '';
    for (let i = 0; i < 12; i++) {
      found = answer(await mcp.rpc('tools/call', { name: 'recall_search', arguments: { query: SYNC_MARKER } }));
      // recall_search echoes the query in its header, so test the BODY only —
      // otherwise the echo makes every empty result look like a hit.
      if (found.split('\n').slice(1).join('\n').includes(SYNC_MARKER)) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    check(found.split('\n').slice(1).join('\n').includes(SYNC_MARKER),
      'the planted session synced and is searchable through the MCP');

    const after = answer(await mcp.rpc('tools/call', { name: 'recall_status', arguments: {} }));
    console.log(c.d(after.split('\n').slice(0, 12).map((l) => `    ${l}`).join('\n')));
    check(!/not logged in|needs one sign-in/i.test(after), 'recall_status now answers as a logged-in user');
    // An empty brand-new account is the expected state, and it must SAY so
    // rather than look broken.
    check(after.length > 0, 'recall_status returned something to read');
  } finally {
    mcp.stop();
  }
}

main()
  .then(() => {
    step(failures === 0 ? c.g('Verdict: all checks passed') : c.r(`Verdict: ${failures} check(s) failed`));
    cleanup();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(c.r(`\nharness error: ${err instanceof Error ? err.stack : err}`));
    cleanup();
    process.exit(2);
  });
