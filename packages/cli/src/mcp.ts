#!/usr/bin/env node
/**
 * `chat-recall-mcp` — the STDIO entry point.
 *
 * The 55 tools themselves live in @chat-recall/engine/mcp/tools.js, because two
 * hosts now serve them: this process (one user, their own machine, spawned by
 * their AI tool) and the server's remote /mcp endpoint (many users at once, over
 * OAuth). Keeping the surface in one place is what stops those two drifting into
 * different products.
 *
 * What stays HERE is everything that is true only of a local process:
 *
 *   - the stdio transport,
 *   - the crash guards, because this process also runs background sync in the
 *     same event loop and a stray rejection there must not drop the tools,
 *   - the background sync loop itself, which reads this machine's transcripts,
 *   - skills delivery into this machine's AI tools,
 *   - the indexer child, which shells out to this package's own cli.js.
 *
 * The last two are handed to the tool surface through setIndexRunner() and
 * setEventReporter() rather than imported by it, so the engine never reaches
 * back into the CLI package.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'node:url';
import {
  createMcpServer, setIndexRunner, setEventReporter, setUpdateNotice, setServerVersion,
} from '@chat-recall/engine/mcp/tools.js';
import { setLoginStarter, type LoginPrompt } from '@chat-recall/engine/mcp/login-prompt.js';
import { openBrowser } from './open-browser.js';
import { readFileSync } from 'node:fs';
import { reportClientEvent } from './client-events.js';
import { updateNotice } from './update-notice.js';

// Wire the host hooks BEFORE the transport accepts a call, so no early request
// can see a half-configured surface.
// The version a caller sees is THIS package's, read from the manifest that
// ships beside dist/. The engine cannot resolve it — its own manifest carries a
// different version — so the host that knows states it.
setServerVersion(JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
).version);
setEventReporter(reportClientEvent);
setIndexRunner(runIndexChild);
setUpdateNotice(updateNotice);
setLoginStarter(startLoginChild);

/**
 * Background freshness loop — the architecture's writer. The binary IS the
 * MCP + indexer + sync; there is no separate daemon to install on any OS.
 * Claude Code spawns this process for every session (Windows/macOS/Linux
 * alike, via mcp.json), so it runs exactly while the user works — which is
 * exactly when transcripts change. Each tick pushes the incremental delta
 * via syncIncremental(); the index-lock elects ONE writer among concurrent
 * sessions' MCP processes; the settings watermark makes ticks idempotent.
 * Not logged in → no-op. The 15s startup tick flushes whatever the
 * previous session left behind.
 */
/**
 * Run `chat-recall index` in a CHILD process so a large collect can never OOM
 * the MCP tool server. The child (dist/cli.js) has its own heap; if it dies
 * (OOM/kill), we report it and the MCP stays up serving tools. Strips ANSI,
 * returns the child's summary line(s).
 */
/**
 * Start a device-code sign-in and return the prompt as soon as the server issues
 * it, leaving the child to poll for approval.
 *
 * IN A CHILD PROCESS, and that is not incidental: runLogin() calls
 * process.exit(1) on around seven different failures. In-process, any one of
 * them would take THIS server down mid-session — the stdio connection drops, the
 * client sees -32000, and every recall tool is deregistered. Same reasoning as
 * runIndexChild below.
 *
 * Spawned as `node <this package>/dist/cli.js`, not `chat-recall`, because the
 * published install is `npx -y -p chat-recall chat-recall-mcp` and puts nothing
 * on PATH — the whole reason a new user could not log in at all.
 *
 * The child writes ~/.chat-recall/credentials.json when the user approves, which
 * is how the next tool call picks the login up: nothing needs to be handed back
 * through this promise.
 */
