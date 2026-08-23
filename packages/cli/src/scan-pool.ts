/**
 * A tiny worker pool for the per-session scan/redact/gzip work.
 *
 * ── Design constraints, in priority order ────────────────────────────────
 *
 * 1. IT RUNS ON SOMEONE ELSE'S LAPTOP. A background collector that saturates
 *    every core is uninstalled, however fast it is. The pool defaults to ONE
 *    worker: that already achieves the goal — the main thread stops doing
 *    seconds of solid computation — while using no more CPU in total than the
 *    single-threaded version did. More workers only help once the walk builds
 *    several sessions at a time, which it does not yet; the size is env-tunable
 *    so that change does not need a release.
 *
 * 2. IT MUST NEVER BE THE REASON A SYNC FAILS. Every failure path — no worker
 *    file (a dev run from source), spawn refused, a worker that dies mid-task,
 *    a task that throws — falls back to computing the session inline. The
 *    fallback is the code that shipped for the last year, so the worst case is
 *    the old behaviour, not a broken sync.
 *
 * 3. BOUNDED MEMORY. Each worker holds one session's text, and a 47 MB
 *    transcript is a real size here. `resourceLimits` caps each worker's heap
 *    so a pathological session kills one task instead of the daemon — the OOM
 *    that started all of this was exactly a transcript-sized allocation with no
 *    ceiling.
 */
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import type { ScanTask, ScanResult, DerivedTask, DerivedResult } from './scan-worker.js';

/** Per-worker heap ceiling. One session's text plus its gzip, with headroom. */
const WORKER_HEAP_MB = Number(process.env.CHAT_RECALL_SCAN_WORKER_HEAP_MB) || 768;

/**
 * How many workers.
 *
 * Default 1 — see constraint 1. `0` disables the pool entirely and everything
 * runs inline, which is the escape hatch if a machine misbehaves.
 */
function poolSize(): number {
  const raw = process.env.CHAT_RECALL_SCAN_WORKERS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), Math.max(1, cpus().length));
  }
  return 1;
}

/** The bundled worker script, or null when there isn't one (source runs). */
function workerScript(): string | null {
  // Two layouts, in order of likelihood:
  //   1. bundled — dist/scan-worker.js sits beside dist/watch.js and dist/cli.js,
  //      so this resolves from whichever bundle is running.
  //   2. from source (dev, tests) — ../dist/scan-worker.js, if a build has run.
  //
  // Neither found means no pool and everything runs inline. That is a supported
  // state, not a failure: a daemon that only works after a build step is a trap.
  for (const rel of ['./scan-worker.js', '../dist/scan-worker.js']) {
    try {
      const p = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(p)) return p;
    } catch { /* not resolvable from here — try the next */ }
  }
  return null;
}

interface Slot {
  worker: Worker;
  /** Resolver for the task in flight, if any. Either task kind. */
  pending: ((r: ScanResult | DerivedResult) => void) | null;
}

export class ScanPool {
  private slots: Slot[] = [];
  private queue: Array<{ task: ScanTask | DerivedTask; resolve: (r: ScanResult | DerivedResult) => void }> = [];
  private nextId = 1;
  private started = false;
  private disabled = false;
  /** Version of the rule pack each worker has installed, by slot index. */
  private packSent = new Map<number, string>();

  constructor(private readonly size = poolSize()) {
    if (this.size < 1) this.disabled = true;
  }

  /** True when tasks will actually run on a worker. */
  get enabled(): boolean { return !this.disabled; }

