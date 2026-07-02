import { describe, test, expect } from 'vitest';
import { redactSecrets, scanTextForFindings } from './secret-redactor.js';

// All tests force redaction on (the sync path always passes force:true).
const r = (s: string) => redactSecrets(s, { force: true });

// SYNTHETIC fixtures — shape-valid but NEVER real credentials. (An earlier
// version of this file hardcoded a real leaked AWS key; these replace it so the
// suite stops re-propagating a live secret into git/index. They still trigger
// every rule because the rules are shape-based.)
const FAKE_SECRET = 'Fake0Secret0Example0Key0NotReal0abcdEF12';            // 40-char AWS-secret shape
const FAKE_SESSION = 'IQoJEXAMPLEfakeSESSIONtokenNOTreal01234567890abcDEF=='; // AWS STS session-token shape
const FAKE_ASIA = 'ASIAEXAMPLE0NOTREAL0';                                  // ASIA + 16 access-key-id shape

describe('secret redactor — AWS / env / url (the leak fix)', () => {
  // The exact shape that leaked: access-key-ID was redacted, but the SECRET key
  // and SESSION token went out in cleartext.
  const awsBlock = [
    `export AWS_ACCESS_KEY_ID="${FAKE_ASIA}"`,
    `export AWS_SECRET_ACCESS_KEY="${FAKE_SECRET}"`,
    `export AWS_SESSION_TOKEN="${FAKE_SESSION}"`,
  ].join('\n');

  test('redacts AWS secret key AND session token AND access-key-id', () => {
    const out = r(awsBlock);
    expect(out).not.toContain(FAKE_SECRET);  // secret key
    expect(out).not.toContain('IQoJEXAMPLE'); // session token
    expect(out).not.toContain(FAKE_ASIA);    // access key id
    // var names stay (they aren't secret) so the redaction is legible:
    expect(out).toContain('AWS_SECRET_ACCESS_KEY="[REDACTED:env-secret]"');
    // session token is claimed by the more-specific prefix rule (IQoJ…) before
    // env-secret can — still fully redacted, just a more accurate label:
    expect(out).toContain('AWS_SESSION_TOKEN="[REDACTED:aws-session-token]"');
    expect(out).toContain('AWS_ACCESS_KEY_ID="[REDACTED:aws-access-token]"');
  });

  test('redacts generic *_KEY / *_SECRET / *_PASSWORD env assignments', () => {
    expect(r('FOO_API_KEY=abcd1234efgh5678ijkl')).toBe('FOO_API_KEY=[REDACTED:env-secret]');
    expect(r('DB_PASSWORD: "hunter2hunter2hunter2"')).toContain('[REDACTED:env-secret]');
    expect(r("MY_CLIENT_SECRET='s0meL0ngSecretValue123'")).toContain('[REDACTED:env-secret]');
  });

  test('redacts password inside a connection URL, keeps scheme/user/host', () => {
    const url = 'connstr postgres://app_user:s3cr3tPass99@db.internal:5432/maindb end';
    const out = r(url);
    expect(out).not.toContain('s3cr3tPass99');
    expect(out).toContain('postgres://app_user:[REDACTED:url-password]@db.internal');
  });

  test('does NOT over-redact: _ID vars and plain prose are untouched', () => {
    // AWS_ACCESS_KEY_ID ends in _ID, not a secret-suffix → env-secret must skip it
    // (its VALUE is still caught by the ASIA rule, tested above, but a non-AWS id is not)
    expect(r('REQUEST_ID=550e8400e29b41d4a716446655440000')).toBe('REQUEST_ID=550e8400e29b41d4a716446655440000');
    expect(r('the quick brown fox jumped over the lazy dog twice')).toBe('the quick brown fox jumped over the lazy dog twice');
  });

  test('regression: existing patterns still redact', () => {
    expect(r('token ghp_0123456789abcdefghijklmnopqrstuvwxyz here')).toContain('[REDACTED:github-pat]');
    expect(r('AIza' + 'a'.repeat(35))).toContain('[REDACTED:google-api-key]'); // AIza + exactly 35
  });
});

