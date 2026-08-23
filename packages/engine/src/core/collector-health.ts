/**
 * Does the collector still work? A file the daemon writes and everything else reads.
 *
 * WHY THIS EXISTS. The watch daemon crash-looped for eight days — 4,851 heap
 * aborts, a restart roughly every 105 seconds — and said nothing. systemd
 * restarted it silently, the crash went to a log nobody tails, and the only
 * user-visible symptom was a "25m behind" number in the web app that the user
 * happened to notice. A collector that cannot ship must SAY so, in the places
 * the user already looks, or the product is quietly lying about having their
 * history.
 *
 * The daemon writes this file; `chat-recall doctor`, the MCP tool wrapper and
 * the CLI's one-line notice read it. It is deliberately tiny, plain JSON, and
 * best-effort in both directions: a missing or corrupt file means "no report",
 * never an error, because a health check that can break the thing it watches is
 * worse than no health check.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getDataDir } from './paths.js';

export interface TargetHealth {
  /** Epoch ms of the last sync that completed without throwing. */
  lastOkAt: number | null;
  /** Consecutive failures since the last success. */
  failures: number;
  /** Last error, truncated. Never contains a token: it is a message, not a body. */
  lastError?: string;
}

/**
 * How far through a walk the collector is.
 *
 * A first sync on a large corpus takes a long time, and until now the only
 * evidence it was working at all was one log line per 250 sessions, written to a
 * file nobody tails. "Is this broken or just slow?" is the first question a new
 * user asks, and the product had no answer.
 *
 * Written by the walk itself, so it is a fact rather than an estimate, and read
 * by everything that already reads this file — `doctor`, the CLI notice, the MCP
 * banner — plus the web UI via the sync envelope.
 */
export interface WalkProgress {
  /** Sessions considered so far in the current walk. */
  done: number;
  /** Sessions in the current walk. */
  total: number;
  /** Epoch ms this walk began — lets a reader compute a rate. */
  startedAt: number;
  /** True once the walk finished; a stale in-progress value means it died. */
  complete: boolean;
}

export interface CollectorHealth {
  v: 1;
  /** Epoch ms this file was last written — proves the daemon is alive at all. */
  updatedAt: number;
  /** Epoch ms the current daemon process started. */
  startedAt: number;
  /** Process starts seen in the last hour. A crash loop shows up here. */
  restartsLastHour: number;
  /** Per sync target, keyed by server URL. */
  targets: Record<string, TargetHealth>;
  /** Progress of the walk in flight, when one is. */
  progress?: WalkProgress;
}

/**
 * One line a human can read, or null when there is nothing to say.
 *
 * Deliberately silent on a finished or trivial walk: a progress line on every
 * command would be noise, and noise is how the staleness warning gets ignored.
 */
export function progressLine(h: CollectorHealth | null): string | null {
  const p = h?.progress;
  if (!p || p.complete || p.total <= 0) return null;
  const pct = Math.min(99, Math.floor((100 * p.done) / p.total));
  return `first sync in progress — ${p.done.toLocaleString()} of ${p.total.toLocaleString()} sessions (${pct}%)`;
}

const healthPath = (): string => join(getDataDir(), 'collector-health.json');
export function collectorHealthPath(): string { return healthPath(); }

export function readCollectorHealth(): CollectorHealth | null {
  try {
    const h = JSON.parse(readFileSync(healthPath(), 'utf-8')) as CollectorHealth;
    return h && h.v === 1 && typeof h.updatedAt === 'number' ? h : null;
  } catch {
    return null;
  }
}

export function writeCollectorHealth(h: CollectorHealth): void {
  try {
    const p = healthPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(h));
  } catch { /* health reporting must never break the daemon */ }
}

/**
 * Merge a patch into the health file.
 *
 * Two writers touch this file — the daemon's heartbeat and the sync walk's
 * progress — and a plain overwrite from either would erase the other's field.
 * Read-modify-write, and best-effort like everything else here.
 */
