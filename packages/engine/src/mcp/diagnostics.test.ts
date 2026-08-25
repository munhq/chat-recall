/**
 * What an agent is told when the account has no live plan.
 *
 * A lapsed tenant used to keep read access, so `recall_search` kept answering
 * from a history that stopped growing the day the subscription ended, and this
 * banner carried the caveat. Since 2026-08-25 the server refuses those reads
 * outright, because a caveat only works on an agent that reads caveats. The
 * banner's job changed with it: state the account is off, and stop the agent
 * substituting its own recollection for the recall it just lost.
 *
 * Tested through the exported helpers rather than by booting an MCP server: the
 * decision being pinned is what the text says and when it appears at all.
 */
import { describe, test, expect } from 'vitest';
import { stalenessBanner, trialEndingBanner, buildHttpError, TRIAL_WARN_DAYS } from './diagnostics.js';

const DAY = 86_400_000;
const BASE = 'https://recall.example';

/**
 * The trial countdown — the ONLY deadline surface a connector user ever sees.
 *
 * They arrive from claude.ai, sign in with Google and work. They never load the
 * dashboard, so TrialBanner never renders for them, and the reminder email lands
 * in an inbox they have not connected to this. If the tool result does not carry
 * the deadline, nothing does, and the trial ending is a surprise.
 */
describe('trialEndingBanner', () => {
  const trial = (daysLeft: number | null, over: Partial<Parameters<typeof trialEndingBanner>[0]> = {}) =>
    ({ entitled: true, status: 'trialing', periodEnd: Date.now() + (daysLeft ?? 0) * DAY,
      onTrial: true, trialDaysLeft: daysLeft, ...over });

  test('silent while the trial has room', () => {
    expect(trialEndingBanner(trial(TRIAL_WARN_DAYS + 1), BASE)).toBeNull();
    expect(trialEndingBanner(trial(7), BASE)).toBeNull();
  });

  test('fires from the warning threshold, and names the day', () => {
    expect(trialEndingBanner(trial(3), BASE)).toContain('IN 3 DAYS');
    expect(trialEndingBanner(trial(1), BASE)).toContain('TOMORROW');
    expect(trialEndingBanner(trial(0), BASE)).toContain('TODAY');
  });

  test('carries the account link on THIS server, not a hardcoded host', () => {
    // Self-host is the reason this is passed in. A baked chatrecall.dev link
    // sends someone running their own server to an account they do not have.
    expect(trialEndingBanner(trial(2), BASE)).toContain(`${BASE}/app?view=account`);
    expect(trialEndingBanner(trial(2), 'http://localhost:5000/')).toContain('http://localhost:5000/app?view=account');
  });

  test('tells the agent to relay it — a banner nobody repeats reached nobody', () => {
    const b = trialEndingBanner(trial(2), BASE)!;
    expect(b).toMatch(/tell the user/i);
    // And it must not imply data loss, which is the one wrong takeaway.
    expect(b).toMatch(/nothing is deleted/i);
  });

  test('says nothing for a CARD trial — that one is Stripe\'s to remind about', () => {
    expect(trialEndingBanner(trial(2, { onTrial: false }), BASE)).toBeNull();
  });

  test('says nothing without a deadline, or when already lapsed', () => {
    expect(trialEndingBanner(trial(null), BASE)).toBeNull();
    // A lapsed account is stalenessBanner's job; two banners would contradict.
    expect(trialEndingBanner({ ...trial(0), entitled: false }, BASE)).toBeNull();
    expect(trialEndingBanner(null, BASE)).toBeNull();
  });

  test('never fires alongside the lapsed banner', () => {
    const lapsed = { entitled: false, status: 'trialing', periodEnd: Date.now() - DAY, onTrial: true, trialDaysLeft: 0 };
    expect(stalenessBanner(lapsed)).not.toBeNull();
    expect(trialEndingBanner(lapsed, BASE)).toBeNull();
  });
});