function startLoginChild(server: string): Promise<LoginPrompt> {
  return new Promise((resolve, reject) => {
    let cliPath: string;
    try { cliPath = fileURLToPath(new URL('./cli.js', import.meta.url)); }
    catch { reject(new Error('could not locate the CLI entry point')); return; }

    // `init`, NOT `login`. Logging in alone leaves the user with working tools
    // and an empty account: nothing installs the skills, registers the MCP with
    // their other AI tools, or starts the background service that ships new
    // conversations — so every tool would answer "no sessions yet" forever.
    // init does all of it and then syncs, which is the difference between
    // "connected" and "useful".
    //
    // --yes because there is no terminal here to pause for confirmation. init
    // still prints its scope summary, and the message we return names the
    // controls (recall_exclude_path, `chat-recall exclude`) so narrowing is one
    // sentence away rather than buried in a console nobody read.
    const child = spawn(process.execPath, [cliPath, 'init', '--server', server, '--prompt-json', '--yes'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Outlives this call by design: it polls until the user approves. Detached
      // so a client that restarts the MCP does not abort a sign-in the user is
      // halfway through in their browser.
      detached: true,
    });
    child.unref();

    let out = '';
    let settled = false;
    const fail = (msg: string) => { if (!settled) { settled = true; reject(new Error(msg)); } };

    child.stdout?.on('data', (d) => {
      if (settled) return;
      out += d;
      // The prompt arrives as one JSON line; anything else on stdout is noise.
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(t) as { prompt?: LoginPrompt };
          if (parsed.prompt?.url) {
            settled = true;
            // Convenience only — the URL is also in the message the agent shows,
            // because an MCP can be running where no browser exists.
            openBrowser(parsed.prompt.url);
            resolve(parsed.prompt);
            return;
          }
        } catch { /* partial line — wait for more */ }
      }
    });
    child.on('error', (e) => fail(e.message));
    child.on('exit', (code) => fail(`login helper exited (${code ?? 'signal'}) before issuing a code`));
    // The device code itself is valid for ten minutes; if the server has not
    // even issued one in thirty seconds, something is wrong with the server.
    const timer = setTimeout(() => fail('the server did not issue a device code in time'), 30_000);
    timer.unref?.();
  });
}

function runIndexChild(force: boolean): Promise<string> {
  return new Promise((resolve) => {
    let cliPath: string;
    try { cliPath = fileURLToPath(new URL('./cli.js', import.meta.url)); }
    catch { resolve('Index unavailable: could not locate the CLI entry point.'); return; }

    const args = [cliPath, 'index'];
    if (force) args.push('--force');
    let out = '', err = '', done = false;
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').trim();
    const finish = (msg: string) => { if (!done) { done = true; resolve(msg); } };

    const child = spawn(process.execPath, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish('Indexing a large history is still running in the background — it finishes on its own, and the watch daemon syncs continuously regardless.');
    }, 10 * 60_000);
    timer.unref?.();
    child.on('error', (e) => { clearTimeout(timer); finish(`Could not start indexer: ${e.message}`); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        finish(strip(out).split('\n').filter(Boolean).slice(-3).join('\n') || 'Collected + shipped to your chat-recall server.');
      } else {
        // A child killed by a signal reports code === null, so `code` alone
        // yields the useless "exited with code null". Name the signal instead —
        // that string was seen in the field and told us nothing about the cause
        // (it is NOT the OOM path below, which says so explicitly).
        const reason = signal === 'SIGKILL' || code === 134
          ? 'ran out of memory (very large history)'
          : signal
            ? `was killed by ${signal}`
            : `exited with code ${code}`;
        const last = strip(err).split('\n').filter(Boolean).pop() || '';
        finish(`Indexer ${reason}. The watch daemon keeps syncing in the background, so your history still ships incrementally. ${last}`.trim());
      }
    });
  });
}

const SYNC_TICK_MS = 3 * 60_000;
function startBackgroundSync(): void {
  const tick = async (scope: 'full' | 'changed') => {
    try {
      // syncIncremental() takes the single sync lock itself (see docs/SYNC.md)
      // and no-ops if another writer holds it — so concurrent sessions' MCP
      // ticks (and any other caller) serialize on ONE writer. No outer lock
      // here: double-acquiring would make the inner call always skip.
      const { syncIncremental } = await import('./sync-client.js');
      await syncIncremental({ scope });
    } catch (err) {
      console.error('[mcp] background sync tick failed:', err instanceof Error ? err.message : err);
    }
  };
  // Startup tick: FULL ledger walk — flushes whatever the previous session
  // left behind, including sessions whose earlier sync failed. Interval
  // ticks: 'changed' — bounded recent-mtime walk. A full walk lists ALL
  // ~30k+ sessions; doing that every 3 minutes in EVERY session's MCP
  // process was a main driver of multi-hundred-MB MCP RSS. Old failed
  // sessions still converge via each new session's startup tick and the
  // watch daemon's 15-min heartbeat.
  setInterval(() => { void tick('changed'); }, SYNC_TICK_MS).unref();
  setTimeout(() => { void tick('full'); }, 15_000).unref();

  // Keep the update probe warm and SAY it once per process. updateNotice()
  // reads a cached file, so without something refreshing it an MCP-only user's
  // cache is written by nobody and the warning never fires. The refresh itself
  // is throttled to 6h inside refreshUpdateCheck().
  const updateTick = async (): Promise<void> => {
    try {
      const { refreshUpdateCheck, updateNotice } = await import('./update-notice.js');
      await refreshUpdateCheck();
      const notice = updateNotice();
      if (notice) console.error(`[mcp] ${notice}`);
    } catch { /* never block or fail the server over a version check */ }
  };
  setTimeout(() => { void updateTick(); }, 20_000).unref();
  setInterval(() => { void updateTick(); }, 6 * 60 * 60 * 1000).unref();
}

