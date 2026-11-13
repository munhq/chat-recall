/**
 * Memory bound for the watch daemon (issue #16).
 *
 * The daemon is a thin collector with no local index, and its cgroup peak
 * reached 1.5 GiB. The measurement of 2026-11-13 showed that no object holds
 * the memory: a heap snapshot at 415 MB of resident anon memory held 55 MB of
 * live objects. The memory is V8 pages that V8 committed during churn and did
 * not return, plus allocator arenas.
 *
 * Two sources of churn dominate:
 *   1. one full listing of the sessions costs about 100 MB, and the daemon
 *      listed them two or three times on every sync tick;
 *   2. the code-intelligence pass collects one workspace at a time and never
 *      stops, so it adds a workspace on top of an already-full heap.
 *
 * This module gives the two bounds that stop the growth:
 *   - `isOverMemoryLimit` stops a heavy pass at a set resident size and lets the
 *     next tick continue the work, so the memory stays under the bound by
 *     construction;
 *   - `releaseMemory` returns the pages after a heavy unit (one workspace, one
 *     walk target) when the daemon runs with `--expose-gc`.
 *
 * The limit is `CHAT_RECALL_WATCH_RSS_MAX_MB`, in MiB of resident memory.
 */

/** Resident-size bound of the daemon, in MiB. */
export const DEFAULT_RSS_MAX_MB = 512;

/** Resident size of this process, in MiB. */
export function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1048576);
}

/** The bound from the environment. A bad or absent value gives the default. */
export function memoryLimitMb(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CHAT_RECALL_WATCH_RSS_MAX_MB;
  if (!raw) return DEFAULT_RSS_MAX_MB;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_RSS_MAX_MB;
}

/** True when the process is at or above the bound. */
export function isOverMemoryLimit(rss: number, limitMb: number): boolean {
  return rss >= limitMb;
}

/**
 * Return the committed pages of the garbage to the operating system.
 *
 * `global.gc` exists only with `--expose-gc`, so this is a no-op when the
 * daemon starts without it. The return value says whether a collection ran,
 * which the tests use and the log lines do not.
 */
export function releaseMemory(gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc): boolean {
  if (typeof gc !== 'function') return false;
  gc();
  return true;
}
