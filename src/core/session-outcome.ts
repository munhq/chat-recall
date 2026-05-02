/**
 * Outcome + decisions + blockers + last-claim-vs-reaction.
 *
 * Aggregates everything you need to answer "what actually happened in this
 * session?" without an LLM call:
 *
 *   - decisions      : assistant statements that announced a path forward
 *                      ("I'll do X", "Going to Y", "Let me Z")
 *   - blockers       : tool errors, build failures, request interrupts
 *   - lastClaim      : the final assistant text turn — what the agent said
 *                      it had finished or was about to do
 *   - lastReaction   : the user's response after that — "thanks" vs "wtf"
 *                      tells you whether the claim landed
 *   - status         : shipped (commits in window) | interrupted (last user
 *                      message is an interrupt) | abandoned (no commits + no
 *                      recent activity + last assistant turn ended on a
 *                      question) | in_progress (recent activity, no clear
 *                      end state)
 *
 * Pure heuristic. The point isn't to be perfect — it's to surface a useful
 * triage signal that the gemini-summary doesn't.
 */

import { extractTurns, type SessionTurn } from './session-turns.js';
import { markPrompt, summarizeMarkers, type SessionMarkerCounts, type MarkedPrompt } from './session-sentiment.js';
import { replaySession } from './session-replay.js';
import { getSessionCommits, type SessionCommitsResult } from './session-git.js';

export type SessionStatus = 'shipped' | 'interrupted' | 'abandoned' | 'in_progress' | 'unknown';

export interface SessionDecision {
  text: string;
  ts: number;
  tsIso?: string;
  line: number;
}

export interface SessionBlocker {
  kind: 'tool_error' | 'interrupt' | 'unknown_error';
  text: string;
  ts: number;
  tsIso?: string;
  line: number;
}

export interface ClaimReactionPair {
  claim?: { text: string; ts: number; tsIso?: string; line: number };
  reaction?: {
    text: string;
    ts: number;
    tsIso?: string;
    line: number;
    markers: ReturnType<typeof markPrompt>['markers'];
    intensity: number;
  };
}

export interface SessionOutcome {
  sessionId: string;
  found: boolean;
  status: SessionStatus;
  reason: string;            // human-readable justification for the status
  startMs: number;
  endMs: number;
  decisions: SessionDecision[];
  blockers: SessionBlocker[];
  claimReaction: ClaimReactionPair;
  prompts: MarkedPrompt[];
  promptMarkers: SessionMarkerCounts;
  commits: SessionCommitsResult;
  fileCount: number;
  filesChanged: string[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
}

const DECISION_PATTERNS: RegExp[] = [
  /\b(?:I'?ll|I will|I'?m going to|Going to|Let me|We'?ll|We will|We should|Let'?s|I'?m about to|I'?m going to)\b[^\n.!?]*[.!?]/i,
  /\b(?:Decided|Decision|Plan|The plan is|Approach)\s*[:—-]\s*[^\n]*/i,
  /^(?:Done|Shipped|Fixed|Implemented|Created|Updated|Added|Removed|Rolled back|Reverted|Committed|Merged|Pushed)\b[^\n.!?]*[.!?]/i,
];

function extractDecisionsFromTurn(turn: SessionTurn): SessionDecision[] {
  if (turn.kind !== 'assistant_text' || !turn.text) return [];
  const out: SessionDecision[] = [];
  for (const pat of DECISION_PATTERNS) {
    const m = turn.text.match(pat);
    if (m) {
      const text = m[0].replace(/\s+/g, ' ').trim();
      if (text.length > 20 && text.length < 280) {
        out.push({ text, ts: turn.ts, tsIso: turn.tsIso, line: turn.line });
        // Only one decision per turn — keeps output tight.
        break;
      }
    }
  }
  return out;
}

function findLastClaimAndReaction(turns: SessionTurn[]): ClaimReactionPair {
  // Walk turns from the end. Find last assistant_text. Then find first user
  // turn that came after it. That pair is the claim/reaction.
  let lastAssistantIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].kind === 'assistant_text' && turns[i].text && turns[i].text!.trim().length > 30) {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) return {};
  const claim = turns[lastAssistantIdx];

  let reaction: SessionTurn | undefined;
  for (let i = lastAssistantIdx + 1; i < turns.length; i++) {
    if (turns[i].kind === 'user' && turns[i].text && turns[i].text!.trim().length > 0) {
      reaction = turns[i];
      break;
    }
  }

  if (!reaction) {
    return {
      claim: { text: claim.text!, ts: claim.ts, tsIso: claim.tsIso, line: claim.line },
    };
  }
  const marked = markPrompt(reaction.text!);
  return {
    claim: { text: claim.text!, ts: claim.ts, tsIso: claim.tsIso, line: claim.line },
    reaction: {
      text: reaction.text!,
      ts: reaction.ts,
      tsIso: reaction.tsIso,
      line: reaction.line,
      markers: marked.markers,
      intensity: marked.intensity,
    },
  };
}

