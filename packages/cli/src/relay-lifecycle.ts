/**
 * When a stdio MCP process must stop: its client closed the pipe, or the
 * process that spawned it is gone.
 *
 * Imported by the relay, so it may use Node builtins only.
 *
 * A relay holds one connection on its daemon, and a daemon exits only when it
 * has had none for CHAT_RECALL_DAEMON_IDLE_SECS. So one relay that outlives its
 * session keeps a whole daemon — and every version-specific engine it loaded —
 * resident for as long as that relay runs. The pipe closing is the normal
 * signal. The parent check covers the case where the pipe never reports EOF,
 * because another process still holds its other end after the AI tool died.
 */
import type { Duplex, Readable, Writable } from 'node:stream';

/** How often the parent is checked. The timer is unref'd and costs one syscall. */
export const PARENT_POLL_MS = 5_000;

export interface ParentProbe {
  /** The current parent pid. `process.ppid` is read live on every access. */
  ppid(): number;
  /** Whether a process with this pid exists. */
  alive(pid: number): boolean;
}

/** `kill(pid, 0)` sends nothing and fails with ESRCH when the pid is gone. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists and belongs to someone else. That is alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const processProbe: ParentProbe = {
  ppid: () => process.ppid,
  alive: pidAlive,
};

/**
 * Whether the process that spawned us has gone.
 *
 * On Linux and macOS an orphan is re-parented, so its ppid changes (to 1, or to
 * a subreaper). Windows keeps the original ppid on an orphan, so the pid itself
 * is probed as well.
 */
export function parentGone(originalPpid: number, probe: ParentProbe): boolean {
  if (probe.ppid() !== originalPpid) return true;
  return !probe.alive(originalPpid);
}

/**
 * Call `onGone` once, when the parent that spawned this process is gone.
 * Returns a function that stops the watch.
 *
 * A process that started with pid 1 as its parent was never spawned by a
 * session (it was started by init or a service manager), so there is no
 * parent to lose and no watch is set.
 */
