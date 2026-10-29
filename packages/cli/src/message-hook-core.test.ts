import { describe, test, expect } from 'vitest';
import { EMPTY_STATE, planRun, renderRun, renderWake, type HookState } from './message-hook-core.js';
import type { WireMessage } from '@chat-recall/engine/core/session-messages.js';

const SID = '11111111-0000-4000-8000-000000000001';
const PARENT = '11111111-0000-4000-8000-0000000000f0';
const NOW = 1_750_000_000_000;

const msg = (over: Partial<WireMessage> = {}): WireMessage => ({
  id: 'm_1', fromSession: PARENT, toSession: SID, body: 'Run the tests.', replyTo: null,
  createdAt: NOW - 60_000, deliveredAt: null, ...over,
});
const introduced: HookState = { introduced: true, stopBlocked: false };

describe('planRun', () => {
  test('ignores a payload with no usable session id or an event the turn hook does not handle', () => {
    expect(planRun({ hook_event_name: 'Stop' }, EMPTY_STATE)).toBeNull();
    expect(planRun({ session_id: '../../etc/passwd', hook_event_name: 'Stop' }, EMPTY_STATE)).toBeNull();
    expect(planRun({ session_id: SID, hook_event_name: 'PostToolUse' }, EMPTY_STATE)).toBeNull();
    expect(planRun({ session_id: SID, hook_event_name: 'Notification' }, EMPTY_STATE)).toBeNull();
  });

  test('a subagent reports state but does not take the session\'s messages', () => {
    expect(planRun({ session_id: SID, hook_event_name: 'UserPromptSubmit', agent_id: 'agent-1' }, introduced)?.take).toBe(false);
  });

  test('a Stop takes messages once per turn', () => {
    expect(planRun({ session_id: SID, hook_event_name: 'Stop' }, introduced)?.take).toBe(true);
    expect(planRun({ session_id: SID, hook_event_name: 'Stop' }, { ...introduced, stopBlocked: true })?.take).toBe(false);
    expect(planRun({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: true }, introduced)?.take).toBe(false);
  });

  test('SessionEnd reports the end and takes nothing', () => {
    expect(planRun({ session_id: SID, hook_event_name: 'SessionEnd' }, introduced)?.take).toBe(false);
  });

  test('passes the working directory through', () => {
    expect(planRun({ session_id: SID, hook_event_name: 'SessionStart', cwd: '/home/user/code/example' }, EMPTY_STATE)?.cwd)
      .toBe('/home/user/code/example');
  });
});

describe('renderRun', () => {
  const plan = (event: string, take = true) => ({ sessionId: SID, event, take, cwd: '/home/user/code/example' });

  test('SessionStart tells the session its id as plain context, and records the folder', () => {
    const r = renderRun(plan('SessionStart'), [], EMPTY_STATE, NOW);
    expect(r.stdout).toContain(`chat-recall session id: ${SID}`);
    expect(r.stdout.startsWith('{')).toBe(false);
    expect(r.state).toMatchObject({ introduced: true, cwd: '/home/user/code/example' });
  });

  test('a session that started before the hook is introduced at its first prompt, once', () => {
    const r = renderRun(plan('UserPromptSubmit'), [], EMPTY_STATE, NOW);
    expect(r.stdout).toContain(`chat-recall session id: ${SID}`);
    expect(renderRun(plan('UserPromptSubmit'), [], r.state, NOW).stdout).toBe('');
  });

  test('a prompt delivers messages with the sender and how to answer', () => {
    const r = renderRun(plan('UserPromptSubmit'), [msg()], introduced, NOW, new Map([[PARENT, 'lead']]));
    expect(r.stdout).toContain('1 message from your other sessions');
    expect(r.stdout).toContain('From lead (11111111)');
    expect(r.stdout).toContain('> Run the tests.');
    expect(r.stdout).toContain(`from: "${SID}", to: "${PARENT}", reply_to: "m_1"`);
    expect(r.stdout).toContain("the user's instruction wins");
  });

  test('a Stop with messages continues the agent once and remembers it', () => {
    const r = renderRun(plan('Stop'), [msg()], introduced, NOW);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Run the tests.');
    expect(r.state.stopBlocked).toBe(true);
    // The next prompt starts a new turn, so the next Stop may continue again.
    expect(renderRun(plan('UserPromptSubmit'), [], r.state, NOW).state.stopBlocked).toBe(false);
  });

  test('a Stop with nothing waiting never blocks, and never introduces', () => {
    const r = renderRun(plan('Stop'), [], EMPTY_STATE, NOW);
    expect(r.stdout).toBe('');
    expect(r.state.introduced).toBe(false);
  });

  test('several messages keep their order', () => {
    const r = renderRun(plan('UserPromptSubmit'), [msg({ id: 'm_1', body: 'first' }), msg({ id: 'm_2', body: 'second' })], introduced, NOW);
    expect(r.stdout).toContain('2 messages');
    expect(r.stdout.indexOf('first')).toBeLessThan(r.stdout.indexOf('second'));
  });
});

describe('renderWake', () => {
  test('is the delivery text the waiter writes to stderr', () => {
    const text = renderWake(SID, [msg()], NOW, new Map([[PARENT, 'lead']]));
    expect(text).toContain('<!-- chat-recall-messages -->');
    expect(text).toContain('From lead (11111111)');
    expect(text).toContain('> Run the tests.');
  });
});
