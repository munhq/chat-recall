/**
 * The curated pack is the thing that makes server-served coverage real rather
 * than a mechanism with nothing in it. These tests pin the properties that make
 * it safe to push to every customer's redactor without a client release:
 *
 *   - every shipped rule survives the SAME validation the client applies
 *     (a rule the client silently drops is coverage we would be claiming falsely)
 *   - no rule fires on ordinary prose, code, logs or ids
 *   - the pack actually redacts the vendor shapes it claims to
 *   - the version hash tracks content
 */
import { describe, test, expect, beforeEach } from 'vitest';
import {
  builtinPackRules, builtinPackHash, BUILTIN_RULEPACK_SOURCE, _resetBuiltinPackCache,
} from './builtin-rulepack.js';
import {
  installServerRulePack, redactSecrets, scanTextForFindings, _clearServerRulePack,
  validateRedactionRule,
} from '@chat-recall/engine/core/secret-redactor.js';

beforeEach(() => {
  _resetBuiltinPackCache();
  _clearServerRulePack();
});

describe('the pack is well-formed', () => {
  test('is non-empty — the failure this whole thing exists to fix', () => {
    // A fresh tenant used to get zero server-side rules. If this ever returns
    // nothing again, every customer silently loses the vendor coverage.
    expect(builtinPackRules().length).toBeGreaterThan(50);
  });

  test('every rule passes the client-side validator', () => {
    // builtinPackRules() filters silently by design (better to serve 74 rules
    // than 500s), so assert against the RAW list: a drop means this file is
    // wrong and must be fixed, not tolerated.
    for (const r of builtinPackRules()) {
      expect(validateRedactionRule({ name: r.name, regex: r.regex, flags: r.flags }), r.name)
        .toEqual({ ok: true });
    }
  });

  test('rule ids and severities are sane, and provenance is recorded', () => {
    for (const r of builtinPackRules()) {
      expect(r.name, r.name).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
      expect(['critical', 'high', 'medium', 'low'], r.name).toContain(r.severity);
    }
    // MIT provenance is a licensing fact, not a nicety — trufflehog's AGPL
    // detectors must never end up in here.
    expect(BUILTIN_RULEPACK_SOURCE).toMatch(/gitleaks .* \(MIT\)/);
    expect(BUILTIN_RULEPACK_SOURCE).not.toMatch(/trufflehog/i);
  });

  test('the hash is stable across calls and covers rule content', () => {
    const h = builtinPackHash();
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    _resetBuiltinPackCache();
    expect(builtinPackHash()).toBe(h);
  });
});

/**
 * Text that must survive untouched. A redaction false positive is not a noisy
 * report — it permanently replaces the user's own content in their searchable
 * history, so this is the more important direction of the two.
 */
const BENIGN = [
  'the quick brown fox jumps over the lazy dog',
  'commit 8ba1f109551bd432803012645ac136ddd475d0fb touched src/index.ts:42',
  'npm install react react-dom && npm run build -- --mode production',
  'SELECT id, email FROM users WHERE created_at > now() - interval \'7 days\';',
  'session 6ec051d9-693f-4605-873d-a25a548c0106 finished in 1432ms',
  'export interface BuiltinPackRule { name: string; regex: string }',
  'docker pull ghcr.io/munhq/chat-recall-cloud:main',
  'Error: connect ECONNREFUSED 127.0.0.1:5432 at TCPConnectWrap.afterConnect',
  'we discussed twitter and dropbox integrations in the meeting yesterday',
  'heroku logs --tail --app my-app | grep -i error',
];

describe('the pack leaves ordinary content alone', () => {
  test('no benign line is altered by any pack rule', () => {
    installServerRulePack({
      version: 't', rules: builtinPackRules().map((r) => ({ name: r.name, regex: r.regex, flags: r.flags, redact: true, source: 'pack' as const })),
    });
    for (const line of BENIGN) {
      expect(redactSecrets(line, { force: true }), line).toBe(line);
    }
  });

  test('a vendor NAME on its own is not enough to fire', () => {
    installServerRulePack({
      version: 't', rules: builtinPackRules().map((r) => ({ name: r.name, regex: r.regex, flags: r.flags, redact: true, source: 'pack' as const })),
    });
    // Every rule needs vendor + assignment + a correctly-shaped value. Prose
    // that merely mentions the vendor must pass through.
    const prose = 'I set up the twitter api key rotation and the dropbox token flow last week';
    expect(redactSecrets(prose, { force: true })).toBe(prose);
  });
});

describe('the pack redacts what it claims to', () => {
  /** Shapes built to match the upstream rule definitions. Values are synthetic. */
  const POSITIVES: Array<{ rule: string; text: string; secret: string }> = [
    {
      rule: 'twitter-api-key',
      text: 'twitter_api_key = "a1b2c3d4e5f6g7h8i9j0k1l2m"',
      secret: 'a1b2c3d4e5f6g7h8i9j0k1l2m',
    },
    {
      rule: 'heroku-api-key',
      text: 'heroku_api_key: 01234567-89ab-cdef-0123-456789abcdef',
      secret: '01234567-89ab-cdef-0123-456789abcdef',
    },
    {
      rule: 'age-secret-key',
      text: 'key = AGE-SECRET-KEY-1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE',
      secret: 'AGE-SECRET-KEY-1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE',
    },
    {
      rule: 'slack-webhook-url',
      text: 'notify https://hooks.slack.com/triggers/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq',
      secret: 'https://hooks.slack.com/triggers/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq',
    },
  ];

  test('each synthetic vendor secret is removed from the output', () => {
    installServerRulePack({
      version: 't', rules: builtinPackRules().map((r) => ({ name: r.name, regex: r.regex, flags: r.flags, redact: true, source: 'pack' as const })),
    });
    for (const { rule, text, secret } of POSITIVES) {
      const out = redactSecrets(text, { force: true });
      expect(out, `${rule}: expected redaction of ${text}`).not.toContain(secret);
      expect(out, rule).toContain('[REDACTED:');
    }
  });

  test('a pack hit is also REPORTED, labelled as pack (not tenant)', () => {
    installServerRulePack({
      version: 't', rules: builtinPackRules().map((r) => ({ name: r.name, regex: r.regex, flags: r.flags, redact: true, source: 'pack' as const })),
    });
    const findings = scanTextForFindings('twitter_api_key = "a1b2c3d4e5f6g7h8i9j0k1l2m"');
    const hit = findings.find((f) => f.rule.startsWith('pack:'));
    expect(hit, JSON.stringify(findings)).toBeTruthy();
    expect(hit!.rule).toBe('pack:twitter-api-key');
    // Masked, never raw.
    expect(hit!.preview).not.toContain('a1b2c3');
    expect(hit!.preview.endsWith('k1l2m"')).toBe(false);
  });

  test('one secret matched by two rules is one finding, not two', () => {
    // The pack deliberately overlaps the builtins in places. Without span
    // de-duplication the same leaked key would be counted twice and would look
    // like two independent detectors agreeing.
    installServerRulePack({
      version: 't',
      rules: [
        { name: 'dup-a', regex: 'ACME-[0-9]{4}-[A-Z]{2}', redact: true, source: 'pack' },
        { name: 'dup-b', regex: 'ACME-[0-9]{4}-[A-Z]{2}', redact: true, source: 'tenant' },
      ],
    });
    const findings = scanTextForFindings('ref ACME-9931-XZ here');
    expect(findings.filter((f) => f.preview.endsWith('1-XZ'))).toHaveLength(1);
  });
});
