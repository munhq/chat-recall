/**
 * The CPU-bound half of building one session, moved off the main thread.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * Per session the collector does four purely computational things to the same
 * transcript text: scan it with ~106 secret-detection regexes, redact it with
 * the same rules, gzip the result, and base64 it. Measured over 200 MB of real
 * sessions:
 *
 *   offloadable CPU work : 31,158 ms  (scan 42% · redact 44% · gzip 13% · b64 1%)
 *   cost to move the data:    553 ms  — 1.8% of the work moved
 *
 * All of it ran on the main thread, which is why a backlog made the daemon
 * unresponsive: no heartbeat, no signal handling, a child process left
 * unreaped. Yielding between sessions fixed the responsiveness; this removes the
 * work from that thread altogether, so the main loop stays free even DURING one
 * large session — a single 47 MB transcript is 7 seconds of solid computation.
 *
 * ── Contract ─────────────────────────────────────────────────────────────
 * Text goes in, only SMALL results come back: findings, a redaction count, and
 * the gzipped archive. The 30 MB string never returns, which is what keeps the
 * transfer cost at 1.8% instead of doubling it.
 *
 * The rule pack is versioned per task rather than pinned at startup. It is
 * fetched from the server on every sync and can change under a long-lived
 * worker, so each task carries the version it expects and the worker reinstalls
 * only when that differs — a string compare in the common case.
 */
import { parentPort } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import {
  scanTextForFindings, redactSecrets, installServerRulePack,
  type ServerRuleSpec, type RedactorFinding,
} from '@chat-recall/engine/core/secret-redactor.js';

/** One file of a session transcript. Mirrors RawContainer.files. */
export interface ScanFile { name: string; text: string }

/**
 * Derive a session's compute rows — diff, outcome, commits, markers.
 *
 * The heaviest per-session work in the walk and, until now, entirely on the main
 * thread: `replaySessionAny`, `computeOutcome` and `extractTurnsAny` each read
 * the whole transcript and shell out to git. Measured on the maintainer's tail
 * of sessions needing a rebuild: ~5 seconds each, against 78ms for the scan.
 *
 * It takes only an id — the worker reads the transcript itself, so nothing large
 * crosses the boundary on the way in, and `withSessionReadCache` inside means it
 * reads once rather than four times.
 */
export interface DerivedTask {
  id: number;
  task: 'derived';
  prefixedId: string;
  toolId: string;
  mtime: number;
  maxRowBytes: number;
  pack?: { version: string; rules: ServerRuleSpec[] };
  packVersion: string;
}

export interface DerivedResult {
  id: number;
  rows: { session_id: string; mtime: number; compute: Array<{ kind: string; mtime: number; data: unknown }>; outcome_row: unknown | null } | null;
  redactions: number;
  error?: string;
}

export interface ScanTask {
  id: number;
  task?: 'scan';
  files: ScanFile[];
  /** Container fields needed to rebuild it for gzip, minus the file text. */
  container: { v: 1; tool: string; mtime: number; srcHash?: string };
  /** Produce the gzipped archive too, or scan and redact only. */
  includeRaw: boolean;
  /** Skip the archive when it would exceed this many gzipped bytes. */
  maxRawBytes: number;
  /** Server rule pack, sent only when `packVersion` differs from the worker's. */
  pack?: { version: string; rules: ServerRuleSpec[] };
  packVersion: string;
}

export interface ScanResult {
  id: number;
  findings: RedactorFinding[];
  redactions: number;
  /** Present only when includeRaw and the archive fit inside maxRawBytes. */
  rawB64?: string;
  rawSize?: number;
  error?: string;
}

let installedPackVersion = '';

function runTask(task: ScanTask): ScanResult {
  if (task.pack && task.packVersion !== installedPackVersion) {
    installServerRulePack(task.pack);
    installedPackVersion = task.packVersion;
  }

  // SCAN the joined text — one string, the same one the single-threaded path
  // built, so line numbers in findings mean exactly what they always did.
  const joined = task.files.map((f) => f.text).join('\n');
  let findings: RedactorFinding[] = [];
  try { findings = scanTextForFindings(joined); } catch { /* best-effort, as before */ }

  // REDACT per file, because the archive keeps its file structure.
  const count = { redactions: 0 };
  let rawB64: string | undefined;
  let rawSize: number | undefined;
  const redacted = task.files.map((f) => ({
    name: f.name,
    text: redactSecrets(f.text, { force: true, count }),
  }));

  if (task.includeRaw) {
    try {
      const json = JSON.stringify({ ...task.container, files: redacted });
      const gz = gzipSync(json, { level: 6 });
      if (gz.length <= task.maxRawBytes) {
        rawB64 = gz.toString('base64');
        rawSize = Buffer.byteLength(json);
      }
    } catch { /* the archive is additive — the conversation still ships */ }
  }

  return { id: task.id, findings, redactions: count.redactions, rawB64, rawSize };
}

async function runDerived(task: DerivedTask): Promise<DerivedResult> {
  if (task.pack && task.packVersion !== installedPackVersion) {
    installServerRulePack(task.pack);
    installedPackVersion = task.packVersion;
  }
  // Imported lazily and INSIDE the worker: these pull the replay/outcome/turns
  // machinery and the backend registry, which the scan path never needs.
  const { collectDerivedRows } = await import('./derived.js');
  const count = { redactions: 0 };
  const rows = collectDerivedRows(
    { prefixedId: task.prefixedId, toolId: task.toolId, mtime: task.mtime },
    task.mtime, count, task.maxRowBytes,
  );
  return { id: task.id, rows, redactions: count.redactions };
}

parentPort?.on('message', async (task: ScanTask | DerivedTask) => {
  if ((task as DerivedTask).task === 'derived') {
    try {
      parentPort?.postMessage(await runDerived(task as DerivedTask));
    } catch (err) {
      parentPort?.postMessage({
        id: task.id, rows: null, redactions: 0,
        error: err instanceof Error ? err.message : String(err),
      } satisfies DerivedResult);
    }
    return;
  }
  let result: ScanResult;
  try {
    result = runTask(task as ScanTask);
  } catch (err) {
    // Never let a worker die on one bad session: report and stay available. The
    // caller falls back to computing this session on the main thread.
    result = {
      id: task.id, findings: [], redactions: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  parentPort?.postMessage(result);
});
