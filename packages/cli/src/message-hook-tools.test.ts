/**
 * The message hook in the AI tools that are not Claude Code: each payload maps
 * to the right session id and event, and each tool gets its own output.
 *
 * The payloads are the shapes the tools send: Antigravity's from a probe hook
 * (agy 1.4.11), Codex's and Cursor's from their hook documentation.
 */
import { describe, test, expect } from 'vitest';
import {
  EMPTY_STATE, SESSION_PREFIX, normalizePayload, planRun, renderRun, type HookState,
} from './message-hook-core.js';
import { codexBackend, agyBackend, cursorBackend, opencodeBackend } from '@chat-recall/engine/core/backends/index.js';
import type { WireMessage } from '@chat-recall/engine/core/session-messages.js';

const UUID = '11111111-0000-4000-8000-000000000001';
const NOW = 1_750_000_000_000;
const introduced: HookState = { introduced: true, stopBlocked: false };
const msg: WireMessage = {
  id: 'm_1', fromSession: '11111111-0000-4000-8000-0000000000f0', toSession: `agy_${UUID}`, body: 'Run the tests.',
  replyTo: null, createdAt: NOW - 60_000, deliveredAt: null,
};

describe('session prefixes', () => {
  test('match the prefix each backend writes', () => {
    expect(SESSION_PREFIX.codex).toBe(codexBackend.idPrefix);
    expect(SESSION_PREFIX.agy).toBe(agyBackend.idPrefix);
    expect(SESSION_PREFIX.cursor).toBe(cursorBackend.idPrefix);
    expect(SESSION_PREFIX.opencode).toBe(opencodeBackend.idPrefix);
  });
});

describe('Antigravity', () => {
  const base = { conversationId: UUID, workspacePaths: ['/home/user/code/example'], modelName: 'm' };

  test('the event comes from the registration, and the session id gets the prefix', () => {
    expect(normalizePayload('agy', base, 'SessionStart'))
      .toEqual({ session_id: `agy_${UUID}`, hook_event_name: 'SessionStart', cwd: '/home/user/code/example' });
    expect(normalizePayload('agy', { ...base, invocationNum: 0 }, 'PreInvocation')?.hook_event_name).toBe('UserPromptSubmit');
    expect(normalizePayload('agy', base, 'Stop')?.hook_event_name).toBe('Stop');
  });

  test('only the first model call of a turn is the prompt', () => {
    expect(normalizePayload('agy', { ...base, invocationNum: 3 }, 'PreInvocation')).toBeNull();
    expect(normalizePayload('agy', base, undefined)).toBeNull();
  });

  test('messages go out as an injected step, and a Stop takes none', () => {
    const plan = planRun(normalizePayload('agy', { ...base, invocationNum: 0 }, 'PreInvocation')!, introduced, 'agy')!;
    expect(plan.take).toBe(true);
    const out = JSON.parse(renderRun(plan, [msg], introduced, NOW, new Map(), 'agy').stdout);
    expect(out.injectSteps[0].userMessage).toContain('Run the tests.');
    expect(planRun(normalizePayload('agy', base, 'Stop')!, introduced, 'agy')!.take).toBe(false);
  });
});

