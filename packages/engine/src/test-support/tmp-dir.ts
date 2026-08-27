/**
 * Remove a throwaway directory, including on Windows.
 *
 * ── The failure, and what it actually was ─────────────────────────────────
 * `rmSync(dir, { recursive: true, force: true })` in an afterAll threw
 *
 *     Error: EPERM, Permission denied: \\?\C:\Users\…\Temp\win-route-h9ld4J
 *
 * on three suites and nowhere else. `force: true` only suppresses "it does not
 * exist"; it does nothing about "it is in use", and Windows will not unlink a
 * file while any handle to it is open.
 *
 * Instrumenting the failure named the file: `cache.db`. It is not a leak.
 * `routes/conversations.ts` keeps a module-level `MetadataCache` and
 * `OutcomeCache` for the process lifetime — a deliberate cache on a hot path,
 * never closed — and all three of those suites mount `conversationsRouter`. So
 * the directory genuinely cannot be deleted while the process lives, on the one
 * platform that enforces it. (An audit of every store / metadata-cache /
 * outcome-cache / knowledge-graph factory in the repo found exactly one true
 * leak, in `POST /api/memory/reclassify`, and that is fixed.)
 *
 * ── Why this is async ─────────────────────────────────────────────────────
 * The first version used the SYNCHRONOUS `rmSync` with `maxRetries`, which
 * blocks the event loop for the whole retry window — up to five seconds. A
 * vitest worker that cannot run its event loop cannot answer the parent, so the
 * run then died with
 *
 *     Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 *
 * and the job failed with every single test passing. A teardown must never take
 * the thread away from the runner: `fs/promises.rm` yields between retries.
 *
 * ── Why it does not throw ─────────────────────────────────────────────────
 * A teardown is not the thing under test. Every assertion has already passed or
 * failed on its own merits, the directory is inside the OS temp directory, and
 * the handle holding it is one the server is supposed to hold. Failing the build
 * over it reports a defect that is not there — while staying SILENT would hide a
 * future real leak, so the leftovers are named.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Retries EPERM/EBUSY/ENOTEMPTY/EMFILE, yielding to the event loop between. */
const RETRY = { maxRetries: 10, retryDelay: 100 } as const;

export async function removeTestDir(dir: string): Promise<void> {
  if (!dir) return;
  try {
    await rm(dir, { recursive: true, force: true, ...RETRY });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    // eslint-disable-next-line no-console
    console.warn(
      `[test-support] could not remove ${dir} (${code}) — leaving it to the OS. `
      + `Still present: ${await describeLeftovers(dir)}`,
    );
  }
}

/** What is still in the directory, one level deep, so a locked file is named. */
async function describeLeftovers(dir: string, depth = 0): Promise<string> {
  if (depth > 1) return '…';
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.length === 0) return '(empty)';
    const parts: string[] = [];
    for (const e of entries.slice(0, 12)) {
      parts.push(e.isDirectory()
        ? `${e.name}/{${await describeLeftovers(join(dir, e.name), depth + 1)}}`
        : e.name);
    }
    return parts.join(', ');
  } catch {
    return '(unreadable)';
  }
}
