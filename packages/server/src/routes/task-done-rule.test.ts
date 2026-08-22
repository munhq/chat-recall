/**
 * Done is earned; rejection is the human's.
 *
 * A card asserts a problem exists in the code, so moving it to done asserts the
 * code changed. The board carried 93 "done" cards that nobody had worked — every
 * one closed because a finding stopped being reported, several because its id
 * shifted underneath it. Meanwhile a person could drag anything to Done and the
 * product would agree.
 *
 * So: done needs a session to point at, and disagreement gets its own verdict —
 * one that reaches the FINDING, or the auto-filer just files it again.
 */
import { describe, test, expect } from 'vitest';

const STATUSES = new Set(['todo', 'in_progress', 'blocked', 'done', 'rejected']);

/** The route's rule, in one function. */
function mayApply(
  status: string,
  ctx: { existingSession: string | null; patchSession?: string | null },
): { ok: boolean; reason?: string } {
  if (!STATUSES.has(status)) return { ok: false, reason: 'unknown status' };
  if (status === 'done') {
    const willHave = ctx.patchSession ?? ctx.existingSession ?? null;
    if (!willHave) return { ok: false, reason: 'a task is marked done by the work, not by hand' };
  }
  return { ok: true };
}

describe('marking a task done', () => {
  test('refused with nothing to check', () => {
    const r = mayApply('done', { existingSession: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not by hand');
  });

  test('allowed when the agent attaches its session in the same call', () => {
    expect(mayApply('done', { existingSession: null, patchSession: 'sess_abc' }).ok).toBe(true);
  });

  test('allowed when the card was already claimed', () => {
    expect(mayApply('done', { existingSession: 'sess_abc' }).ok).toBe(true);
  });

  test('every other move stays free — a person may park or reject anything', () => {
    for (const s of ['todo', 'in_progress', 'rejected']) {
      expect(mayApply(s, { existingSession: null }).ok, s).toBe(true);
    }
  });

  test('rejected is a real status, so the board can offer it', () => {
    expect(STATUSES.has('rejected')).toBe(true);
  });
});

/**
 * The write-through. Without it, "no" lasts until the next code index: the filer
 * materialises every 'suggested' action above the floor, so a card rejected on
 * the board alone comes straight back.
 */
describe('rejecting a card', () => {
  const filed = (status: string, findingId: string | null) => {
    const dismissed: string[] = [];
    if (status === 'rejected' && findingId) dismissed.push(findingId);
    return dismissed;
  };

  test('dismisses the finding behind it', () => {
    expect(filed('rejected', 'ca_123')).toEqual(['ca_123']);
  });

  test('a hand-written card has no finding to dismiss, and that is fine', () => {
    expect(filed('rejected', null)).toEqual([]);
  });

  test('parking a card does not dismiss anything', () => {
    expect(filed('todo', 'ca_123')).toEqual([]);
  });
});
