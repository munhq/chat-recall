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
 *
 * The other tools run the turn hooks with `--tool <id>`. normalizePayload maps
 * each payload to Claude's shape, and renderRun writes the output each tool
 * reads. A tool adds text only at the events in DELIVERS.
 */
import { formatDelivery, selfIntroduction, type WireMessage } from '@chat-recall/engine/core/session-messages.js';

export const TURN_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);

/** The AI tools the message hook runs in. */
export type HookTool = 'claude' | 'codex' | 'agy' | 'cursor' | 'opencode' | 'pi';
export const HOOK_TOOLS: readonly HookTool[] = ['claude', 'codex', 'agy', 'cursor', 'opencode', 'pi'];

/** The session-id prefix of each tool, as its backend writes it. */
export const SESSION_PREFIX: Record<HookTool, string> = {
  claude: '', codex: 'codex_', agy: 'agy_', cursor: 'cursor_', opencode: 'opencode_', pi: 'pi_',
};

/**
 * The events at which each tool adds the hook's text to the session. A Stop in
 * the set continues the agent with the messages.
 *
 * Antigravity injects steps at SessionStart and before a model call, and its
 * Stop has no continuation. Cursor adds context at sessionStart and submits a
 * follow-up at stop; beforeSubmitPrompt can only allow or refuse the prompt.
 * The opencode plugin and the pi extension add text to the prompt.
 */
const DELIVERS: Record<HookTool, ReadonlySet<string>> = {
  claude: new Set(['SessionStart', 'UserPromptSubmit', 'Stop']),
  codex: new Set(['SessionStart', 'UserPromptSubmit', 'Stop']),
  agy: new Set(['SessionStart', 'UserPromptSubmit']),
  cursor: new Set(['SessionStart', 'Stop']),
  opencode: new Set(['SessionStart', 'UserPromptSubmit']),
  pi: new Set(['SessionStart', 'UserPromptSubmit']),
};

export function isHookTool(v: unknown): v is HookTool {
  return typeof v === 'string' && (HOOK_TOOLS as readonly string[]).includes(v);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const first = (v: unknown): string | undefined => (Array.isArray(v) ? str(v[0]) : undefined);

function prefixed(tool: HookTool, id: unknown): string | undefined {
  const raw = str(id);
  if (!raw) return undefined;
  return raw.startsWith(SESSION_PREFIX[tool]) ? raw : SESSION_PREFIX[tool] + raw;
}

const AGY_EVENTS: Record<string, string> = { SessionStart: 'SessionStart', PreInvocation: 'UserPromptSubmit', Stop: 'Stop' };
const CURSOR_EVENTS: Record<string, string> = {
  sessionStart: 'SessionStart', beforeSubmitPrompt: 'UserPromptSubmit', stop: 'Stop', sessionEnd: 'SessionEnd',
};

/**
 * One tool's hook payload in the shape planRun reads, or null for an event
 * this hook does not handle.
 *
 * Antigravity names no event in its payload, so its registration passes the
 * event as `--event`. It runs PreInvocation before every model call of a turn;
 * only the first one (`invocationNum` 0) is the prompt. A Cursor stop with
 * `loop_count` above 0 comes after a follow-up, as Claude's `stop_hook_active`
 * does.
 */
export function normalizePayload(tool: HookTool, raw: Record<string, unknown>, event?: string): HookPayload | null {
  switch (tool) {
    case 'claude':
      return raw;
    case 'agy': {
      const ev = AGY_EVENTS[event ?? ''];
      if (!ev) return null;
      if (ev === 'UserPromptSubmit' && raw.invocationNum !== 0) return null;
      return { session_id: prefixed(tool, raw.conversationId), hook_event_name: ev, cwd: first(raw.workspacePaths) };
    }
    case 'cursor': {
      const ev = CURSOR_EVENTS[String(raw.hook_event_name ?? '')];
      if (!ev) return null;
      return {
        session_id: prefixed(tool, raw.conversation_id ?? raw.session_id),
        hook_event_name: ev,
        cwd: first(raw.workspace_roots),
        stop_hook_active: typeof raw.loop_count === 'number' && raw.loop_count > 0,
      };
    }
    default:
      return { ...raw, session_id: prefixed(tool, raw.session_id) };
  }
}

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
export function planRun(payload: HookPayload, state: HookState, tool: HookTool = 'claude'): HookPlan | null {
  const sessionId = sessionIdOf(payload);
  const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
  if (!sessionId || !TURN_EVENTS.has(event)) return null;
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined;
  const inSubagent = typeof payload.agent_id === 'string' && payload.agent_id !== '';
  const stopSpent = event === 'Stop' && (state.stopBlocked || payload.stop_hook_active === true);
  const take = !inSubagent && !stopSpent && DELIVERS[tool].has(event);
  return { sessionId, event, cwd, take };
}

export interface HookResult {
  /** What to write to stdout; empty for nothing. */
  stdout: string;
  state: HookState;
}

/** The text in the form each tool reads from a hook's stdout. */
function wrapFor(tool: HookTool, event: string, text: string): string {
  if (tool === 'agy') return JSON.stringify({ injectSteps: [{ userMessage: text }] });
  if (tool === 'cursor') return JSON.stringify(event === 'Stop' ? { followup_message: text } : { additional_context: text });
  if (event === 'Stop') return JSON.stringify({ decision: 'block', reason: text });
  return text + '\n';
}

/**
 * What a run prints when it has nothing to add. Cursor reads a JSON object
 * from every hook, and `beforeSubmitPrompt` must allow the prompt.
 */
export function emptyOutput(tool: HookTool, event: string): string {
  if (tool !== 'cursor') return '';
  return event === 'UserPromptSubmit' ? '{"continue":true}' : '{}';
}

/** The output for one turn-hook run, given the messages the server returned. */
export function renderRun(
  plan: HookPlan,
  messages: readonly WireMessage[],
  state: HookState,
  now: number,
  labels: ReadonlyMap<string, string | null> = new Map(),
  tool: HookTool = 'claude',
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
  }
  return { stdout: wrapFor(tool, plan.event, text), state: next };
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
