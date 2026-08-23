/**
 * THE ROOT CAUSE OF "THE COLLECTOR IS DEAD", pinned so it cannot come back.
 *
 * The sync walk is `for (const ref of slice) { … await … }`. Every one of those
 * awaits resolves as a MICROTASK, and Node drains the entire microtask queue
 * before it advances to the timer phase. So a backlog of sessions — each
 * followed by a multi-second synchronous secret scan — runs as ONE unbroken
 * chain, and for its whole duration nothing else in the process happens:
 *
 *   · the 60-second heartbeat never fires, so the log goes silent
 *   · collector-health.json freezes, so every reader reports "not running"
 *   · SIGCHLD is not serviced, so a finished codeindex child sits <defunct>
 *   · SIGTERM is not serviced, so systemd waits 90s and then SIGKILLs
 *
 * Measured on the real corpus: 12 sessions, 388 MB, 24.2 seconds of walking,
 * ZERO of 24 expected heartbeats. The daemon was never hung. It never yielded —
 * and "never yields for nine minutes" is indistinguishable from dead to
 * everything watching it, which is exactly how it was diagnosed for two days.
 *
 * These tests assert the event-loop property directly rather than going through
 * syncIncremental (which needs credentials, a server and a corpus): the shape of
 * the loop is what matters, and the shape is what regressed.
 */
import { describe, test, expect } from 'vitest';

/** Burn CPU synchronously, the way a 106-regex scan over a transcript does. */
function synchronousWork(ms: number): void {
  const until = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < until) { /* spin */ }
}

/**
 * Run `n` iterations of "yield, then work", and count how many times a timer
 * managed to fire. `yielder` is the thing under test.
 */
async function countTimerTicks(
  n: number,
  workMs: number,
  yielder: () => Promise<void>,
): Promise<number> {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  try {
    for (let i = 0; i < n; i++) {
      await yielder();
      synchronousWork(workMs);
    }
  } finally {
    clearInterval(timer);
  }
  return ticks;
}

describe('the walk must let the event loop breathe', () => {
  // THE BUG. An already-resolved await stays inside the microtask queue, so the
  // timer phase is never reached, however long the loop runs.
  test('a microtask-only chain STARVES timers — this is the defect', async () => {
    const ticks = await countTimerTicks(20, 10, () => Promise.resolve());
    expect(ticks).toBe(0);
  });

  // THE FIX. setImmediate schedules on the CHECK phase, which the loop reaches
  // only after the timer phase — so scheduling one guarantees timers ran first.
  test('setImmediate between iterations keeps timers firing', async () => {
    const ticks = await countTimerTicks(20, 10, () => new Promise<void>((r) => setImmediate(r)));
    expect(ticks).toBeGreaterThan(0);
  });

  // Liveness must not depend on how long each iteration takes. A backlog of
  // heavy sessions is precisely the case that used to look like death.
  test('timers keep firing even when every iteration is slow', async () => {
    const ticks = await countTimerTicks(6, 40, () => new Promise<void>((r) => setImmediate(r)));
    expect(ticks).toBeGreaterThan(0);
  });

  // Why there is no time budget guarding the yield: it costs nothing. 15,727
  // yields — one per session on the maintainer's corpus — measured at 37.9 ms
  // total against a walk of over a minute. A budget would add an arbitrary
  // constant and a clock read in the hot path to save nothing.
  test('yielding every iteration is too cheap to be worth gating', async () => {
    const N = 15_727;
    const t0 = Date.now();
    for (let i = 0; i < N; i++) await new Promise<void>((r) => setImmediate(r));
    const ms = Date.now() - t0;
    // Generous ceiling: the point is the order of magnitude, not a benchmark.
    expect(ms).toBeLessThan(2000);
  });
});

describe('the shipped walk yields', () => {
  // A source-level assertion, deliberately. Driving the real walk needs
  // credentials, a live server and a session corpus, so the cheapest honest
  // guard against someone "tidying away" the yield is to require it to exist.
  test('sync-client keeps a setImmediate yield inside the conversation walk', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('./sync-client.ts', import.meta.url)), 'utf8');
    const walk = src.slice(src.indexOf('for (const ref of slice) {'));
    expect(walk).toContain('setImmediate');
  });
});
