/**
 * When the MCP server must stop: its client closed the pipe, or the process
 * that spawned it is gone.
 *
 * The server is one process of the machine and it serves every session of
 * every AI tool, so it must outlive the client that started it, and it must
 * stop when that client is gone. The pipe closing is the normal signal. The
 * parent check covers the case where the pipe never reports EOF, because
 * another process still holds its other end after the AI tool died.
 */
import type { Readable } from 'node:stream';

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
