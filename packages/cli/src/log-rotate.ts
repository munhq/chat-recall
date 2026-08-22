/**
 * Bound the daemon's log file without destroying it.
 *
 * ── Why this is its own module ────────────────────────────────────────────
 * The rule here is one line of code and was wrong for months, in a way no test
 * could catch while it lived inside the daemon entry module. It lives here so a
 * test can drive the real function — the same lesson the task-board tests taught:
 * a test that re-implements the rule passes while the shipped rule is broken.
 *
 * ── The rule: COPY, THEN TRUNCATE IN PLACE. NEVER RENAME. ─────────────────
 * A rename looks safe at startup and is not. Every supervisor that redirects our
 * output opens the log and hands us the fd BEFORE our first line runs — systemd
 * `StandardOutput=append:`, launchd `StandardOutPath`, the Windows task's `>>`.
 * By the time rotation runs, our own stdout already points at that inode.
 * Renaming the path leaves every writer appending to the renamed file, while the
 * path the CLI, `chat-recall doctor` and the user all tail no longer exists.
 *
 * That is not theory. On the maintainer's machine `/proc/<pid>/fd/1` resolved to
 * `watch.log.1`, `watch.log` was absent, the "rotated" file had grown back to
 * 47.6 MB unbounded, and eight hours of a wedged daemon left NOTHING in the place
 * anyone looks. Rotation was silently deleting the log it existed to keep.
 *
 * Truncating keeps the inode, so every open fd stays valid and the next line
 * lands at offset 0. All three redirections we write are append-mode, which is
 * what makes that offset correct.
 */
import { statSync, copyFileSync, truncateSync } from 'fs';

/** Rotate above this size. Two generations at 32 MB bounds the log at ~64 MB. */
export const LOG_MAX_BYTES = 32 * 1024 * 1024;

export interface RotateResult {
  rotated: boolean;
  /** Size at rotation, in bytes. 0 when nothing was rotated. */
  sizeBefore: number;
}

/**
 * Rotate `logPath` if it exceeds `maxBytes`.
 *
 * Best-effort in both directions: a missing log, an unreadable one, or a
 * read-only directory all mean "not rotated", never an error. A daemon must not
 * fail to start because it could not tidy its own log.
 */
export function rotateLogIfLarge(logPath: string, maxBytes = LOG_MAX_BYTES): RotateResult {
  try {
    const size = statSync(logPath).size;
    if (size < maxBytes) return { rotated: false, sizeBefore: 0 };
    copyFileSync(logPath, `${logPath}.1`);   // overwrites any previous generation
    truncateSync(logPath, 0);                // same inode, so every open fd survives
    return { rotated: true, sizeBefore: size };
  } catch {
    return { rotated: false, sizeBefore: 0 };
  }
}