describe('secret redactor — BARE values in prose (the gap that actually leaked)', () => {
  // The real leak: the secret value pasted bare into prose/code, no `NAME=` and
  // — critically — NO nearby context word (markdown table, quoted in analysis).
  // The exact-40 `aws-secret-key` rule must catch it with zero context.
  test('redacts a bare full AWS secret value with NO surrounding context at all', () => {
    const out = r(`| col | ${FAKE_SECRET} | done |`); // table cell, no "secret"/"aws" nearby
    expect(out).not.toContain(FAKE_SECRET);
    expect(out).toContain('[REDACTED:aws-secret-key]');
  });

  test('redacts a non-40 secret value sitting after a context word (contextual pass)', () => {
    const SECRET36 = 'Zb7Kq2Mw9Rt4Vx1Np6Lc3Hd8Fg5Js0Ay2Qe'; // 36 chars → not the exact-40 rule
    const out = r(`the api_key for the job is ${SECRET36} ok`);
    expect(out).not.toContain(SECRET36);
    expect(out).toContain('[REDACTED:secret-context]');
  });

  test('redacts a bare AWS session token by prefix (no context word needed)', () => {
    const out = r(`then I ran search('${FAKE_SESSION}') to check the cloud`);
    expect(out).not.toContain('IQoJEXAMPLE');
    expect(out).toContain('[REDACTED:aws-session-token]');
  });

  test('does NOT over-redact: git SHA, longer blob, or token-near-context that is not secret-shaped', () => {
    // 40-char lowercase-hex git SHA → not mixed-case → kept by BOTH the exact-40 and contextual rules
    expect(r('the secret commit is a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')).toContain('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
    // 43-char blob with NO context word nearby → kept (not exactly 40, no context)
    const blob = 'AbC123dEf456GhI789jKlM012nOpQ345rStU678vWxY';
    expect(r(`here is a base64 chunk ${blob} unrelated`)).toContain(blob);
    // the word "token" appears but no secret-shaped value follows → untouched
    expect(r('peakContextTokens was 98007 this run')).toBe('peakContextTokens was 98007 this run');
  });

  test('scanner reports the bare full secret as a finding (masked)', () => {
    const f = scanTextForFindings(`the value is ${FAKE_SECRET} here`);
    const hit = f.find((x) => x.rule === 'aws-secret-key');
    expect(hit).toBeTruthy();
    expect(hit!.preview).not.toContain('Fake0Secret'); // raw never leaks
    expect(hit!.preview.endsWith('EF12')).toBe(true);  // last-4 visible
  });
});

describe('scanTextForFindings — the universal in-process scanner (no binaries)', () => {
  const block = [
    'line one is harmless prose',
    `export AWS_SECRET_ACCESS_KEY="${FAKE_SECRET}"`,
    `export AWS_ACCESS_KEY_ID="${FAKE_ASIA}"`,
  ].join('\n');

  test('reports findings (rule + 1-based line + masked preview) instead of masking', () => {
    const f = scanTextForFindings(block);
    expect(f.length).toBeGreaterThanOrEqual(2);
    const env = f.find((x) => x.rule === 'env-secret');
    expect(env).toBeTruthy();
    expect(env!.line).toBe(2);                     // 1-based line of the secret key
    expect(env!.preview.endsWith('EF12')).toBe(true);   // last-4 visible
    expect(env!.preview).not.toContain('Fake0Secret');  // raw secret never leaks
    expect(f.some((x) => x.rule === 'aws-access-token' && x.line === 3)).toBe(true);
  });

  test('clean text yields no findings', () => {
    expect(scanTextForFindings('just a normal sentence with no secrets')).toEqual([]);
    expect(scanTextForFindings('')).toEqual([]);
  });
});

describe('secret redactor — coverage widened 2026-07-02 (audit gaps)', () => {
  const r = (t: string) => redactSecrets(t, { force: true });

  test('DB_PASS / _AUTH / _DSN / _SESSION env values redact (suffixes the old list missed)', () => {
    expect(r('DB_PASS=supersecretpassword123')).toContain('[REDACTED:env-secret]');
    expect(r('NPM_AUTH=abcDEF123456789012345')).toContain('[REDACTED:env-secret]');
    expect(r('SENTRY_DSN=https://abc123def456@o1.ingest.sentry.io/1')).toContain('[REDACTED:env-secret]');
    expect(r('COOKIE_SESSION: sess_abcdef0123456789')).toContain('[REDACTED:env-secret]');
  });

  test('short flag-ish values under 12 chars stay readable (BYPASS=true)', () => {
    expect(r('BYPASS=true and STRICT_AUTH=off')).toBe('BYPASS=true and STRICT_AUTH=off');
  });

  test('bare lowercase-hex credential near a secret-context word redacts', () => {
    const hexKey = 'deadbeefcafe0123456789abcdef0123456789ab'; // 40-hex
    expect(r(`the api key is ${hexKey} for this service`)).toContain('[REDACTED:secret-context]');
  });

  test('git SHA named as a commit near "secret" is NOT redacted (checksum context)', () => {
    const sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    expect(r(`the secret commit is ${sha}`)).toContain(sha);
    expect(r(`token cache hash ${sha} unchanged`)).toContain(sha);
  });

  test('bare base64url token (with - and _) near context word redacts', () => {
    const tok = 'aB3-cD4_eF5-gH6_iJ7-kL8_mN9-oP0_qR1-sT2x';
    expect(r(`the access key ${tok} was pasted`)).toContain('[REDACTED:secret-context]');
  });
});