describe('stalenessBanner', () => {
  test('says nothing at all when entitled', () => {
    expect(stalenessBanner({ entitled: true, status: 'active', periodEnd: Date.now() + DAY })).toBeNull();
    // A trialing tenant is entitled, so a trial in progress gets no scare.
    expect(stalenessBanner({ entitled: true, status: 'trialing', periodEnd: Date.now() + 3 * DAY })).toBeNull();
  });

  test('says nothing when the state is unknown', () => {
    // An unreachable billing endpoint must never decorate every answer with a
    // warning it cannot substantiate.
    expect(stalenessBanner(null)).toBeNull();
  });

  test('warns, dates it, and tells the agent what NOT to conclude', () => {
    const lapsed = Date.now() - 14 * DAY;
    const b = stalenessBanner({ entitled: false, status: 'canceled', periodEnd: lapsed })!;
    expect(b).toContain('NO ACTIVE PLAN');
    expect(b).toContain('subscription has lapsed');
    expect(b).toContain(new Date(lapsed).toISOString().slice(0, 10));
    expect(b).toContain('14 days ago');
    // Say the reads are refused. 'WHOLE synced history' was asserted here until
    // 2026-08-25 and is now false — the exact drift this file exists to catch.
    expect(b).toMatch(/refused/i);
    expect(b).not.toMatch(/whole synced history|recent window|last 7 days/i);
    // A 402 on your own history reads as deletion unless the text says otherwise.
    expect(b).toMatch(/nothing was deleted/i);
    expect(b).toMatch(/history is intact/i);
    expect(b).toContain('sync --full');
    // The instruction that stops the actual harm now: an agent with no recall
    // must not answer from its own recollection as if recall still worked.
    expect(b).toMatch(/do not answer from memory/i);
  });

  test("a NEVER-STARTED account is told to confirm, not that it lapsed", () => {
    // Every connector signup passes through status 'none' — the trial is
    // withheld until the address is confirmed — so this is the first thing a
    // brand-new user reads. Saying "your subscription has lapsed" there names a
    // subscription they never had and hides the one action that fixes it.
    const b = stalenessBanner({ entitled: false, status: 'none', periodEnd: null })!;
    expect(b).toMatch(/not started its trial/i);
    expect(b).toMatch(/confirmation link/i);
    expect(b).not.toMatch(/lapsed|subscription has/i);
    expect(b).not.toContain('undefined');
  });

  test('names the right reason for each status', () => {
    const at = Date.now() - DAY;
    expect(stalenessBanner({ entitled: false, status: 'trialing', periodEnd: at })).toContain('trial has ended');
    expect(stalenessBanner({ entitled: false, status: 'past_due', periodEnd: at })).toContain('payment has not gone through');
    expect(stalenessBanner({ entitled: false, status: 'unpaid', periodEnd: at })).toContain('subscription has lapsed');
  });

  test('copes with no recorded period end', () => {
    const b = stalenessBanner({ entitled: false, status: 'canceled', periodEnd: null })!;
    expect(b).toContain('NO ACTIVE PLAN');
    expect(b).not.toContain('undefined');
    expect(b).not.toContain('NaN');
  });
});

describe('buildHttpError', () => {
  const res = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });

  test('a 402 for confirmation says confirm, not subscribe', async () => {
    const e = await buildHttpError('/api/sync', res(402, {
      error: 'email confirmation required',
      detail: 'Confirm your email address to start your trial.',
      resendHint: 'POST /api/auth/send-verification-email to get another link',
    }));
    expect(e.message).toContain('email confirmation required');
    expect(e.message).toContain('send-verification-email');
    expect(e.message).not.toMatch(/checkout/i);
  });

  test('a 402 for a lapsed subscription says subscribe', async () => {
    const e = await buildHttpError('/api/sync', res(402, {
      error: 'subscription required',
      detail: 'Your access is read-only until you subscribe. Your history is kept.',
      checkoutHint: 'POST /api/billing/checkout to start a subscription',
    }));
    expect(e.message).toContain('subscription required');
    expect(e.message).toContain('billing/checkout');
    expect(e.message).toContain('Nothing has been deleted');
  });

  test('a feature-level 402 names the capability and the plan', async () => {
    const e = await buildHttpError('/api/toolkit/matrix', res(402, {
      error: 'this feature requires the team plan',
      feature: 'toolkit',
      requires: 'team',
      upgradeUrl: 'https://chatrecall.dev/pricing',
    }));
    expect(e.message).toContain('"toolkit"');
    expect(e.message).toContain('team plan');
    expect(e.message).toContain('https://chatrecall.dev/pricing');
  });

  test('never emits a bare "request rejected" for a 402', async () => {
    // The original bug: every payment refusal fell through to that string, so an
    // agent learned nothing and retried.
    const e = await buildHttpError('/api/sync', res(402));
    expect(e.message).not.toContain('request rejected');
    expect(e.message).toContain('payment required');
  });

  test('keeps the useful hints for the other statuses', async () => {
    expect((await buildHttpError('/x', res(401))).message).toMatch(/chat-recall login/);
    expect((await buildHttpError('/x', res(429))).message).toMatch(/rate limited/);
    expect((await buildHttpError('/x', res(503))).message).toMatch(/server error/);
    // A server sentence beats a generic one when there is one.
    expect((await buildHttpError('/x', res(400, { error: 'device id is required' }))).message)
      .toContain('device id is required');
  });
});