describe('Codex', () => {
  test('keeps Claude\'s events and output, with the codex_ prefix', () => {
    const payload = normalizePayload('codex', { session_id: UUID, hook_event_name: 'Stop', cwd: '/home/user/code/example' })!;
    expect(payload.session_id).toBe(`codex_${UUID}`);
    const plan = planRun(payload, introduced, 'codex')!;
    expect(plan.take).toBe(true);
    const out = JSON.parse(renderRun(plan, [msg], introduced, NOW, new Map(), 'codex').stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Run the tests.');
  });

  test('an id that already has the prefix is kept', () => {
    expect(normalizePayload('codex', { session_id: `codex_${UUID}`, hook_event_name: 'SessionStart' })!.session_id).toBe(`codex_${UUID}`);
  });
});

describe('Cursor', () => {
  const base = { conversation_id: UUID, workspace_roots: ['/home/user/code/example'] };

  test('maps the camelCase events', () => {
    expect(normalizePayload('cursor', { ...base, hook_event_name: 'sessionStart' })?.hook_event_name).toBe('SessionStart');
    expect(normalizePayload('cursor', { ...base, hook_event_name: 'beforeSubmitPrompt' })?.hook_event_name).toBe('UserPromptSubmit');
    expect(normalizePayload('cursor', { ...base, hook_event_name: 'afterFileEdit' })).toBeNull();
  });

  test('a prompt reports state only; sessionStart adds context; stop submits a follow-up', () => {
    const prompt = planRun(normalizePayload('cursor', { ...base, hook_event_name: 'beforeSubmitPrompt' })!, introduced, 'cursor')!;
    expect(prompt.take).toBe(false);

    const start = planRun(normalizePayload('cursor', { ...base, hook_event_name: 'sessionStart' })!, EMPTY_STATE, 'cursor')!;
    expect(JSON.parse(renderRun(start, [], EMPTY_STATE, NOW, new Map(), 'cursor').stdout).additional_context).toContain(`cursor_${UUID}`);

    const stop = planRun(normalizePayload('cursor', { ...base, hook_event_name: 'stop', loop_count: 0 })!, introduced, 'cursor')!;
    expect(JSON.parse(renderRun(stop, [msg], introduced, NOW, new Map(), 'cursor').stdout).followup_message).toContain('Run the tests.');
  });

  test('a stop after a follow-up takes nothing, so two sessions cannot keep each other running', () => {
    const stop = planRun(normalizePayload('cursor', { ...base, hook_event_name: 'stop', loop_count: 1 })!, introduced, 'cursor')!;
    expect(stop.take).toBe(false);
  });
});

describe('opencode and pi', () => {
  test('the plugin sends Claude\'s shape; the hook adds the prefix and prints plain text', () => {
    for (const tool of ['opencode', 'pi'] as const) {
      const payload = normalizePayload(tool, { session_id: 'ses_abc', hook_event_name: 'UserPromptSubmit' })!;
      expect(payload.session_id).toBe(`${SESSION_PREFIX[tool]}ses_abc`);
      const plan = planRun(payload, introduced, tool)!;
      const out = renderRun(plan, [msg], introduced, NOW, new Map(), tool).stdout;
      expect(out).toContain('Run the tests.');
      expect(() => JSON.parse(out)).toThrow();
      expect(planRun({ ...payload, hook_event_name: 'Stop' }, introduced, tool)!.take).toBe(false);
    }
  });
});

describe('emptyOutput', () => {
  test('Cursor always gets a JSON object, and its prompt hook allows the prompt', async () => {
    const { emptyOutput } = await import('./message-hook-core.js');
    expect(JSON.parse(emptyOutput('cursor', 'UserPromptSubmit'))).toEqual({ continue: true });
    expect(JSON.parse(emptyOutput('cursor', 'Stop'))).toEqual({});
    expect(emptyOutput('codex', 'Stop')).toBe('');
    expect(emptyOutput('agy', 'UserPromptSubmit')).toBe('');
  });
});

describe('opencode prompts carry only messages', () => {
  test('the first prompt of an opencode session gets the messages and no intro', () => {
    const payload = normalizePayload('opencode', { session_id: 'ses_abc', hook_event_name: 'UserPromptSubmit' })!;
    const plan = planRun(payload, EMPTY_STATE, 'opencode')!;
    const out = renderRun(plan, [msg], EMPTY_STATE, NOW, new Map(), 'opencode').stdout;
    expect(out).toContain('Run the tests.');
    expect(out).not.toContain('chat-recall session id');
    expect(renderRun(plan, [], EMPTY_STATE, NOW, new Map(), 'opencode').stdout).toBe('');
  });
});
