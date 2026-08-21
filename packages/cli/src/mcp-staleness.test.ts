/**
 * What an agent is told when sync has stopped.
 *
 * A lapsed tenant keeps read access, so `recall_search` still answers — from a
 * history that stopped growing the day the subscription ended. Nothing told the
 * agent that, so it would report "you never worked on that" about work done last
 * week. Silently wrong is the worst failure a memory product can have, and it is
 * the same defect as a paginated transcript presenting itself as a whole session.
 *
 * Tested through the exported helpers rather than by booting an MCP server: the
 * decision being pinned is what the text says and when it appears at all.
 */
import { describe, test, expect } from 'vitest';
import { stalenessBanner, buildHttpError } from './mcp-diagnostics.js';

const DAY = 86_400_000;

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
    expect(b).toContain('SYNC IS PAUSED');
    expect(b).toContain('subscription has lapsed');
    expect(b).toContain(new Date(lapsed).toISOString().slice(0, 10));
    expect(b).toContain('14 days ago');
    expect(b).toContain('recent sessions are missing');
    // The instruction that stops the actual harm.
    expect(b).toMatch(/do not tell the user their work does not exist/i);
    // And the reassurance, so the agent does not escalate a billing state into
    // a data-loss story.
    expect(b).toContain('nothing has been deleted');
  });

  test('names the right reason for each status', () => {
    const at = Date.now() - DAY;
    expect(stalenessBanner({ entitled: false, status: 'trialing', periodEnd: at })).toContain('trial has ended');
    expect(stalenessBanner({ entitled: false, status: 'past_due', periodEnd: at })).toContain('payment has not gone through');
    expect(stalenessBanner({ entitled: false, status: 'unpaid', periodEnd: at })).toContain('subscription has lapsed');
  });

  test('copes with no recorded period end', () => {
    const b = stalenessBanner({ entitled: false, status: 'canceled', periodEnd: null })!;
    expect(b).toContain('SYNC IS PAUSED');
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
