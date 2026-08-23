/**
 * One background task at a time, in priority order, with same-kind coalescing.
 *
 * ── What it replaces ─────────────────────────────────────────────────────
 * Three independent in-flight booleans — `syncInFlight`, `intentDrainInFlight`,
 * `codeIndexInFlight`. Each correctly stopped its OWN tick from overlapping
 * itself, and none of them knew about the others, so a code-intelligence sweep
 * could run at the same time as a full sync walk and an intent drain. All three
 * are heavy: the sweep spawns codeindex and holds its output, the walk holds a
 * session container, the drain copies files. Measured with a sweep and a walk
 * overlapping, the main thread sat at 80–95% and RSS more than doubled.
 *
 * They also could not express what the daemon actually wants: shipping to the
 * server matters more than refreshing code intelligence, so if both are due, the
 * sweep should wait.
 *
 * ── Semantics ────────────────────────────────────────────────────────────
 * SERIAL — exactly one task runs at a time.
 *
 * COALESCED PER KIND — if a kind is already waiting, a new request for that kind
 * is dropped rather than queued twice. Both would do the same work against the
 * same state, and the second would find nothing to do. This preserves what the
 * booleans got right (no self-overlap) without the "silently skipped" behaviour:
 * a request that arrives while its kind is RUNNING sets a re-run flag, so a file
 * change during a walk still gets a walk afterwards instead of being lost.
 *
 * PRIORITISED — lower number first, and only among tasks already waiting. A
 * running task is never preempted; a long sweep still finishes.
 */

export type TickKind = string;

interface Waiting {
  kind: TickKind;
  priority: number;
  run: () => Promise<void>;
}

export interface TickQueueOpts {
  /** Reports every state change; the daemon logs through it. */
  onError?: (kind: TickKind, err: unknown) => void;
}

export class TickQueue {
  private waiting: Waiting[] = [];
  private running: TickKind | null = null;
  /** Kinds that asked to run while they were already running. */
  private rerun = new Set<TickKind>();

  constructor(private readonly opts: TickQueueOpts = {}) {}

  /** The kind currently executing, or null when idle. Diagnostics only. */
  get active(): TickKind | null { return this.running; }
  get depth(): number { return this.waiting.length; }

  /**
   * Ask for `kind` to run. Returns immediately — this is a scheduler, not a
   * `await`-able task.
   */
  request(kind: TickKind, priority: number, run: () => Promise<void>): void {
    if (this.running === kind) {
      // Its state changed underneath it; run once more when it finishes rather
      // than dropping the request (a file change during a walk must not be lost).
      this.rerun.add(kind);
      return;
    }
    if (this.waiting.some((w) => w.kind === kind)) return;   // coalesced
    this.waiting.push({ kind, priority, run });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running !== null) return;
    const next = this.waiting
      .map((w, i) => ({ w, i }))
      .sort((a, b) => (a.w.priority - b.w.priority) || (a.i - b.i))[0];
    if (!next) return;
    this.waiting.splice(next.i, 1);
    const { kind, priority, run } = next.w;
    this.running = kind;
    try {
      await run();
    } catch (err) {
      this.opts.onError?.(kind, err);
    } finally {
      this.running = null;
      if (this.rerun.delete(kind)) {
        // Re-queue at its own priority; it takes its turn like anything else.
        this.waiting.push({ kind, priority, run });
      }
      void this.pump();
    }
  }

  /** Tests: settle the queue. */
  async drain(): Promise<void> {
    while (this.running !== null || this.waiting.length > 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }
}

/**
 * Priorities for the daemon's ticks. Lower runs first.
 *
 * Shipping to the server is the product; everything else is enrichment. Code
 * intelligence is last because it is the heaviest and the least urgent — it
 * refreshes on a 180-minute cadence, so waiting out a walk costs nothing.
 */
export const TICK_PRIORITY = {
  sync: 10,
  intents: 20,
  codeIndex: 30,
  housekeeping: 40,
} as const;
