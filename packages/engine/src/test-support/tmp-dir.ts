/**
 * Remove a throwaway directory, including on Windows.
 *
 * ── The failure ───────────────────────────────────────────────────────────
 * `rmSync(dir, { recursive: true, force: true })` in an afterAll threw
 *
 *     Error: EPERM, Permission denied: \\?\C:\Users\…\Temp\win-route-h9ld4J
 *
 * on three test files and nowhere else. `force: true` only suppresses "it does
 * not exist"; it does nothing about "it is in use". On Windows a file cannot be
 * unlinked while any handle to it is open, and these suites open a SQLite
 * database (plus its `-wal` and `-shm` sidecars) under the directory they are
 * deleting. Every handle the test and the routes take IS closed — an audit of
 * every store factory in the repo found exactly one leak, in
 * `POST /api/memory/reclassify`, and that is fixed — but the OS releases a
 * handle asynchronously, so the unlink can lose a race that simply cannot happen
 * on Linux or macOS, where unlinking an open file succeeds.
 *
 * ── Why this does not throw ───────────────────────────────────────────────
 * A teardown is not the thing under test. By the time it runs, every assertion
 * in the suite has already passed or failed on its own merits, and the directory
 * is inside the OS temp directory, which the OS reclaims. Turning a lost unlink
 * race into a red build on one platform reports a defect that is not there.
 *
 * ── Why it is not silent either ───────────────────────────────────────────
 * A handle held FOREVER is a real leak and looks identical, at teardown, to one
 * held a moment too long. So on final failure this names the files that are
 * still there. Node's EPERM message names only the directory, which is the one
 * thing you already know; the listing says whether it is `cache.db`, a `-wal`
 * sidecar, or something else entirely — the fact the next Windows run needs, and
 * the reason the first version of this helper could not be diagnosed further.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Retries EPERM/EBUSY/ENOTEMPTY/EMFILE for up to five seconds. */
const RETRY = { maxRetries: 20, retryDelay: 250 } as const;

export function removeTestDir(dir: string): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, ...RETRY });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    // eslint-disable-next-line no-console
    console.warn(
      `[test-support] could not remove ${dir} after ${RETRY.maxRetries} attempts (${code}). `
      + `Leaving it to the OS. Still present: ${describeLeftovers(dir)}`,
    );
  }
}

/** What is still in the directory, one level deep, so a locked file is named. */
function describeLeftovers(dir: string, depth = 0): string {
  if (depth > 1) return '…';
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.length === 0) return '(empty)';
    return entries
      .slice(0, 12)
      .map((e) => (e.isDirectory() ? `${e.name}/{${describeLeftovers(join(dir, e.name), depth + 1)}}` : e.name))
      .join(', ');
  } catch {
    return '(unreadable)';
  }
}
