/**
 * Two-factor authentication: the decisions, pinned where they can be read.
 *
 * The behaviour was proved end to end against a booted server — sign up, enrol,
 * compute a real RFC 6238 code from the returned secret, verify it, then confirm
 * a password alone no longer produces a session. That harness needs Postgres and
 * a licensed cloud edition, so it cannot run in the unit suite; what CAN run here
 * is everything that would have to be true for it to keep passing, and the two
 * product decisions a future edit would otherwise quietly reverse:
 *
 *   1. NO SMS. Ever. It is billed per message, it is the factor SIM-swap
 *      defeats, and it would add a vendor for a weaker guarantee. TOTP needs no
 *      third party at all — not even the SES account the verification mail uses.
 *
 *   2. ENABLING DOES NOT ARM IT. `skipVerificationOnEnable` stays false, so a
 *      code from the app is required before the factor takes effect. Flipping it
 *      would let someone mis-scan a QR and discover it at their next sign-in,
 *      locked out of an account holding every session they have ever synced.
 *
 * Read from source rather than by importing the auth instance: constructing it
 * opens a Postgres pool and runs migrations.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const authSrc = readFileSync(resolve(import.meta.dirname, './better-auth.ts'), 'utf8');
const clientSrc = readFileSync(
  resolve(import.meta.dirname, '../../client/src/services/auth.ts'), 'utf8',
);
const authPageSrc = readFileSync(
  resolve(import.meta.dirname, '../../client/src/components/AuthPage.tsx'), 'utf8',
);
const cardSrc = readFileSync(
  resolve(import.meta.dirname, '../../client/src/components/TwoFactorCard.tsx'), 'utf8',
);

describe('the plugin is registered, on the server', () => {
  test('twoFactor is imported and used — not merely a dependency', () => {
    expect(authSrc).toMatch(/\btwoFactor\b[\s\S]*from 'better-auth\/plugins'/);
    expect(authSrc).toMatch(/twoFactor\(\{/);
  });

  test('the issuer is set, so the authenticator app names the account', () => {
    expect(authSrc).toMatch(/issuer:\s*'chat-recall'/);
  });

  test('skipVerificationOnEnable is NOT turned on', () => {
    // Its default is false and it must stay absent-or-false: enabling without a
    // verified code is how a user locks themselves out of everything.
    const match = /skipVerificationOnEnable:\s*true/.exec(authSrc);
    expect(match, 'enrolment would arm the factor without verifying a code').toBeNull();
  });
});

/**
 * Comments stripped, because the rule is "no SMS in the CODE" and the code that
 * upholds it is surrounded by comments explaining why. Grepping the raw file
 * fails on its own rationale, which would teach the next person to delete the
 * explanation to make the test pass.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

describe('NO SMS, and nothing that would grow into it', () => {
  test('the server registers no phone-number or SMS plugin', () => {
    const code = codeOnly(authSrc);
    expect(code).not.toMatch(/phoneNumber\(/);
    expect(code).not.toMatch(/\bsms\b/i);
    expect(code).not.toMatch(/twilio|vonage|messagebird/i);
  });

  test('the client never calls an SMS or OTP-by-message endpoint', () => {
    // better-auth's two-factor plugin also exposes /two-factor/send-otp, which
    // delivers a code out of band. Using it would put a second factor back on
    // the network — and on a bill.
    const code = codeOnly(clientSrc);
    expect(code).not.toMatch(/two-factor\/send-otp/);
    expect(code).not.toMatch(/\bsms\b/i);
  });

  test('the panel says so to the user, not just in a comment', () => {
    // NOT "we never send codes by SMS or email", which is what this said until
    // 2026-08-30. The product emails a code at sign-up, sign-in, password reset
    // and change-email (see verifyOtpMail), so that sentence was contradicted by
    // the message a user had received minutes earlier — on the security page, of
    // all places. The true claim is narrower and is about the SECOND factor only.
    expect(cardSrc).toMatch(/never a text message/i);
    expect(cardSrc).not.toMatch(/never send codes by SMS or email/i);
  });
});

describe('the client speaks the endpoints the plugin actually serves', () => {
  const endpoints = [
    'two-factor/enable',
    'two-factor/verify-totp',
    'two-factor/verify-backup-code',
    'two-factor/disable',
  ];
  for (const e of endpoints) {
    test(`calls /${e}`, () => expect(clientSrc).toContain(e));
  }

  test('every call sends credentials — the session is an httpOnly cookie', () => {
    // A fetch without credentials:'include' silently acts as a different,
    // signed-out caller, which on these endpoints reads as "wrong password".
    const calls = clientSrc.split('two-factor/').slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.slice(0, 400)).toMatch(/credentials: 'include'/);
    }
  });

  test('enable and disable both require the password', () => {
    // Without it, a borrowed session could bind an attacker's authenticator, or
    // strip the factor off entirely.
    const enable = clientSrc.slice(clientSrc.indexOf('two-factor/enable'));
    expect(enable.slice(0, 400)).toMatch(/JSON\.stringify\(\{\s*password\s*\}\)/);
    const disable = clientSrc.slice(clientSrc.indexOf('two-factor/disable'));
    expect(disable.slice(0, 400)).toMatch(/JSON\.stringify\(\{\s*password\s*\}\)/);
  });
});

describe('sign-in cannot be completed by a password alone', () => {
  test('a 200 from /sign-in/email is inspected for twoFactorRedirect', () => {
    // THE assertion. With 2FA armed, better-auth answers 200 with
    // `{ twoFactorRedirect: true }` and issues NO session. A caller that checked
    // only res.ok would show the dashboard to someone holding half a credential
    // — which is the entire thing the second factor exists to prevent.
    const signIn = clientSrc.slice(clientSrc.indexOf('/sign-in/email'));
    expect(signIn.slice(0, 900)).toMatch(/twoFactorRedirect/);
  });

  test('the sign-in screen has a step for the code, and a way in without the phone', () => {
    expect(authPageSrc).toMatch(/'twofactor'/);
    expect(authPageSrc).toMatch(/verifyTotp/);
    expect(authPageSrc).toMatch(/verifyBackupCode/);
    expect(authPageSrc).toMatch(/recovery code/i);
  });

  test('the challenge screen hides the email and password fields', () => {
    // Showing them again invites re-entry of a password that was already
    // accepted, and makes the step look like the sign-in failing.
    expect(authPageSrc).toMatch(/!verifying && !twofactor/);
  });
});

describe('recovery codes are treated as shown-once', () => {
  test('the panel says they cannot be shown again', () => {
    expect(cardSrc).toMatch(/only time they are shown/i);
    expect(cardSrc).toMatch(/hashed/i);
  });

  test('turning it on is blocked until the user confirms they saved them', () => {
    // A checkbox is weak protection generally; here it is the last moment the
    // codes exist in readable form anywhere.
    expect(cardSrc).toMatch(/savedCodes/);
    expect(cardSrc).toMatch(/disabled=\{[^}]*!savedCodes[^}]*\}/);
  });
});
