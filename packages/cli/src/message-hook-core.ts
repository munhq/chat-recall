/**
 * What the message hook decides, with no I/O, so every branch is testable.
 *
 * The hook runs on SessionStart, UserPromptSubmit, PostToolUse, Stop and
 * SessionEnd. Each run reports the session's state to the server and receives
 * the messages that wait for it. This module decides whether to ask for them,
 * and how Claude Code must be told about them on each event:
 *
 *   SessionStart, UserPromptSubmit  plain stdout, which Claude Code adds to context
 *   PostToolUse                     hookSpecificOutput.additionalContext
 *   Stop                            decision "block" with the messages as the reason,
 *                                   so the agent continues and acts on them
 */
import { formatDelivery, selfIntroduction, type WireMessage } from '@chat-recall/engine/core/session-messages.js';

export const MESSAGE_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']);

/** Per-session state the hook keeps on disk between runs. */
export interface HookState {
  /** When this session last asked the server, in ms. */
  lastPoll: number;
  /** The session has been told its own id. */
  introduced: boolean;
  /** A Stop in this turn already continued the agent once. */
  stopBlocked: boolean;
}

export const EMPTY_STATE: HookState = { lastPoll: 0, introduced: false, stopBlocked: false };

export interface HookPayload {
  session_id?: unknown;
  hook_event_name?: unknown;
  cwd?: unknown;
  agent_id?: unknown;
  stop_hook_active?: unknown;
}

/** A Claude session id, or another tool's prefixed id. Also safe as a file name. */
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface HookPlan {
  sessionId: string;
  event: string;
  cwd?: string;
  /** Skip the server: a tool call inside the throttle window. */
  skip: boolean;
  /** Ask the server for the waiting messages. */
  take: boolean;
}

/**
 * Decide what one run does, from its payload and the stored state.
 *
 * A tool call reports at most once per `pollMs`: a busy agent makes several
 * tool calls a second, and each report is a network round trip on its path.
 *
 * Messages are not taken inside a subagent. Its context is not the session's,
 * so a message delivered there never reaches the agent that was addressed.
 *
 * A Stop continues the agent at most once per turn. Two sessions that answer
 * each other at every turn end would otherwise keep each other running.
 */
export function planRun(payload: HookPayload, state: HookState, now: number, pollMs: number): HookPlan | null {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
  if (!SESSION_ID.test(sessionId) || !MESSAGE_EVENTS.has(event)) return null;
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined;
  const inSubagent = typeof payload.agent_id === 'string' && payload.agent_id !== '';
  const skip = event === 'PostToolUse' && now - state.lastPoll < pollMs;
  const stopSpent = event === 'Stop' && (state.stopBlocked || payload.stop_hook_active === true);
  const take = !skip && !inSubagent && !stopSpent && event !== 'SessionEnd';
  return { sessionId, event, cwd, skip, take };
}

export interface HookResult {
  /** What to write to stdout; empty for nothing. */
  stdout: string;
  state: HookState;
}

/** The output for one run, given the messages the server returned. */
export function renderRun(
  plan: HookPlan,
  messages: readonly WireMessage[],
  state: HookState,
  now: number,
  labels: ReadonlyMap<string, string | null> = new Map(),
): HookResult {
  const next: HookState = { ...state, lastPoll: now };
  if (plan.event === 'UserPromptSubmit' || plan.event === 'SessionStart') next.stopBlocked = false;

  const parts: string[] = [];
  // The id goes out at SessionStart, and on the first other event of a session
  // that started before the hook was installed. A compacted session is told
  // again, because its context no longer holds the first introduction.
  const introduce = plan.take && (plan.event === 'SessionStart' || !state.introduced);
  if (introduce) {
    parts.push(selfIntroduction(plan.sessionId));
    next.introduced = true;
  }
  if (messages.length) parts.push(formatDelivery(plan.sessionId, messages, { now, labels }));
  const text = parts.join('\n\n');
  if (!text) return { stdout: '', state: next };

  switch (plan.event) {
    case 'SessionStart':
    case 'UserPromptSubmit':
      return { stdout: text + '\n', state: next };
    case 'PostToolUse':
      return {
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }),
        state: next,
      };
    case 'Stop':
      // Only messages justify continuing a finished turn. An introduction
      // alone waits for the next prompt.
      if (!messages.length) return { stdout: '', state: { ...next, introduced: state.introduced } };
      next.stopBlocked = true;
      return { stdout: JSON.stringify({ decision: 'block', reason: text }), state: next };
    default:
      return { stdout: '', state: next };
  }
}
