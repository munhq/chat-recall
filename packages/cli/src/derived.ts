/**
 * Per-session derived data: diff, outcome, commits, markers.
 *
 * ── Why this is its own module ───────────────────────────────────────────
 * It is the heaviest work in a sync walk and it now runs in TWO places — on a
 * worker thread (the fast path) and inline (the fallback when no worker is
 * available). Two copies of this logic would be two things to keep correct, and
 * the one that runs less often would rot. So it lives here and both callers
 * import it.
 *
 * Measured cost, on the sessions that actually need rebuilding: ~5 seconds each,
 * against 78ms for the secret scan. `replaySessionAny`, `computeOutcome` and
 * `extractTurnsAny` each read the whole transcript and shell out to git —
 * `withSessionReadCache` collapses that to one read, and moving the whole thing
 * to a worker is what takes it off the thread that has to answer signals and
 * fire the heartbeat.
 *
 * Takes an id, reads from disk itself, returns small-ish rows. That shape is
 * what makes it cheap to hand to a worker: nothing large crosses the boundary on
 * the way in.
 */
import { withSessionReadCache } from '@chat-recall/engine/core/live-session-scan.js';
import { replaySessionAny, extractTurnsAny } from '@chat-recall/engine/core/session-multi-tool.js';
import { computeOutcome } from '@chat-recall/engine/core/session-outcome.js';
import { markPrompt, summarizeMarkers } from '@chat-recall/engine/core/session-sentiment.js';
import { redactDeep } from './redact-deep.js';

/** Which compute rows a session ships. */
export const COMPUTE_KINDS = ['diff', 'outcome', 'commits', 'markers'] as const;

export interface DerivedRows {
  session_id: string;
  mtime: number;
  compute: Array<{ kind: string; mtime: number; data: unknown }>;
  outcome_row: unknown | null;
}

export function collectDerivedRows(
  ref: { prefixedId: string; toolId: string; mtime: number },
  mtime: number,
  count: { redactions: number },
  maxRowBytes: number,
): DerivedRows {
  const id = ref.prefixedId;
  const compute: Array<{ kind: string; mtime: number; data: unknown }> = [];
  let fullOutcome: ReturnType<typeof computeOutcome> | null = null;

  // One read of this transcript instead of four. replay, computeOutcome (twice
  // internally) and extractTurns each re-read the whole file; the scope holds
  // exactly one session's text and drops it on the way out.
  return withSessionReadCache(() => {
  for (const kind of COMPUTE_KINDS) {
    let data: unknown = null;
    try {
      if (kind === 'diff') {
        const replay = replaySessionAny(id);
        if (replay.found) data = replay;
      } else if (kind === 'outcome') {
        fullOutcome = computeOutcome(id);
        if (fullOutcome.found) data = fullOutcome;
      } else if (kind === 'commits') {
        // computeOutcome already ran git for the session window — reuse.
        if (!fullOutcome) fullOutcome = computeOutcome(id);
        if (fullOutcome.found) data = fullOutcome.commits;
      } else if (kind === 'markers') {
        // Analysis-only use of the turns extractor (R4) — markers need
        // per-prompt line/ts, not render fidelity.
        const turns = extractTurnsAny(id, { maxTurns: 50_000 });
        const prompts = turns.turns
          .filter((t) => t.kind === 'user' && t.text)
          .map((t) => ({ line: t.line, ts: t.ts, tsIso: t.tsIso, ...markPrompt(t.text!) }));
        data = { sessionId: id, prompts, summary: summarizeMarkers(prompts) };
      }
    } catch { data = null; }
    if (data === null) continue;
    const redacted = redactDeep(data, count);
    if (JSON.stringify(redacted).length > maxRowBytes) continue;
    compute.push({ kind, mtime, data: redacted });
  }

  // Outcome-badge row (session_outcome_cache) — what the list badges read.
  // Computed live from the outcome we already ran above.
  let outcomeRow: Record<string, unknown> | null = null;
  if (fullOutcome?.found) {
    outcomeRow = {
      sessionId: id,
      tool: ref.toolId,
      status: fullOutcome.status as any,
      reason: fullOutcome.reason,
      fileMtime: mtime,
      fileSize: 0,
      contentHash: '',
      fileCount: fullOutcome.fileCount,
      linesAdded: fullOutcome.totalLinesAdded,
      linesRemoved: fullOutcome.totalLinesRemoved,
      commits: fullOutcome.commits?.totalCommits ?? 0,
      isFull: true,
      classifiedAt: Date.now(),
      lastScannedOffset: 0,
    };
  }

  return {
    session_id: id,
    mtime,
    compute,
    outcome_row: outcomeRow ? redactDeep({ ...outcomeRow, sessionId: undefined }, count) : null,
  };
  });
}
