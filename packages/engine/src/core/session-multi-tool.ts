/**
 * Thin registry-routed dispatchers. After Phase 10 every backend owns
 * its full pipeline (readEvents → extractTurns / liveScanEdits / replay
 * via the canonical-event engine), so this module is just two
 * one-liners that resolve a backend and forward.
 *
 * For computeOutcome: import directly from `./session-outcome.js` — it's
 * tool-agnostic itself (routes through the registry internally).
 */

import { getBackendForId } from './tool-backend.js';
import { memoInSessionScope } from './live-session-scan.js';
// Side-effect: ensure backends are registered. live-session-scan already
// triggers this transitively, but the explicit import documents intent.
import './backends/index.js';
import type { ExtractedTurns } from './session-turns.js';
import type { SessionDiffResult } from './session-replay.js';

/**
 * Extract turns for any AI tool. Returns `found: false` for ids no
 * registered backend recognizes.
 */
export function extractTurnsAny(
  sessionId: string,
  opts: { maxTurns?: number; assistantMax?: number } = {},
): ExtractedTurns {
  const backend = getBackendForId(sessionId);
  if (!backend) return { sessionId, found: false, turns: [], startMs: 0, endMs: 0 };
  // Once per open read scope. The options are in the key because they change
  // the answer: assistantMax 2000 for the outcome and maxTurns 50000 for the
  // markers are two different extractions of the same file.
  return memoInSessionScope(
    `turns:${sessionId}:${opts.maxTurns ?? ''}:${opts.assistantMax ?? ''}`,
    () => backend.extractTurns(sessionId, opts),
  );
}

/**
 * Build a per-file diff result for any AI tool's session.
 */
export function replaySessionAny(sessionId: string): SessionDiffResult {
  const backend = getBackendForId(sessionId);
  if (!backend) return { sessionId, found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };
  // The single most expensive call in a derive, and it ran twice.
  return memoInSessionScope(`replay:${sessionId}`, () => backend.replay(sessionId));
}

