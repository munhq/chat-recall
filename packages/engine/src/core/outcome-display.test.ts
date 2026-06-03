import { describe, test, expect } from 'vitest';
import { statusEmoji, outcomeOneLiner, outcomeBadge } from './outcome-display.js';
import type { SessionOutcome, SessionStatus } from './session-outcome.js';

function mkOutcome(over: Partial<SessionOutcome> = {}): SessionOutcome {
  return {
    sessionId: 'test-sess',
    found: true,
    status: 'in_progress',
    reason: 'most recent activity is within the last 2 hours',
    startMs: 1700000000000,
    endMs: 1700000060000,
    decisions: [],
    blockers: [],
    claimReaction: {},
    prompts: [],
    promptMarkers: { total: 0, interrupt: 0, frustrated: 0, correction: 0, approval: 0, question: 0, directive: 0, clarification_request: 0, peakIntensity: 0 },
    commits: { sessionId: 'test-sess', startMs: 0, endMs: 0, repos: [], totalCommits: 0 },
    fileCount: 0,
    filesChanged: [],
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    ...over,
  };
}

describe('statusEmoji', () => {
  test.each<[SessionStatus, string]>([
    ['shipped', '🚢'],
    ['interrupted', '⏸'],
    ['abandoned', '🪦'],
    ['in_progress', '🟡'],
    ['unknown', '❔'],
  ])('%s → %s', (status, emoji) => {
    expect(statusEmoji(status)).toBe(emoji);
  });
});

describe('outcomeOneLiner', () => {
  test('not-found outcome stays minimal — no zero-files noise', () => {
    const line = outcomeOneLiner(mkOutcome({ found: false, status: 'unknown', reason: 'nope' }));
    expect(line).toBe('❔ unknown — session not found');
  });

  test('shipped session with edits and commits prints all three parts', () => {
    const line = outcomeOneLiner(mkOutcome({
      status: 'shipped',
      reason: 'commits landed in window',
      fileCount: 3,
      totalLinesAdded: 42,
      totalLinesRemoved: 5,
      commits: { sessionId: 'x', startMs: 0, endMs: 0, repos: [], totalCommits: 2 },
    }));
    expect(line).toBe('🚢 shipped — commits landed in window · 3 files (+42/−5) · 2 commits');
  });

  test('abandoned session with no edits shows only the head — no false "0 files"', () => {
    // This was the actual bug: previous formatters appended "0 files (+0/-0)"
    // for abandoned sessions, making them look like they touched something.
    const line = outcomeOneLiner(mkOutcome({
      status: 'abandoned',
      reason: 'no commits, no recent activity',
    }));
    expect(line).toBe('🪦 abandoned — no commits, no recent activity');
    expect(line).not.toContain('0 files');
    expect(line).not.toContain('0 commit');
  });

  test('singular noun when fileCount === 1', () => {
    const line = outcomeOneLiner(mkOutcome({
      status: 'in_progress',
      reason: 'still active',
      fileCount: 1,
      totalLinesAdded: 7,
      totalLinesRemoved: 0,
    }));
    expect(line).toContain('1 file (+7/−0)');
    expect(line).not.toContain('1 files');
  });

  test('singular noun when commit count === 1', () => {
    const line = outcomeOneLiner(mkOutcome({
      status: 'shipped',
      reason: 'one commit landed',
      commits: { sessionId: 'x', startMs: 0, endMs: 0, repos: [], totalCommits: 1 },
    }));
    expect(line).toContain('1 commit');
    expect(line).not.toContain('1 commits');
  });

  test('uses the proper minus sign character (U+2212) — matches MCP outcome formatter', () => {
    const line = outcomeOneLiner(mkOutcome({
      status: 'in_progress',
      fileCount: 2,
      totalLinesAdded: 10,
      totalLinesRemoved: 3,
    }));
    // Sanity: verify we used "−" not "-", since the MCP recall_outcome
    // handler uses the same character. Mismatch would cause UI/MCP drift.
    expect(line).toContain('−3');
  });
});

describe('outcomeBadge', () => {
  test('found outcome → emoji + label + reason as tooltip', () => {
    const b = outcomeBadge(mkOutcome({ status: 'shipped', reason: 'commit landed' }));
    expect(b).toEqual({ emoji: '🚢', label: 'shipped', tooltip: 'commit landed' });
  });

  test('not-found outcome → unknown badge with explanatory tooltip', () => {
    const b = outcomeBadge(mkOutcome({ found: false, status: 'unknown', reason: 'whatever' }));
    expect(b).toEqual({ emoji: '❔', label: 'unknown', tooltip: 'session not found' });
  });
});