export function watchParent(
  onGone: () => void,
  opts: { probe?: ParentProbe; intervalMs?: number } = {},
): () => void {
  const probe = opts.probe ?? processProbe;
  const original = probe.ppid();
  if (original <= 1) return () => {};
  const timer = setInterval(() => {
    if (!parentGone(original, probe)) return;
    clearInterval(timer);
    onGone();
  }, opts.intervalMs ?? PARENT_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Call `onEnd` once, when the client's side of stdio is finished.
 *
 * 'end' is the clean EOF. 'close' without 'end' and 'error' are the same fact
 * reported by a pipe that broke: nothing more will ever arrive on it.
 */
export function onInputFinished(input: Readable, onEnd: () => void): void {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    onEnd();
  };
  input.once('end', fire);
  input.once('close', fire);
  input.once('error', fire);
}

/**
 * Move bytes both ways between the client's stdio and the daemon socket, and
 * call `exit` exactly once when the session is over.
 *
 * The session is over when the daemon closes the socket, when the client's
 * input finishes, or when the parent is gone. On input EOF the socket is
 * half-closed first, so a reply the daemon is still writing reaches the
 * client; the daemon's server closes its side on that EOF, which ends here as
 * the socket's 'close'. A daemon that does not close within `drainMs` is not
 * waited on any longer.
 */
export function bridge(
  input: Readable,
  output: Writable,
  sock: Duplex,
  exit: (code: number) => void,
  opts: { drainMs?: number; probe?: ParentProbe; parentPollMs?: number } = {},
): void {
  let done = false;
  let stopParentWatch: () => void = () => {};
  const finish = () => {
    if (done) return;
    done = true;
    stopParentWatch();
    try {
      sock.destroy();
    } catch {
      /* already gone */
    }
    exit(0);
  };

  input.pipe(sock);
  sock.pipe(output);

  sock.on('close', finish);
  sock.on('error', finish);
  // A client that is gone cannot read stdout. Writing to it is EPIPE, which
  // must end the session instead of throwing out of the event loop.
  output.on('error', finish);

  onInputFinished(input, () => {
    try {
      sock.end();
    } catch {
      finish();
      return;
    }
    const t = setTimeout(finish, opts.drainMs ?? 2_000);
    t.unref?.();
  });

  stopParentWatch = watchParent(finish, { probe: opts.probe, intervalMs: opts.parentPollMs });
}

/** JSON-RPC id as a map key: ids may be numbers or strings, and 1 is not "1". */
const idKey = (id: unknown): string => JSON.stringify(id);

interface RpcHead { id?: unknown; method?: unknown }

function peek(line: string): RpcHead | null {
  try {
    const m = JSON.parse(line) as RpcHead;
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

/** Calls up to newline-delimited lines; the remainder waits for the next chunk. */
function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  const decoder = new TextDecoder('utf-8');
  let rest = '';
  return (chunk) => {
    rest += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl = rest.indexOf('\n');
    while (nl >= 0) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (line.trim()) onLine(line);
      nl = rest.indexOf('\n');
    }
  };
}

/** The error a client gets for a call that was running when its daemon went away. */
export const DAEMON_RESTART_ERROR = 'chat-recall restarted while this call ran. Call the tool again.';

/**
 * Like `bridge`, but the session survives its daemon.
 *
 * A daemon goes away when it is upgraded or killed. `bridge` then ended the
 * relay, and the AI tool showed the server as disconnected until a person
 * reconnected it by hand. Here the relay connects again (`reconnect` starts a
 * daemon when none answers), replays the client's `initialize` request and
 * `notifications/initialized`, drops the new daemon's reply to that replay,
 * and goes on.
 *
 * A request that had no reply when the daemon went away gets a JSON-RPC error
 * that says to call again. Sending it again could run a write twice.
 *
 * The session is over when the client's input finishes, when the parent is
 * gone, when output fails, or when no daemon can be reached again.
 */
export function resilientBridge(
  input: Readable,
  output: Writable,
  first: Duplex,
  reconnect: () => Promise<Duplex | null>,
  exit: (code: number) => void,
  opts: { drainMs?: number; probe?: ParentProbe; parentPollMs?: number } = {},
): void {
  let done = false;
  let inputEnded = false;
  let sock: Duplex | null = null;
  /** Client lines held while no daemon is ready for them. */
  let queue: string[] = [];
  /** The replayed `initialize` request whose reply the client must not see. */
  let replayId: string | null = null;
  let initLine: string | null = null;
  let initializedLine: string | null = null;
  const pending = new Set<string>();
  let stopParentWatch: () => void = () => {};

  const finish = (code = 0) => {
    if (done) return;
    done = true;
    stopParentWatch();
    try { sock?.destroy(); } catch { /* already gone */ }
    exit(code);
  };

  const toClient = (line: string) => {
    try { output.write(line + '\n'); } catch { finish(); }
  };

  const fromClient = (line: string) => {
    const m = peek(line);
    if (m?.method === 'initialize') initLine = line;
    else if (m?.method === 'notifications/initialized') initializedLine = line;
    if (m && m.id !== undefined && typeof m.method === 'string') pending.add(idKey(m.id));
    if (sock && replayId === null) sock.write(line + '\n');
    else queue.push(line);
  };

  const attach = (s: Duplex) => {
    sock = s;
    const onLine = lineSplitter((line) => {
      if (s !== sock) return;
      const m = peek(line);
      const isReply = m && m.id !== undefined && m.method === undefined;
      if (isReply && replayId !== null && idKey(m!.id) === replayId) {
        replayId = null;
        if (initializedLine) s.write(initializedLine + '\n');
        const held = queue;
        queue = [];
        for (const l of held) s.write(l + '\n');
        return;
      }
      if (isReply) pending.delete(idKey(m!.id));
      toClient(line);
    });
    s.on('data', onLine);
    s.on('error', () => { /* 'close' follows and handles it */ });
    s.on('close', () => { if (s === sock) void lost(); });
  };

  const lost = async () => {
    sock = null;
    if (done) return;
    if (inputEnded) { finish(); return; }
    for (const key of pending) {
      toClient(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(key), error: { code: -32000, message: DAEMON_RESTART_ERROR } }));
    }
    pending.clear();
    const next = await reconnect().catch(() => null);
    if (done) { try { next?.destroy(); } catch { /* gone */ } return; }
    if (!next) { finish(1); return; }
    if (initLine) {
      replayId = idKey(peek(initLine)?.id);
      attach(next);
      next.write(initLine + '\n');
    } else {
      attach(next);
      const held = queue;
      queue = [];
      for (const l of held) next.write(l + '\n');
    }
  };

  attach(first);
  input.on('data', lineSplitter(fromClient));
  output.on('error', () => finish());

  onInputFinished(input, () => {
    inputEnded = true;
    if (!sock) { finish(); return; }
    try { sock.end(); } catch { finish(); return; }
    const t = setTimeout(() => finish(), opts.drainMs ?? 2_000);
    t.unref?.();
  });

  stopParentWatch = watchParent(() => finish(), { probe: opts.probe, intervalMs: opts.parentPollMs });
}
