import { describe, test, expect } from 'vitest';
import { EMPTY_STATE, planRun, renderRun, type HookState } from './message-hook-core.js';
import type { WireMessage } from '@chat-recall/engine/core/session-messages.js';

const SID = '11111111-0000-4000-8000-000000000001';
const PARENT = '11111111-0000-4000-8000-0000000000f0';
const NOW = 1_750_000_000_000;
const POLL = 15_000;

const msg = (over: Partial<WireMessage> = {}): WireMessage => ({
  id: 'm_1', fromSession: PARENT, toSession: SID, body: 'Run the tests.', replyTo: null,
  createdAt: NOW - 60_000, deliveredAt: NOW, ...over,
});
const introduced: HookState = { lastPoll: NOW - 60_000, introduced: true, stopBlocked: false };

describe('planRun', () => {
  test('ignores a payload with no usable session id or an unknown event', () => {
    expect(planRun({ hook_event_name: 'Stop' }, EMPTY_STATE, NOW, POLL)).toBeNull();
    expect(planRun({ session_id: '../../etc/passwd', hook_event_name: 'Stop' }, EMPTY_STATE, NOW, POLL)).toBeNull();
    expect(planRun({ session_id: SID, hook_event_name: 'Notification' }, EMPTY_STATE, NOW, POLL)).toBeNull();
  });

  test('a tool call inside the poll window does not reach the server', () => {
    const recent = { ...introduced, lastPoll: NOW - 5_000 };
    expect(planRun({ session_id: SID, hook_event_name: 'PostToolUse' }, recent, NOW, POLL)?.skip).toBe(true);
    expect(planRun({ session_id: SID, hook_event_name: 'PostToolUse' }, introduced, NOW, POLL)?.skip).toBe(false);
    // The window applies to tool calls only: a prompt always reports.
    expect(planRun({ session_id: SID, hook_event_name: 'UserPromptSubmit' }, recent, NOW, POLL)?.skip).toBe(false);
  });

  test('a subagent reports state but does not take the session\'s messages', () => {
    const p = planRun({ session_id: SID, hook_event_name: 'PostToolUse', agent_id: 'agent-1' }, introduced, NOW, POLL);
    expect(p).toMatchObject({ skip: false, take: false });
  });

  test('a Stop takes messages once per turn', () => {
    expect(planRun({ session_id: SID, hook_event_name: 'Stop' }, introduced, NOW, POLL)?.take).toBe(true);
    expect(planRun({ session_id: SID, hook_event_name: 'Stop' }, { ...introduced, stopBlocked: true }, NOW, POLL)?.take).toBe(false);
    expect(planRun({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: true }, introduced, NOW, POLL)?.take).toBe(false);
  });

  test('SessionEnd reports the end and takes nothing', () => {
    expect(planRun({ session_id: SID, hook_event_name: 'SessionEnd' }, introduced, NOW, POLL)).toMatchObject({ skip: false, take: false });
  });

  test('passes the working directory through', () => {
    expect(planRun({ session_id: SID, hook_event_name: 'SessionStart', cwd: '/home/user/code/example' }, EMPTY_STATE, NOW, POLL)?.cwd)
      .toBe('/home/user/code/example');
  });
});

describe('renderRun', () => {
  const plan = (event: string, take = true) => ({ sessionId: SID, event, skip: false, take });

  test('SessionStart tells the session its id as plain context', () => {
    const r = renderRun(plan('SessionStart'), [], EMPTY_STATE, NOW);
    expect(r.stdout).toContain(`chat-recall session id: ${SID}`);
    expect(r.stdout.startsWith('{')).toBe(false);
    expect(r.state).toMatchObject({ introduced: true, lastPoll: NOW });
  });

  test('a session that started before the hook is introduced at its first prompt', () => {
    const r = renderRun(plan('UserPromptSubmit'), [], EMPTY_STATE, NOW);
    expect(r.stdout).toContain(`chat-recall session id: ${SID}`);
    const again = renderRun(plan('UserPromptSubmit'), [], r.state, NOW + 1000);
    expect(again.stdout).toBe('');
  });

  test('a prompt delivers messages with the sender and how to answer', () => {
    const r = renderRun(plan('UserPromptSubmit'), [msg()], introduced, NOW);
    expect(r.stdout).toContain('1 message from your other sessions');
    expect(r.stdout).toContain('> Run the tests.');
    expect(r.stdout).toContain(`from: "${SID}", to: "${PARENT}", reply_to: "m_1"`);
    expect(r.stdout).toContain("the user's instruction wins");
  });

  test('names the sender when the server knows its label', () => {
    const r = renderRun(plan('UserPromptSubmit'), [msg()], introduced, NOW, new Map([[PARENT, 'lead']]));
    expect(r.stdout).toContain('From lead (11111111)');
  });

  test('a tool call delivers through additionalContext', () => {
    const r = renderRun(plan('PostToolUse'), [msg()], introduced, NOW);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('Run the tests.');
  });

  test('a tool call with nothing waiting prints nothing', () => {
    expect(renderRun(plan('PostToolUse'), [], introduced, NOW).stdout).toBe('');
  });

  test('a Stop with messages continues the agent once and remembers it', () => {
    const r = renderRun(plan('Stop'), [msg()], introduced, NOW);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Run the tests.');
    expect(r.state.stopBlocked).toBe(true);
    // The next prompt starts a new turn, so the next Stop may continue again.
    expect(renderRun(plan('UserPromptSubmit'), [], r.state, NOW + 1000).state.stopBlocked).toBe(false);
  });

  test('a Stop with no messages never blocks, even before the introduction', () => {
    const r = renderRun(plan('Stop'), [], EMPTY_STATE, NOW);
    expect(r.stdout).toBe('');
    expect(r.state.introduced).toBe(false);
  });

  test('several messages keep their order', () => {
    const r = renderRun(plan('UserPromptSubmit'), [
      msg({ id: 'm_1', body: 'first' }), msg({ id: 'm_2', body: 'second' }),
    ], introduced, NOW);
    expect(r.stdout).toContain('2 messages');
    expect(r.stdout.indexOf('first')).toBeLessThan(r.stdout.indexOf('second'));
  });
});
