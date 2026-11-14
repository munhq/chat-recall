/**
 * The guards that keep one walk bounded (issue #16).
 *
 * Measured on a machine with 12,224 local sessions: listing them all costs
 * ~92 MiB, and one unbounded walk churned several hundred MiB of buffers that
 * V8 never returned to the OS. The unit peaked at 1.6 GiB against a 2 GiB cap
 * and systemd killed it 15 times in one day, and every restart began the corpus
 * again from the first session.
 */
import { describe, test, expect } from 'vitest';
import {
  walkSessionLimit, orderRefsForWalk, shouldWalkFull, mayTombstone,
  DEFAULT_WALK_MAX_SESSIONS, FULL_WALK_INTERVAL_MS,
} from './walk-budget.js';

type Ref = { prefixedId: string };
const refs = (n: number): Ref[] => Array.from({ length: n }, (_, i) => ({ prefixedId: `session-${i}` }));

describe('walkSessionLimit', () => {
  test('the default bounds one walk', () => {
    expect(walkSessionLimit({})).toBe(DEFAULT_WALK_MAX_SESSIONS);
  });

  test('an explicit value is honoured', () => {
    expect(walkSessionLimit({ CHAT_RECALL_SYNC_WALK_MAX: '50' })).toBe(50);
  });

  test.each(['0', '-5', 'abc', '1.5', '  '])('a value that cannot bound the walk keeps the default (%s)', (value) => {
    expect(walkSessionLimit({ CHAT_RECALL_SYNC_WALK_MAX: value })).toBe(DEFAULT_WALK_MAX_SESSIONS);
  });
});

describe('orderRefsForWalk', () => {
  test('unacknowledged sessions come first and the order inside each group holds', () => {
    const input = refs(6);
    const acked = new Set(['session-0', 'session-1', 'session-4']);
    expect(orderRefsForWalk(input, (id) => acked.has(id)).map((r) => r.prefixedId))
      .toEqual(['session-2', 'session-3', 'session-5', 'session-0', 'session-1', 'session-4']);
  });

  test('every session is carried exactly once', () => {
    const input = refs(500);
    const acked = new Set(input.filter((_, i) => i % 3 === 0).map((r) => r.prefixedId));
    const ordered = orderRefsForWalk(input, (id) => acked.has(id));
    expect(ordered).toHaveLength(input.length);
    expect(new Set(ordered.map((r) => r.prefixedId)).size).toBe(input.length);
  });
});

describe('a large session set stays bounded and still finishes', () => {
  const LARGE = 20_000;
  const cap = walkSessionLimit({});

  test('one walk of 20,000 sessions carries the cap, and it carries the new sessions first', () => {
    const input = refs(LARGE);
    const acked = new Set(input.slice(0, LARGE - 50).map((r) => r.prefixedId));
    const slice = orderRefsForWalk(input, (id) => acked.has(id)).slice(0, cap);
    expect(slice.length).toBe(cap);
    // The 50 sessions the server has never seen are all in THIS walk.
    for (const ref of input.slice(LARGE - 50)) expect(slice).toContain(ref);
  });

  test('repeated bounded walks reach every session', () => {
    const input = refs(LARGE);
    const done = new Set<string>();
    let walks = 0;
    while (done.size < LARGE && walks < 20) {
      for (const ref of orderRefsForWalk(input, (id) => done.has(id)).slice(0, cap)) done.add(ref.prefixedId);
      walks += 1;
    }
    expect(done.size).toBe(LARGE);
    expect(walks).toBe(Math.ceil(LARGE / cap));
  });
});

describe('shouldWalkFull', () => {
  const now = 1_800_000_000_000;

  test('a machine that never walked walks everything', () => {
    expect(shouldWalkFull({ now })).toBe(true);
    expect(shouldWalkFull({ lastSuccessAt: 0, now })).toBe(true);
  });

  test('a restart after a recent success does not walk everything', () => {
    expect(shouldWalkFull({ lastSuccessAt: now - 60_000, now })).toBe(false);
    expect(shouldWalkFull({ lastSuccessAt: now - 5 * 60 * 60_000, now })).toBe(false);
  });

  test('a walk older than the interval is due again', () => {
    expect(shouldWalkFull({ lastSuccessAt: now - FULL_WALK_INTERVAL_MS, now })).toBe(true);
    expect(shouldWalkFull({ lastSuccessAt: now - 24 * 60 * 60_000, now })).toBe(true);
  });

  test('a stamp in the future is not trusted', () => {
    expect(shouldWalkFull({ lastSuccessAt: now + 60_000, now })).toBe(true);
  });
});

describe('mayTombstone', () => {
  test('a full walk that visited every session may tombstone', () => {
    expect(mayTombstone({ changedWalk: false, listed: 500, sliceSize: 500, paused: false })).toBe(true);
  });

  test('a walk capped below the list sends no tombstone', () => {
    // 12,199 local sessions and a cap of 2,000: the other 10,199 still exist.
    expect(mayTombstone({ changedWalk: false, listed: 12199, sliceSize: 2000, paused: false })).toBe(false);
  });

  test('a walk paused at the memory bound sends no tombstone', () => {
    expect(mayTombstone({ changedWalk: false, listed: 500, sliceSize: 500, paused: true })).toBe(false);
  });

  test('a changed walk sends no tombstone', () => {
    expect(mayTombstone({ changedWalk: true, listed: 40, sliceSize: 40, paused: false })).toBe(false);
  });
});
