import { describe, test, expect } from 'vitest';
import { formatAge, formatDelivery, formatSessionLine, sessionName, shortId, type WireLiveSession } from './session-messages.js';

const NOW = 1_750_000_000_000;
const A = '11111111-0000-4000-8000-0000000000a1';

const session = (over: Partial<WireLiveSession> = {}): WireLiveSession => ({
  sessionId: A, label: null, parentSession: null, cwd: null, doing: null, state: 'working',
  lastEvent: 'PostToolUse', startedAt: NOW - 3_600_000, updatedAt: NOW - 30_000, unread: 0, ...over,
});

describe('formatAge', () => {
  test('picks the largest whole unit', () => {
    expect(formatAge(40_000)).toBe('40s');
    expect(formatAge(12 * 60_000)).toBe('12m');
    expect(formatAge(3 * 3_600_000)).toBe('3h');
    expect(formatAge(72 * 3_600_000)).toBe('3d');
    expect(formatAge(-5)).toBe('0s');
  });
});

describe('names', () => {
  test('a long id is shortened, a short one is kept', () => {
    expect(shortId(A)).toBe('11111111');
    expect(shortId('m_abc')).toBe('m_abc');
  });

  test('a label leads when there is one', () => {
    expect(sessionName(A, new Map([[A, 'worker-a']]))).toBe('worker-a (11111111)');
    expect(sessionName(A)).toBe('11111111');
  });
});

describe('formatDelivery', () => {
  test('is empty with no messages', () => {
    expect(formatDelivery(A, [])).toBe('');
  });

  test('quotes every line of a multi-line body', () => {
    const out = formatDelivery(A, [{
      id: 'm_1', fromSession: null, toSession: A, body: 'one\ntwo', replyTo: null, createdAt: NOW, deliveredAt: NOW,
    }], { now: NOW });
    expect(out).toContain('> one\n> two');
    expect(out).toContain('a session with no id');
    // No sender, so there is nobody to answer.
    expect(out).not.toContain('recall_message_send');
  });
});

describe('formatSessionLine', () => {
  test('describes each state', () => {
    expect(formatSessionLine(session(), NOW)).toContain('working, last activity 30s ago');
    expect(formatSessionLine(session({ state: 'idle', updatedAt: NOW - 120_000 }), NOW)).toContain('idle for 2m, waiting for input');
    expect(formatSessionLine(session({ state: 'ended' }), NOW)).toContain('ended 30s ago');
  });

  test('shows what the session works on and its cards, one per line', () => {
    const line = formatSessionLine(session({ doing: 'Fix the login redirect', cards: [{ id: 't_1', title: 'Login bug', status: 'in_progress' }] }), NOW);
    expect(line.split('\n')).toEqual([
      expect.stringContaining('working'),
      '  doing: Fix the login redirect',
      '  card t_1: Login bug',
    ]);
  });

  test('a session whose waiter stopped polling is gone, whatever its last event said', () => {
    expect(formatSessionLine(session({ lastSeen: NOW - 5 * 60_000 }), NOW)).toContain('gone: no poll for 5m');
    expect(formatSessionLine(session({ state: 'idle', lastSeen: NOW - 20_000 }), NOW)).toContain('idle for');
    // A session without the waiter (another AI tool) is never judged gone.
    expect(formatSessionLine(session({ lastSeen: null, updatedAt: NOW - 3_600_000 }), NOW)).toContain('working');
  });

  test('a child that waits for a permission prompt says how to open it', () => {
    const line = formatSessionLine(session({ local: { id: 'abc12345', kind: 'background', waitingFor: 'permission prompt' } }), NOW);
    expect(line).toContain('blocked: waiting for a permission prompt — open it with `claude attach abc12345`');
  });

  test('shows the label, the unread count and the folder', () => {
    const line = formatSessionLine(session({ label: 'worker-a', unread: 2, cwd: '/home/user/code/example' }), NOW);
    expect(line).toContain(`**worker-a** (${A})`);
    expect(line).toContain('2 unread');
    expect(line).toContain('in /home/user/code/example');
  });
});