function classifyStatus(opts: {
  hasCommits: boolean;
  prompts: MarkedPrompt[];
  turns: SessionTurn[];
  endMs: number;
  filesChanged: number;
}): { status: SessionStatus; reason: string } {
  // Last user prompt determines whether we ended on an interrupt.
  const lastPrompt = opts.prompts[opts.prompts.length - 1];
  if (lastPrompt && lastPrompt.markers.includes('interrupt')) {
    return { status: 'interrupted', reason: 'last user message was an interrupt' };
  }

  // Recent activity — if endMs is within 2h of now, treat as in-progress.
  const ageHours = (Date.now() - opts.endMs) / (3600 * 1000);
  if (ageHours < 2) {
    return { status: 'in_progress', reason: 'most recent activity is within the last 2 hours' };
  }

  if (opts.hasCommits) {
    return { status: 'shipped', reason: 'commits landed in repos that the session edited during its window' };
  }

  if (opts.filesChanged === 0) {
    // Nothing changed and no commits — pure conversation/exploration.
    return { status: 'unknown', reason: 'no file edits and no commits in window' };
  }

  // Last assistant turn ended in a question? — abandoned waiting.
  const lastAssistant = [...opts.turns].reverse().find(t => t.kind === 'assistant_text' && t.text);
  if (lastAssistant && lastAssistant.text && /\?\s*$/.test(lastAssistant.text.trim())) {
    return { status: 'abandoned', reason: 'last assistant turn ended on a question and nothing landed' };
  }

  return { status: 'abandoned', reason: 'edits made but no commits — work stayed local' };
}

export function computeOutcome(sessionId: string, opts: { commitBufferMinutes?: number } = {}): SessionOutcome {
  const turnsRes = extractTurns(sessionId, { assistantMax: 2000 });
  if (!turnsRes.found) {
    return {
      sessionId, found: false, status: 'unknown', reason: 'session not found',
      startMs: 0, endMs: 0,
      decisions: [], blockers: [], claimReaction: {},
      prompts: [],
      promptMarkers: { total: 0, interrupt: 0, frustrated: 0, correction: 0, approval: 0, question: 0, directive: 0, clarification_request: 0, peakIntensity: 0 },
      commits: { sessionId, startMs: 0, endMs: 0, repos: [], totalCommits: 0 },
      fileCount: 0, filesChanged: [], totalLinesAdded: 0, totalLinesRemoved: 0,
    };
  }

  // Decisions and blockers, pulled from the in-order turn stream.
  const decisions: SessionDecision[] = [];
  const blockers: SessionBlocker[] = [];
  for (const t of turnsRes.turns) {
    if (t.kind === 'assistant_text') decisions.push(...extractDecisionsFromTurn(t));
    if (t.kind === 'tool_result' && t.resultIsError) {
      blockers.push({
        kind: 'tool_error',
        text: t.resultSummary?.slice(0, 240) || 'tool error',
        ts: t.ts, tsIso: t.tsIso, line: t.line,
      });
    }
  }

  // Prompts → markers.
  const prompts: MarkedPrompt[] = [];
  for (const t of turnsRes.turns) {
    if (t.kind === 'user' && t.text) prompts.push(markPrompt(t.text));
  }
  // Add interrupt blockers from prompt markers — they don't show up as tool errors.
  for (const p of prompts) {
    if (p.markers.includes('interrupt')) {
      blockers.push({ kind: 'interrupt', text: p.text.slice(0, 200), ts: 0, line: 0 });
    }
  }
  const promptMarkers = summarizeMarkers(prompts);

  const claimReaction = findLastClaimAndReaction(turnsRes.turns);

  // Replay → file changes → commits in window.
  const replay = replaySession(sessionId);
  const filesChanged = replay.files.map(f => f.file);
  const commits = getSessionCommits(
    sessionId,
    filesChanged,
    turnsRes.startMs,
    turnsRes.endMs,
    opts.commitBufferMinutes,
  );

  const { status, reason } = classifyStatus({
    hasCommits: commits.totalCommits > 0,
    prompts,
    turns: turnsRes.turns,
    endMs: turnsRes.endMs,
    filesChanged: filesChanged.length,
  });

  return {
    sessionId,
    found: true,
    status,
    reason,
    startMs: turnsRes.startMs,
    endMs: turnsRes.endMs,
    decisions: decisions.slice(0, 30),
    blockers: blockers.slice(0, 30),
    claimReaction,
    prompts,
    promptMarkers,
    commits,
    fileCount: filesChanged.length,
    filesChanged,
    totalLinesAdded: replay.totalLinesAdded,
    totalLinesRemoved: replay.totalLinesRemoved,
  };
}
