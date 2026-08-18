/**
 * Reset-link construction.
 *
 * This file exists because of a shipped bug: sendResetPassword APPENDED
 * `callbackURL` to a url better-auth had already put one on, so every emailed
 * reset link carried two and the endpoint rejected it with
 * `[query.callbackURL] Invalid input: expected string, received array`. The
 * /forget-password endpoint answered 200 the whole time, so nothing caught it —
 * a working endpoint and a working link are different claims, and only the first
 * had a test.
 *
 * The duplicate case below is the regression guard. The rest pin the properties
 * a reset link must have for the flow to work at all.
 */
import { describe, it, expect } from 'vitest';
import { resetLinkFor, RESET_CALLBACK_PATH } from './better-auth.js';

const BASE = 'https://chatrecall.dev/api/auth/reset-password/TOK123';

/** How the endpoint itself parses the query — array-valued on duplicates. */
function callbackValues(link: string): string[] {
  return new URL(link).searchParams.getAll('callbackURL');
}

describe('resetLinkFor', () => {
  it('emits exactly one callbackURL when better-auth already supplied a blank one', () => {
    // The exact shape that produced the outage: better-auth always appends its
    // own `?callbackURL=`, empty when the caller passed no redirectTo.
    const link = resetLinkFor(`${BASE}?callbackURL=`);
    expect(callbackValues(link)).toEqual([RESET_CALLBACK_PATH]);
  });

  it('emits exactly one callbackURL when better-auth supplied a populated one', () => {
    const link = resetLinkFor(`${BASE}?callbackURL=${encodeURIComponent('https://chatrecall.dev/app')}`);
    expect(callbackValues(link)).toEqual([RESET_CALLBACK_PATH]);
  });

  it('emits exactly one callbackURL when there is no query string at all', () => {
    expect(callbackValues(resetLinkFor(BASE))).toEqual([RESET_CALLBACK_PATH]);
  });

  it('overwrites rather than accumulates when applied twice', () => {
    // Idempotence matters: a retry or a wrapper calling this again must not
    // reintroduce the duplicate this function exists to prevent.
    expect(callbackValues(resetLinkFor(resetLinkFor(`${BASE}?callbackURL=`)))).toEqual([
      RESET_CALLBACK_PATH,
    ]);
  });

  it('preserves the token in the path, which is the whole point of the link', () => {
    expect(new URL(resetLinkFor(`${BASE}?callbackURL=`)).pathname).toBe(
      '/api/auth/reset-password/TOK123',
    );
  });

  it('keeps unrelated query parameters better-auth may add', () => {
    const link = resetLinkFor(`${BASE}?callbackURL=&foo=bar`);
    expect(new URL(link).searchParams.get('foo')).toBe('bar');
    expect(callbackValues(link)).toEqual([RESET_CALLBACK_PATH]);
  });

  it('percent-encodes the callback so its own query survives transport', () => {
    // RESET_CALLBACK_PATH contains `?view=reset`; unencoded that would terminate
    // the outer query and the SPA would never see the view.
    const link = resetLinkFor(`${BASE}?callbackURL=`);
    expect(link).toContain('callbackURL=%2Fapp%3Fview%3Dreset');
  });
});
