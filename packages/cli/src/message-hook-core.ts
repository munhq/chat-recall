/**
 * What the message hook decides, with no I/O, so every branch is testable.
 *
 * Two kinds of run, from the same bundle:
 *
 *   turn hooks   SessionStart, UserPromptSubmit, Stop and SessionEnd. Each one
 *                reports the session's state and delivers what already waits:
 *                plain stdout on SessionStart and UserPromptSubmit, which Claude
 *                Code adds to context; on Stop, decision "block" with the
 *                messages as the reason, so the agent acts on them before it stops.
 *
 *   the waiter   `--wait`, registered with asyncRewake on SessionStart,
 *                UserPromptSubmit and Stop. It runs in the background and
 *                long-polls the server. When a message arrives it writes the
 *                messages to stderr and exits 2, and Claude Code wakes the
 *                session with them, also a session that is idle and waits for
 *                its user. One waiter runs per session.
 */
import { formatDelivery, selfIntroduction, type WireMessage } from '@chat-recall/engine/core/session-messages.js';

export const TURN_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);

/** Per-session state the hook keeps on disk between runs. */
export interface HookState {
  /** The session has been told its own id. */
  introduced: boolean;
  /** A Stop in this turn already continued the agent once. */
  stopBlocked: boolean;
  /** The session's working directory, for a child that this session starts. */
  cwd?: string;
  /** CLAUDE_CONFIG_DIR of the session, so a child starts in the same profile. */
  configDir?: string;
}

export const EMPTY_STATE: HookState = { introduced: false, stopBlocked: false };

export interface HookPayload {
  session_id?: unknown;
  hook_event_name?: unknown;
  cwd?: unknown;
  agent_id?: unknown;
  stop_hook_active?: unknown;
}

/** A Claude session id, or another tool's prefixed id. Also safe as a file name. */
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function sessionIdOf(payload: HookPayload): string | null {
  const id = typeof payload.session_id === 'string' ? payload.session_id : '';
  return SESSION_ID.test(id) ? id : null;
}

export interface HookPlan {
  sessionId: string;
  event: string;
  cwd?: string;
  /** Ask the server for the waiting messages. */
  take: boolean;
}

/**
 * Decide what one turn-hook run does.
 *
 * Messages are not taken inside a subagent. Its context is not the session's,
 * so a message delivered there never reaches the agent that was addressed.
 *
 * A Stop continues the agent at most once per turn. Two sessions that answer
 * each other at every turn end would otherwise keep each other running.
 */
export function planRun(payload: HookPayload, state: HookState): HookPlan | null {
  const sessionId = sessionIdOf(payload);
  const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
  if (!sessionId || !TURN_EVENTS.has(event)) return null;
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined;
  const inSubagent = typeof payload.agent_id === 'string' && payload.agent_id !== '';
  const stopSpent = event === 'Stop' && (state.stopBlocked || payload.stop_hook_active === true);
  const take = !inSubagent && !stopSpent && event !== 'SessionEnd';
  return { sessionId, event, cwd, take };
}

export interface HookResult {
  /** What to write to stdout; empty for nothing. */
  stdout: string;
  state: HookState;
}

/** The output for one turn-hook run, given the messages the server returned. */
export function renderRun(
  plan: HookPlan,
  messages: readonly WireMessage[],
  state: HookState,
  now: number,
  labels: ReadonlyMap<string, string | null> = new Map(),
): HookResult {
  const next: HookState = { ...state, ...(plan.cwd ? { cwd: plan.cwd } : {}) };
  if (plan.event === 'UserPromptSubmit' || plan.event === 'SessionStart') next.stopBlocked = false;

  const parts: string[] = [];
  // The id goes out at SessionStart, and at the first prompt of a session that
  // started before the hook was installed. A compacted session is told again,
  // because its context no longer holds the first introduction.
  const introduce = plan.take && plan.event !== 'Stop' && (plan.event === 'SessionStart' || !state.introduced);
  if (introduce) {
    parts.push(selfIntroduction(plan.sessionId));
    next.introduced = true;
  }
  if (messages.length) parts.push(formatDelivery(plan.sessionId, messages, { now, labels }));
  const text = parts.join('\n\n');
  if (!text) return { stdout: '', state: next };

  if (plan.event === 'Stop') {
    next.stopBlocked = true;
    return { stdout: JSON.stringify({ decision: 'block', reason: text }), state: next };
  }
  return { stdout: text + '\n', state: next };
}

/** The waiter's stderr when messages arrive. Claude Code shows it as a system reminder. */
export function renderWake(
  sessionId: string,
  messages: readonly WireMessage[],
  now: number,
  labels: ReadonlyMap<string, string | null> = new Map(),
): string {
  return formatDelivery(sessionId, messages, { now, labels });
}