export function updateCollectorHealth(patch: Partial<CollectorHealth>): void {
  const prior = readCollectorHealth();
  writeCollectorHealth({
    v: 1,
    updatedAt: Date.now(),
    startedAt: prior?.startedAt ?? Date.now(),
    restartsLastHour: prior?.restartsLastHour ?? 0,
    targets: prior?.targets ?? {},
    ...(prior?.progress ? { progress: prior.progress } : {}),
    ...patch,
  } as CollectorHealth);
}

/** Don't rewrite the file on every session — a walk visits tens of thousands. */
const PROGRESS_WRITE_INTERVAL_MS = 2000;
let lastProgressWrite = 0;

/**
 * Publish walk progress. Throttled, except for the first and last report, which
 * always land — those are the two a reader actually needs: "it started" and
 * "it finished".
 */
export function reportWalkProgress(p: WalkProgress): void {
  const now = Date.now();
  const boundary = p.complete || p.done === 0;
  if (!boundary && now - lastProgressWrite < PROGRESS_WRITE_INTERVAL_MS) return;
  lastProgressWrite = now;
  updateCollectorHealth({ progress: p });
}

/** How stale a sync has to be before we say something, in ms. */
export const STALE_AFTER_MS = 30 * 60_000;
/** Restarts in an hour that mean "crash loop" rather than "a deploy happened". */
export const CRASHLOOP_RESTARTS = 3;

export interface HealthVerdict {
  ok: boolean;
  /** One line, safe to print anywhere. Null when everything is fine. */
  summary: string | null;
  reasons: string[];
}

const ago = (ms: number): string => {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

/**
 * Judge a health report. `now` is injectable so this is testable without a clock.
 *
 * Three things are worth interrupting a user for, and nothing else is:
 *   1. the daemon is not running (or has not written for a long time),
 *   2. it is running but nothing has reached a server in a long time,
 *   3. it is restarting over and over, which is how the OOM presented.
 */
export function judgeHealth(h: CollectorHealth | null, now: number = Date.now()): HealthVerdict {
  if (!h) return { ok: true, summary: null, reasons: [] };

  const reasons: string[] = [];

  // The daemon writes on a heartbeat; silence means it is gone or wedged.
  const silent = now - h.updatedAt;
  if (silent > STALE_AFTER_MS) {
    reasons.push(`the collector has not reported for ${ago(silent)} — it may not be running`);
  }

  if (h.restartsLastHour >= CRASHLOOP_RESTARTS) {
    reasons.push(`it restarted ${h.restartsLastHour} times in the last hour`);
  }

  const targets = Object.entries(h.targets ?? {});
  const stale = targets.filter(([, t]) => t.lastOkAt === null || now - t.lastOkAt > STALE_AFTER_MS);
  if (targets.length > 0 && stale.length === targets.length) {
    // Prefer a target that carries an ERROR over the one that is merely oldest.
    // "nothing has synced since never" is true and useless; "…(fetch failed)"
    // is what a user can act on. Among equals, the longest-stale one wins.
    const ranked = stale.map(([url, t]) => ({ url, t })).sort((a, b) => {
      const err = Number(!!b.t.lastError) - Number(!!a.t.lastError);
      if (err !== 0) return err;
      return (a.t.lastOkAt ?? 0) - (b.t.lastOkAt ?? 0);
    });
    const worst = ranked[0];
    const when = worst.t.lastOkAt ? `${ago(now - worst.t.lastOkAt)} ago` : 'never';
    const why = worst.t.lastError ? ` (${worst.t.lastError})` : '';
    reasons.push(`nothing has synced since ${when}${why}`);
  }

  if (reasons.length === 0) return { ok: true, summary: null, reasons: [] };
  return {
    ok: false,
    summary: `chat-recall is not syncing: ${reasons.join('; ')}.`,
    reasons,
  };
}
