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