// ── Crash guards ────────────────────────────────────────────────────────
// This process serves the recall tools AND runs the background sync/indexer
// in the same event loop. Without these, a single stray rejection or throw in
// the sync path (a bad transcript, a dropped socket, a batcher error) takes
// down the WHOLE process — and the client loses EVERY recall tool mid-session
// ("tools no longer load"). The tool handlers already have per-call try/catch,
// so nothing a caller awaits is swallowed here; this only stops background
// faults from killing tool-serving. Log loudly to stderr and stay up.
function installCrashGuards(): void {
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    console.error('[mcp] unhandledRejection (server stays up):', msg);
    reportClientEvent('mcp_unhandled', { message: msg }); // so the operator sees it
  });
  process.on('uncaughtException', (err) => {
    console.error('[mcp] uncaughtException (server stays up):', err.stack || err.message);
    reportClientEvent('mcp_crash', { message: err.stack || err.message });
  });
}

async function main() {
  installCrashGuards();
  // NOTE on heap bounding: v8.setFlagsFromString('--max-old-space-size=…')
  // does NOT take effect after startup (verified empirically on Node 23) —
  // the cap must come from the spawner. `chat-recall init` writes
  // NODE_OPTIONS into the MCP registration for exactly that reason; the
  // in-process defense is the bounded 'changed' sync ticks above.
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);

  // Deliver the chat-recall skills to this machine's AI tools. This is THE
  // delivery hook that works no matter how the MCP was configured — `chat-recall
  // init`, CLI auto-update, the Claude plugin, or an MCP-store / hand-written
  // .mcp.json entry: whenever the MCP process runs, it refreshes the skills.
  // Version-gated (only writes when the bundled version differs from what's
  // installed) + marker-guarded (only ever touches chat-recall-* skills) +
  // best-effort (skills are a nicety; never break or block the tool server).
  void (async () => {
    try {
      const m = await import('./install-skills.js');
      if (m.skillsNeedRefresh()) {
        const r = m.installSkills();
        const n = r.perTarget.reduce((s, t) => s + t.installed.length, 0);
        if (n > 0) console.error(`[mcp] chat-recall skills refreshed into local AI tools (${n} file group(s), v${r.version})`);
      }
    } catch { /* best-effort — never break the tool server over skills */ }
  })();

  // The watch daemon owns continuous sync. When it's running, the MCP must NOT
  // also run the heavy sync in its tool-serving event loop: a full-ledger walk
  // over a large history (30k+ sessions — transcript parse + base64 + KG
  // extraction) spikes memory and can OOM/kill THIS process, which drops the
  // JSON-RPC stdio connection (client sees -32000) and deregisters every recall
  // tool mid-session. Decoupling keeps the tool server lightweight and alive.
  // A machine with NO credentials at all is a fresh install, and its first tool
  // call is going to need a sign-in link. Fetching the device code takes a few
  // hundred ms against the server, and requireRemote() is synchronous (51 call
  // sites), so asking for it lazily means the first call can only say "starting,
  // ask again". Start it here instead: by the time a human has typed a prompt,
  // the link is ready and the FIRST answer carries it.
  //
  // Only when nothing is configured — a self-host or offline user who has
  // deliberately not logged in must not have a sign-in started for them on
  // every boot, and someone already logged in obviously needs none of this.
  try {
    const { loadAllCredentials } = await import('./sync-client.js');
    if (loadAllCredentials().length === 0 && !process.env.CHAT_RECALL_TOKEN) {
      const { loginInstruction } = await import('@chat-recall/engine/mcp/login-prompt.js');
      loginInstruction();   // fire-and-forget: primes the prompt, never throws
    }
  } catch { /* best-effort — the lazy path still works */ }

  let daemonRunning = false;
  try {
    const { isServiceRunning } = await import('./service-installer.js');
    daemonRunning = isServiceRunning();
  } catch { /* detection best-effort; fall through to running sync */ }
  if (daemonRunning) {
    console.error('[mcp] watch daemon active — MCP will not run background sync (keeps the tool server lightweight; the daemon syncs).');
  } else {
    startBackgroundSync();
  }
}

main().catch(console.error);