  private start(): void {
    if (this.started) return;
    this.started = true;
    const script = workerScript();
    if (!script) { this.disabled = true; return; }
    for (let i = 0; i < this.size; i++) {
      try {
        const worker = new Worker(script, {
          resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
          // DO NOT INHERIT THE PARENT'S NODE FLAGS. By default a Worker copies
          // process.execArgv, so any flag on the parent is re-applied to a file
          // it does not describe — `--input-type=module` made every worker exit
          // with "can only be used with string input", and the pool degraded to
          // the inline path SILENTLY. Anything the worker needs is set here
          // (resourceLimits), so an empty list is both correct and insulating.
          execArgv: [],
        });
        const slot: Slot = { worker, pending: null };
        worker.on('message', (r: ScanResult) => {
          const resolve = slot.pending;
          slot.pending = null;
          resolve?.(r);
          this.pump();
        });
        // A dead worker must not strand its caller. Fail the task in flight so
        // the caller falls back inline, and retire the slot.
        const die = (err: unknown) => {
          const resolve = slot.pending;
          slot.pending = null;
          this.slots = this.slots.filter((s) => s !== slot);
          if (this.slots.length === 0) this.disabled = true;
          // Shaped to satisfy both result types: the caller only reads `error`
          // on this path and falls back inline either way.
          resolve?.({ id: -1, findings: [], redactions: 0, rows: null, error: `scan worker died: ${err}` } as ScanResult & DerivedResult);
          this.pump();
        };
        worker.on('error', die);
        worker.on('exit', (code) => { if (code !== 0) die(`exit ${code}`); });
        // REF WHILE BUSY, UNREF WHILE IDLE — see refIfBusy().
        //
        // A permanent unref() looked right ("never hold the process open on the
        // pool's account") and broke every one-shot command. With a task in
        // flight and nothing else on the event loop, Node has no reason to stay
        // alive, so `chat-recall sync` returned with the worker's reply still
        // pending: it shipped ZERO sessions, exited 0, and said nothing. The
        // watch daemon hid it completely, because a daemon always has timers.
        //
        // This is the second time: the bug was found and fixed during the build
        // pipeline work, then destroyed by `git checkout -- scan-pool.ts` when
        // that pipeline was reverted wholesale. The compose integration test —
        // CLI ↔ real server, one-shot — is what caught it both times.
        worker.unref();
        this.slots.push(slot);
      } catch { /* one failure is enough to know: fall back inline */ }
    }
    if (this.slots.length === 0) this.disabled = true;
  }

  private pump(): void {
    if (this.queue.length === 0) { this.refIfBusy(); return; }
    const slot = this.slots.find((s) => s.pending === null);
    if (!slot) { this.refIfBusy(); return; }
    const next = this.queue.shift()!;
    slot.pending = next.resolve;
    slot.worker.postMessage(next.task);
    this.refIfBusy();
  }

  /**
   * Keep the process alive exactly while the pool owes someone an answer.
   *
   * A worker with a task in flight must be ref'd or Node may exit before the
   * reply lands; an idle one must be unref'd or the pool alone keeps a one-shot
   * CLI command running forever.
   */
  private refIfBusy(): void {
    const busy = this.queue.length > 0 || this.slots.some((s) => s.pending !== null);
    for (const s of this.slots) {
      if (busy) s.worker.ref(); else s.worker.unref();
    }
  }

  /**
   * Run one task on a worker.
   *
   * Returns null when the pool cannot take it — the caller must then do the
   * work inline. Null is a normal outcome, not an error: it is what makes the
   * pool optional.
   */
  async run(task: Omit<ScanTask, 'id'>): Promise<ScanResult | null> {
    return this.dispatch({ ...task, id: 0 } as ScanTask) as Promise<ScanResult | null>;
  }

  /**
   * Derive a session's compute rows on a worker.
   *
   * Same pool, same lifecycle, same null-means-inline contract as `run` — two
   * pools would mean two sets of workers competing for the same cores.
   */
  async runDerived(task: Omit<DerivedTask, 'id' | 'task'>): Promise<DerivedResult | null> {
    return this.dispatch({ ...task, task: 'derived', id: 0 } as DerivedTask) as Promise<DerivedResult | null>;
  }

  private async dispatch(task: ScanTask | DerivedTask): Promise<ScanResult | DerivedResult | null> {
    this.start();
    if (this.disabled) return null;
    task.id = this.nextId++;
    const result = await new Promise<ScanResult | DerivedResult>((resolve) => {
      this.queue.push({ task, resolve });
      this.pump();
    });
    if (result.error) return null;    // fall back inline for this session
    return result;
  }

  /**
   * Has this pool already sent the current rule pack? Lets the caller omit the
   * ~74-rule pack from every task and send it only when the version changes.
   *
   * Conservative on purpose: the answer is per POOL, not per worker, so the
   * pack is re-sent to every worker whenever the version moves. A worker that
   * receives a pack it already has reinstalls it once — cheap, and far safer
   * than a worker scanning with rules it never got.
   */
  needsPack(version: string): boolean {
    return this.packSent.get(0) !== version;
  }

  markPackSent(version: string): void {
    this.packSent.set(0, version);
  }

  async close(): Promise<void> {
    const slots = this.slots;
    this.slots = [];
    this.disabled = true;
    await Promise.all(slots.map((s) => s.worker.terminate().catch(() => undefined)));
  }
}

/** Process-wide pool. Workers are expensive to create; one set is plenty. */
let shared: ScanPool | null = null;
export function scanPool(): ScanPool {
  if (!shared) shared = new ScanPool();
  return shared;
}

/** Tests and `logout`: drop the workers. */
export async function closeScanPool(): Promise<void> {
  const p = shared;
  shared = null;
  await p?.close();
}
