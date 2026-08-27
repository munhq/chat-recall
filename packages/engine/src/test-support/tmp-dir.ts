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
 * database under the directory they are deleting. The handle IS closed — the
 * teardown awaits `store.close()` — but the OS releases it asynchronously, so
 * the unlink can lose a race that cannot happen on Linux or macOS, where an
 * unlink of an open file just succeeds.
 *
 * `maxRetries` + `retryDelay` are Node's own answer to exactly this: it retries
 * EPERM, EBUSY, ENOTEMPTY and EMFILE with a linear backoff. One second of
 * patience in a teardown, rather than a failed suite on one platform.
 */
import { rmSync } from 'node:fs';

export function removeTestDir(dir: string): void {
  if (!dir) return;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
