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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * The SAME bug family as the reset link above — composing a query string against
 * one better-auth already builds — in the one place it breaks the connector.
 *
 * better-auth's MCP plugin sends an unauthenticated authorize request to the
 * login page with a HARDCODED '?':
 *
 *   plugins/mcp/authorize.mjs:  throw ctx.redirect(`${options.loginPage}?${queryFromURL}`)
 *
 * `loginPage: '/app?view=signin'` therefore produced
 * `/app?view=signin?response_type=code&client_id=…`. A URL has one '?', so
 * `view` became the value "signin?response_type=code" and every OAuth parameter
 * was buried inside it: no client_id, no redirect_uri, no code_challenge to
 * resume the flow with. A visitor from claude.ai signed in, landed on the
 * dashboard, and the client that sent them waited for a code forever — with a
 * 302 and a 200 at every step, so nothing was red.
 *
 * Read from source text because the auth instance is deliberately not exported
 * (see the note on getAuth), and this invariant is about the CONFIG, not the
 * runtime object.
 */
describe('the MCP loginPage', () => {
  const src = readFileSync(join(import.meta.dirname, 'better-auth.ts'), 'utf-8');

  const loginPage = (() => {
    const m = src.match(/loginPage:\s*'([^']*)'/);
    expect(m, 'loginPage not found in better-auth.ts').not.toBeNull();
    return m![1];
  })();

  it('carries no query string, because better-auth appends one with a hardcoded ?', () => {
    expect(loginPage).not.toContain('?');
  });

  it('carries no fragment either, for the same reason', () => {
    expect(loginPage).not.toContain('#');
  });

  it('is a same-origin absolute path, so the redirect cannot leave the app', () => {
    expect(loginPage.startsWith('/')).toBe(true);
    expect(loginPage).not.toMatch(/^\/\//);
  });

  it('composes into a single-question-mark URL', () => {
    // Exactly what authorize.mjs does, so this fails if the shape regresses.
    const composed = `${loginPage}?response_type=code&client_id=abc`;
    expect(composed.split('?').length - 1).toBe(1);
    expect(new URLSearchParams(composed.split('?')[1]).get('client_id')).toBe('abc');
  });
});
