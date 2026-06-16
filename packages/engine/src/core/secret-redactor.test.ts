import { describe, test, expect } from 'vitest';
import { redactSecrets, scanTextForFindings } from './secret-redactor.js';

// All tests force redaction on (the sync path always passes force:true).
const r = (s: string) => redactSecrets(s, { force: true });

describe('secret redactor — AWS / env / url (the leak fix)', () => {
  // The exact shape that leaked today: access-key-ID was redacted, but the
  // SECRET key and SESSION token went out in cleartext.
  const awsBlock = [
    'export AWS_ACCESS_KEY_ID="ASIAEXAMPLE0NOTREAL0"',
    'export AWS_SECRET_ACCESS_KEY="Fake0Secret0Example0Key0NotReal0abcdEF12"',
    'export AWS_SESSION_TOKEN="IQoJEXAMPLEfakeSESSIONtokenNOTreal01234567890abcDEF=="',
  ].join('\n');

  test('redacts AWS secret key AND session token AND access-key-id', () => {
    const out = r(awsBlock);
    expect(out).not.toContain('Fake0Secret0Example0Key0NotReal0abcdEF12'); // secret key
    expect(out).not.toContain('IQoJEXAMPLEfakeSESSIONtokenNOTreal01234567890abcDEF==');                            // session token
    expect(out).not.toContain('ASIAEXAMPLE0NOTREAL0');                    // access key id
    // var names stay (they aren't secret) so the redaction is legible:
    expect(out).toContain('AWS_SECRET_ACCESS_KEY="[REDACTED:env-secret]"');
    expect(out).toContain('AWS_SESSION_TOKEN="[REDACTED:env-secret]"');
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

describe('scanTextForFindings — the universal in-process scanner (no binaries)', () => {
  const block = [
    'line one is harmless prose',
    'export AWS_SECRET_ACCESS_KEY="Fake0Secret0Example0Key0NotReal0abcdEF12"',
    'export AWS_ACCESS_KEY_ID="ASIAEXAMPLE0NOTREAL0"',
  ].join('\n');

  test('reports findings (rule + 1-based line + masked preview) instead of masking', () => {
    const f = scanTextForFindings(block);
    expect(f.length).toBeGreaterThanOrEqual(2);
    const env = f.find((x) => x.rule === 'env-secret');
    expect(env).toBeTruthy();
    expect(env!.line).toBe(2);                     // 1-based line of the secret key
    expect(env!.preview.endsWith('IUeQ')).toBe(true);   // last-4 visible
    expect(env!.preview).not.toContain('9oVgPkNZ');     // raw secret never leaks
    expect(f.some((x) => x.rule === 'aws-access-token' && x.line === 3)).toBe(true);
  });

  test('clean text yields no findings', () => {
    expect(scanTextForFindings('just a normal sentence with no secrets')).toEqual([]);
    expect(scanTextForFindings('')).toEqual([]);
  });
});
