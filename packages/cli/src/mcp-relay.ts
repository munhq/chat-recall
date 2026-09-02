#!/usr/bin/env node
/**
 * `chat-recall-mcp` — what an AI tool actually spawns for a session.
 *
 * It speaks no protocol. It finds the daemon for this profile, starts one if
 * there is none, and moves bytes between the client's stdio and that socket.
 *
 * This file exists SEPARATELY from mcp.ts for one reason: cost. mcp.ts pulls in
 * the whole engine — the tool surface, the store, the sync client — and a
 * bundle that large costs about 100 MB of resident heap per process. Putting
 * the "should I relay?" check at the top of mcp.ts would answer it only after
 * paying that, every session. A relay that imports nothing but Node builtins
 * costs a few megabytes, and the engine is paid for once, in the daemon.
 *
 * Every failure path here falls back to loading the real server in this
 * process, which is exactly what happened before the daemon existed. A machine
 * where the socket cannot be created is slower, never broken.
 */
import { connect, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SOCKET_FLAG, daemonEnabled, ensureSocketDir, logPath, socketPath } from './mcp-socket.js';

declare const __CLI_VERSION__: string;
const VERSION = typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : '0.0.0';

/** The real server, sitting beside this bundle. */
const SERVER_URL = new URL('./mcp.js', import.meta.url);
/**
 * The same file as a path `spawn` accepts.
 *
 * `URL.pathname` is not that path on Windows: it comes back as `/C:/…`, with a
 * leading slash and percent-encoding intact, and spawning it fails. Converting
 * through `fileURLToPath` is what makes this work off POSIX.
 */
const SERVER_PATH = fileURLToPath(SERVER_URL);

/** How long to wait for a daemon we just started to answer. */
const START_TIMEOUT_MS = 15_000;
const RETRY_MS = 100;

/**
 * Load the full server into THIS process and serve the session from here.
 *
 * The specifier is a runtime value so the bundler leaves it as a real dynamic
 * import instead of inlining mcp.js into the relay — which would restore the
 * whole cost this file exists to avoid.
 */
async function serveInProcess(): Promise<void> {
  const spec = SERVER_URL.href;
  await import(spec);
}

function tryConnect(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const sock = connect(path);
    const give_up = () => {
      sock.destroy();
      resolve(null);
    };
    sock.once('connect', () => {
      sock.removeListener('error', give_up);
      resolve(sock);
    });
    sock.once('error', give_up);
  });
}

/**
 * Start the daemon and leave it running.
 *
 * Detached on purpose. Its stdio must not be this session's — that is a live
 * JSON-RPC channel — and its own process group means a Ctrl+C aimed at the
 * session that happened to start it does not take the daemon away from every
 * other session.
 *
 * The daemon is told WHERE to listen rather than left to work it out. This
 * relay already resolved a runtime directory and is about to wait on that exact
 * path; a daemon that resolved again could pick a different candidate if the
 * environment shifted between the two processes, and the relay would then wait
 * out its whole timeout on a socket that never appears.
 */
function startDaemon(dir: string, sock: string): ChildProcess | null {
  try {
    let err: number | 'ignore' = 'ignore';
    try {
      err = openSync(logPath(dir, VERSION), 'a');
    } catch {
      /* a log we cannot open is not worth failing the launch over */
    }
    const child = spawn(process.execPath, [SERVER_PATH, '--daemon', SOCKET_FLAG, sock], {
      detached: true,
      stdio: ['ignore', 'ignore', err],
      env: process.env,
    });
    child.unref();
    return child;
  } catch {
    return null;
  }
}

/** Move bytes both ways until either side closes. */
function relay(sock: Socket): void {
  process.stdin.pipe(sock);
  sock.pipe(process.stdout);

  const done = (code: number) => {
    try {
      sock.destroy();
    } catch {
      /* already gone */
    }
    process.exit(code);
  };

  // The client closed our stdin: the session is over. Tell the daemon so it can
  // retire this connection rather than hold it open for a client that has gone.
  process.stdin.on('end', () => sock.end());
  sock.on('close', () => done(0));
  sock.on('error', () => done(0));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!daemonEnabled()) {
    await serveInProcess();
    return;
  }

  let dir: string;
  let path: string;
  try {
    dir = ensureSocketDir();
    path = socketPath(dir, VERSION);
  } catch {
    await serveInProcess();
    return;
  }

  const existing = await tryConnect(path);
  if (existing) {
    relay(existing);
    return;
  }

  const child = startDaemon(dir, path);
  if (!child) {
    await serveInProcess();
    return;
  }

  // The daemon listens before it does any of its startup work, so this waits
  // for a process to exist, not for an index to be ready.
  //
  // It also stops waiting the moment the daemon is gone. A daemon exits early
  // for two reasons: a sibling won the race to the same path (then the next
  // connect succeeds and the session relays onto the sibling), or it could not
  // bind at all (then nothing will ever answer, and every further tick of this
  // loop is a stall the session pays for nothing).
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(RETRY_MS);
    const sock = await tryConnect(path);
    if (sock) {
      relay(sock);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const sibling = await tryConnect(path);
      if (sibling) {
        relay(sibling);
        return;
      }
      break;
    }
  }

  console.error('[mcp] no daemon answered; serving this session in-process');
  await serveInProcess();
}

main().catch(async (err) => {
  console.error('[mcp] relay failed, serving in-process:', err?.message ?? err);
  try {
    await serveInProcess();
  } catch (inner) {
    console.error('[mcp] could not start the server at all:', inner);
    process.exit(1);
  }
});
