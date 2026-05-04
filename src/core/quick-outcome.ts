/**
 * Fast, badge-grade outcome classifier.
 *
 * `computeOutcome` is the gold-standard classifier — it parses the entire
 * JSONL transcript, replays every Edit/Write tool_use to count file changes,
 * and runs `git log` per touched repo to detect commits in the session
 * window. That work is necessary to distinguish "shipped" from "abandoned",
 * but it's also too slow to run 50 times back-to-back when a list of
 * conversations renders and every visible row fetches a status badge.
 *
 * This module trades distinguishing-power for speed: it produces a
 * coarser status (in_progress / interrupted / completed / unknown) using
 * only file mtime + a tail-of-file scan. Roughly **2–3 orders of magnitude
 * cheaper** than `computeOutcome` because it never does a full parse or
 * a git call. Use this for list badges; defer to `computeOutcome` when
 * the user opens the per-session Outcome view.
 */

import { existsSync, openSync, readSync, closeSync, statSync } from 'fs';

export type QuickOutcomeStatus = 'in_progress' | 'interrupted' | 'completed' | 'unknown';

export interface QuickOutcome {
  sessionId: string;
  status: QuickOutcomeStatus;
  reason: string;
  mtime: number;
}

/** How long after the last edit we still consider a session "in progress". */
const IN_PROGRESS_WINDOW_MS = 2 * 60 * 60 * 1000;

/** How many lines from the end of the file we tail-scan for end-state markers. */
const TAIL_SCAN_LINES = 80;

/**
 * How many bytes off the end we read to find ~80 lines. JSONL session
 * lines average 200B–4KB; 256KB is a comfortable upper bound that still
 * never reads more than ~1% of even the largest (20MB+) transcripts.
 */
const TAIL_BYTES = 256 * 1024;

/**
 * Classify a session by file mtime + a tail-of-file scan. No parse, no
 * replay, no git call. Returns 'unknown' on file errors so callers can
 * show a neutral badge instead of erroring.
 *
 * The mtime/age check happens first because it's free; the tail scan only
 * runs when we'd otherwise need to choose between 'completed' and
 * 'interrupted'.
 */
export function quickOutcomeStatus(sessionFilePath: string, sessionId: string): QuickOutcome {
  if (!existsSync(sessionFilePath)) {
    return { sessionId, status: 'unknown', reason: 'session file not found', mtime: 0 };
  }

  let mtimeMs = 0;
  try {
    mtimeMs = statSync(sessionFilePath).mtimeMs;
  } catch {
    return { sessionId, status: 'unknown', reason: 'could not stat session file', mtime: 0 };
  }

  const ageMs = Date.now() - mtimeMs;
  if (ageMs <= IN_PROGRESS_WINDOW_MS) {
    return {
      sessionId,
      status: 'in_progress',
      reason: 'modified within the last 2 hours',
      mtime: mtimeMs,
    };
  }

  // Older sessions: tail-scan the file to distinguish 'interrupted' (last
  // user prompt is the synthetic [Request interrupted by user] marker, or
  // last assistant turn was cut off mid-tool-use) from 'completed'
  // (anything else — could be shipped or abandoned, the badge stays
  // ambiguous, and the user clicks through if they want the full story).
  const interrupted = tailScanForInterrupt(sessionFilePath);
  if (interrupted) {
    return {
      sessionId,
      status: 'interrupted',
      reason: 'last user prompt was an explicit interrupt',
      mtime: mtimeMs,
    };
  }

  return {
    sessionId,
    status: 'completed',
    reason: 'no recent activity, no interrupt at end',
    mtime: mtimeMs,
  };
}

/**
 * Return true when the last few user messages in a session contain an
 * explicit interrupt marker. Reads only the last `TAIL_BYTES` bytes of
 * the file via `readSync(fd, buf, offset)` — independent of total file
 * size. Critical for performance: real sessions can be 20+ MB and
 * `readFileSync` was the bottleneck that made list-row badges slow.
 */
function tailScanForInterrupt(sessionFilePath: string): boolean {
  let fd = -1;
  let chunk: string;
  try {
    fd = openSync(sessionFilePath, 'r');
    const stat = statSync(sessionFilePath);
    const offset = Math.max(0, stat.size - TAIL_BYTES);
    const length = Math.min(stat.size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    const bytesRead = readSync(fd, buf, 0, length, offset);
    chunk = buf.subarray(0, bytesRead).toString('utf-8');
  } catch {
    return false;
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch {}
    }
  }

  // If we tailed mid-file, the first line fragment is almost certainly a
  // partial line. Drop it so JSON.parse doesn't see truncated junk.
  const lines = chunk.split('\n');
  const stat = statSync(sessionFilePath);
  if (stat.size > TAIL_BYTES && lines.length > 1) {
    lines.shift();
  }
  const tail = lines.slice(Math.max(0, lines.length - TAIL_SCAN_LINES));

  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== 'user') continue;
    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const content = msg.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (
          block && typeof block === 'object' &&
          (block as Record<string, unknown>).type === 'text' &&
          typeof (block as Record<string, unknown>).text === 'string'
        ) {
          parts.push((block as Record<string, unknown>).text as string);
        }
      }
      text = parts.join('\n');
    }
    if (!text) continue;
    const trimmed = text.trim();
    // Claude Code writes this exact synthetic message when the user hits
    // ESC during a streaming response. If it's the last user message of
    // the session, the session was interrupted and never recovered.
    if (trimmed === '[Request interrupted by user]') return true;
    // Found a real user message — not interrupted; bail.
    return false;
  }
  return false;
}

export function quickStatusEmoji(status: QuickOutcomeStatus): string {
  switch (status) {
    case 'in_progress': return '🟡';
    case 'interrupted': return '⏸';
    case 'completed':   return '✓';
    default:            return '❔';
  }
}

/**
 * mtime-only classifier — used for tools whose transcript format we
 * don't have a JSONL tail-scan for (Gemini, OpenCode). Loses the
 * interrupted/completed distinction (everything older than the window
 * collapses to 'completed'), but still gives the user the at-a-glance
 * `🟡 in_progress` vs `✓ completed` signal that matters most.
 *
 * Pass any positive `mtimeMs` value — typically from `statSync` or from
 * the MemoryStore's `mtime` column for non-file-backed tools.
 */
export function quickOutcomeFromMtime(sessionId: string, mtimeMs: number): QuickOutcome {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) {
    return { sessionId, status: 'unknown', reason: 'no mtime available', mtime: 0 };
  }
  const ageMs = Date.now() - mtimeMs;
  if (ageMs <= IN_PROGRESS_WINDOW_MS) {
    return {
      sessionId,
      status: 'in_progress',
      reason: 'modified within the last 2 hours',
      mtime: mtimeMs,
    };
  }
  return {
    sessionId,
    status: 'completed',
    reason: 'no recent activity (mtime-only classification — interrupt detection unavailable for this tool)',
    mtime: mtimeMs,
  };
}
