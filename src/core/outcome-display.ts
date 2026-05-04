/**
 * Pure formatters for `SessionOutcome` so MCP, web API, and CLI all show
 * the same status emoji and one-liner.
 *
 * The classification logic lives in `session-outcome.ts`. This module only
 * formats — no I/O, no session reads — so it's safe to call anywhere.
 */

import type { SessionOutcome, SessionStatus } from './session-outcome.js';

export function statusEmoji(status: SessionStatus): string {
  switch (status) {
    case 'shipped':     return '🚢';
    case 'interrupted': return '⏸';
    case 'abandoned':   return '🪦';
    case 'in_progress': return '🟡';
    default:            return '❔';
  }
}

/**
 * One-line outcome summary suitable for a list row or chat-recall MCP output.
 *
 * Format: `🚢 shipped — <reason> · 18 files (+200/−40) · 1 commit(s)`
 * Trailing parts are omitted when there's nothing to report (no edits, no
 * commits) so abandoned sessions don't get a misleading "0 files" suffix.
 */
export function outcomeOneLiner(outcome: SessionOutcome): string {
  if (!outcome.found) return '❔ unknown — session not found';

  const head = `${statusEmoji(outcome.status)} ${outcome.status} — ${outcome.reason}`;
  const parts: string[] = [head];

  if (outcome.fileCount > 0) {
    parts.push(`${outcome.fileCount} file${outcome.fileCount === 1 ? '' : 's'} (+${outcome.totalLinesAdded}/−${outcome.totalLinesRemoved})`);
  }
  if (outcome.commits.totalCommits > 0) {
    parts.push(`${outcome.commits.totalCommits} commit${outcome.commits.totalCommits === 1 ? '' : 's'}`);
  }

  return parts.join(' · ');
}

/**
 * Compact status-only summary for badges and list chips. No edit/commit
 * tail, just the emoji + status word — keeps list rows tight.
 */
export function outcomeBadge(outcome: SessionOutcome): { emoji: string; label: SessionStatus | 'unknown'; tooltip: string } {
  if (!outcome.found) {
    return { emoji: '❔', label: 'unknown', tooltip: 'session not found' };
  }
  return {
    emoji: statusEmoji(outcome.status),
    label: outcome.status,
    tooltip: outcome.reason,
  };
}
