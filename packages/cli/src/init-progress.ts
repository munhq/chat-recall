/**
 * ONE LINE for the first sync, and a hand-off when it is long.
 *
 * ── What this replaces ────────────────────────────────────────────────────
 * `init` step 5 was `await syncSessions()`. Two problems, both reported by a
 * user on a 15,748-session machine:
 *
 *   1. It BLOCKED for minutes, while step 6 went on to explain that background
 *      sync runs via the MCP anyway — so the wait bought nothing but a wait.
 *   2. It printed the daemon's log to the terminal. `sync-client.ts` has 18
 *      `[sync] …` console.error calls written for a log file nobody tails, and
 *      onboarding inherited every one of them, including
 *      "01758d3f… is 115MB (over the 64MB ceiling)" — true, and none of a new
 *      user's business.
 *
 * Running the sync as a DETACHED CHILD fixes both at once: its stdio is
 * discarded, so the log cannot reach the terminal by construction, and it
 * survives `init` exiting, so a long walk continues without holding anyone up.
 *
 * Progress needs no new plumbing. `sync-client.ts` already calls
 * `reportWalkProgress()` into the collector-health file on every walk; this
 * polls that file. So the bar reflects the real walk, not an estimate.
 */
import { spawn } from 'node:child_process';

export interface WalkSnapshot {
  done: number;
  total: number;
  complete: boolean;
}

/** A fixed-width bar. Pure, so the rendering is pinned by tests. */
export function renderBar(done: number, total: number, width = 12): string {
  if (total <= 0) return '░'.repeat(width);
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** `1,240/15,748` — grouped, because five- and six-digit counts are unreadable raw. */
export function renderCount(done: number, total: number): string {
  const n = (x: number) => x.toLocaleString('en-US');
  return `${n(done)}/${n(total)}`;
}

/**
 * The one line shown while a walk is in flight, or the one line shown when it
 * is handed off / finished. Kept pure and separate from the polling so the exact
 * wording is testable — the whole point of this change is the wording.
 */
export function progressLine(snap: WalkSnapshot | null): string {
  if (!snap || snap.total <= 0) return 'starting…';
  if (snap.complete) return `${renderCount(snap.done, snap.total)} indexed`;
  return `${renderBar(snap.done, snap.total)}  ${renderCount(snap.done, snap.total)}`;
}

export function handOffLine(snap: WalkSnapshot | null): string {
  const where = snap && snap.total > 0
    ? `${renderCount(snap.done, snap.total)} so far`
    : 'started';
  return `${where} — continuing in the background`;
}

export interface FirstSyncDeps {
  /** Current walk state, or null when none has been reported yet. */
  readProgress: () => WalkSnapshot | null;
  /** Draw the single line, in place. */
  draw: (text: string) => void;
  /** Start the detached worker. Returns a stop handle for tests. */
  startWorker: () => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How long to watch before handing off. */
  handOffAfterMs?: number;
  pollMs?: number;
}

export interface FirstSyncOutcome {
  /** True when the walk reported `complete` before the hand-off deadline. */
  finished: boolean;
  snapshot: WalkSnapshot | null;
}

/**
 * Start the sync, watch it on ONE line, and stop watching at the deadline.
 *
 * Never kills the worker — handing off means letting it run, not cancelling it.
 * The caller prints the final line, because only it knows the surrounding
 * layout.
 */
export async function watchFirstSync(deps: FirstSyncDeps): Promise<FirstSyncOutcome> {
  const handOffAfterMs = deps.handOffAfterMs ?? 20_000;
  const pollMs = deps.pollMs ?? 400;
  const started = deps.now();
  deps.startWorker();

  let snap: WalkSnapshot | null = null;
  for (;;) {
    snap = deps.readProgress();
    if (snap?.complete) return { finished: true, snapshot: snap };
    if (deps.now() - started >= handOffAfterMs) return { finished: false, snapshot: snap };
    deps.draw(progressLine(snap));
    await deps.sleep(pollMs);
  }
}

/**
 * Spawn `<this cli> sync` fully detached, stdio discarded.
 *
 * `stdio: 'ignore'` is the half that silences the daemon log; `detached` +
 * `unref` is the half that lets a long walk outlive `init`. `argv[1]` rather
 * than a resolved package path, so a dev checkout, a global install and a
 * user-prefix install all re-invoke the binary that is actually running.
 */
export function spawnDetachedSync(extraArgs: string[] = []): void {
  const entry = process.argv[1];
  if (!entry) return;
  const child = spawn(process.execPath, [entry, 'sync', ...extraArgs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}
