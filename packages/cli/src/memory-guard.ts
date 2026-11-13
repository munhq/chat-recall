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
 *     walk target) when the daemon runs with `--expose-gc`;
 *   - `reclaimCgroup` takes back the page cache of the cgroup when a heavy pass
 *     ends, because the page cache of the pass counts in the cgroup peak.
 *
 * The limit is `CHAT_RECALL_WATCH_RSS_MAX_MB`, in MiB of resident memory.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Absolute bound of the daemon, in MiB. The systemd unit throttles at
 * MemoryHigh=1G, so a pass stops before the cgroup reaches it.
 */
export const DEFAULT_RSS_MAX_MB = 896;

/** Memory that one pass may add above the size it started at, in MiB. */
export const DEFAULT_GROWTH_MAX_MB = 256;

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

/** The growth bound of one pass from the environment. A bad or absent value gives the default. */
export function growthLimitMb(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CHAT_RECALL_WATCH_GROWTH_MAX_MB;
  if (!raw) return DEFAULT_GROWTH_MAX_MB;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_GROWTH_MAX_MB;
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

/** The cgroup v2 directory of this process, or null when it has none. */
export function cgroupDir(cgroupFile = '/proc/self/cgroup'): string | null {
  let text: string;
  try { text = readFileSync(cgroupFile, 'utf8'); } catch { return null; }
  const line = text.split('\n').find((l) => l.startsWith('0::'));
  if (!line) return null;
  return `/sys/fs/cgroup${line.slice(3).trim()}`;
}

/** One key of `memory.stat`, in MiB, or null when it cannot be read. */
export function memoryStatMb(dir: string, key: string): number | null {
  let text: string;
  try { text = readFileSync(join(dir, 'memory.stat'), 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    const [name, value] = line.split(' ');
    if (name === key && value) return Math.round(Number(value) / 1048576);
  }
  return null;
}

/**
 * Ask the kernel to take back the page cache of this cgroup, and keep a floor.
 *
 * The pages are reclaimable, but they count in `memory.current` and in the
 * cgroup peak. After a code-intelligence pass over 50 workspaces the watch unit
 * held 775 MB of file pages, and that page cache was most of a 1.4 GiB peak
 * while the live heap was small. The write needs no privilege when the user owns
 * the cgroup. A failure is not an error: the kernel reclaims under pressure
 * anyway, so this only makes the peak smaller sooner.
 */
export function reclaimCgroup(keepFileMb = 64, dir: string | null = cgroupDir()): boolean {
  if (!dir) return false;
  const fileMb = memoryStatMb(dir, 'file');
  if (fileMb === null) return false;
  const reclaimMb = Math.floor(fileMb - keepFileMb);
  if (reclaimMb <= 0) return false;
  try { writeFileSync(join(dir, 'memory.reclaim'), `${reclaimMb}M`); return true; } catch { return false; }
}

/** `memory.current` of the cgroup in MiB, or null when it cannot be read. */
export function cgroupCurrentMb(dir: string | null = cgroupDir()): number | null {
  if (!dir) return null;
  try {
    const n = Number(readFileSync(join(dir, 'memory.current'), 'utf8').trim());
    return Number.isFinite(n) ? Math.round(n / 1048576) : null;
  } catch { return null; }
}

/**
 * The memory this daemon holds, in MiB, as the bound must see it.
 *
 * `process.memoryUsage().rss` sees only the daemon's own pages. A code pass
 * spawns the `codeindex` child in the same cgroup and reads whole workspaces,
 * so the file pages and the child's pages count in the cgroup peak but not in
 * the rss. This returns the larger of the two, so the pass pauses on the number
 * the unit is killed for.
 */
export function usedMb(rss = rssMb(), cgroup = cgroupCurrentMb()): number {
  return cgroup !== null && cgroup > rss ? cgroup : rss;
}

/** What one pass may use: the size at its start, the growth it may add, and the absolute bound. */
export interface MemoryBudget {
  baselineMb: number;
  growthMb: number;
  hardMb: number;
}

/**
 * Take the budget of a pass at its start.
 *
 * A daemon that idles at 560 MB must still do work. The pass measures what it
 * ADDS above the size it started at, so the idle size of the daemon does not
 * decide whether a pass can run. The absolute bound still stops a pass that
 * starts high and grows.
 */
export function startBudget(
  used: number = usedMb(),
  env: Record<string, string | undefined> = process.env,
): MemoryBudget {
  return { baselineMb: used, growthMb: growthLimitMb(env), hardMb: memoryLimitMb(env) };
}

/**
 * True when a pass must pause before its next unit of work.
 *
 * `unitsDone` is the number of sessions or workspaces the pass has built so far.
 * A pass builds at least one unit: a pass that pauses before its first unit does
 * no work, and the next tick meets the same size and pauses again, so the work
 * never advances and every tick pays for the listing and the release.
 */
export function shouldPause(used: number, budget: MemoryBudget, unitsDone: number): boolean {
  if (unitsDone <= 0) return false;
  return used >= budget.hardMb || used - budget.baselineMb >= budget.growthMb;
}
