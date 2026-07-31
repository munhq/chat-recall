/**
 * Server-served redaction rules: configured centrally, executed on the client.
 *
 * The server never receives unredacted text, so it cannot scan for what a
 * client missed — but it CAN ship better rules. That makes the rule pack the
 * one supported way to improve detection without waiting for every device to
 * upgrade its CLI, and it puts a remote-controlled regex on the path of every
 * string that leaves the machine. Hence two invariants under test:
 *
 *   ADD-ONLY   — a pack can make us redact more, never less. A hostile or
 *                fat-fingered server cannot switch the builtins off.
 *   VALIDATED  — over-broad, empty-matching, oversized or uncompilable rules
 *                are rejected individually, with a reason, and the rest of the
 *                pack still installs.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  redactSecrets, installServerRulePack, serverRulePackVersion, _clearServerRulePack,
  validateRedactionRule, DEFAULT_REDACTION_RULES,
} from './secret-redactor.js';

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

beforeEach(() => _clearServerRulePack());
afterEach(() => _clearServerRulePack());

describe('server rule pack — add-only', () => {
  test('a pack rule redacts on top of the builtins', () => {
    expect(redactSecrets('ref ACME-9931-XZ', { force: true })).toBe('ref ACME-9931-XZ');

    const r = installServerRulePack({
      version: 'abc123',
      rules: [{ name: 'acme-ref', regex: 'ACME-\\d{4}-[A-Z]{2}', redact: true }],
    });
    expect(r).toMatchObject({ accepted: 1, version: 'abc123' });
    expect(r.rejected).toEqual([]);
    expect(serverRulePackVersion()).toBe('abc123');

    expect(redactSecrets('ref ACME-9931-XZ', { force: true })).toBe('ref [REDACTED:tenant:acme-ref]');
    // …and the builtin still fires, in the same pass.
    expect(redactSecrets(`key ${AWS_KEY} ref ACME-9931-XZ`, { force: true }))
      .toBe('key [REDACTED:aws-access-token] ref [REDACTED:tenant:acme-ref]');
  });

  test('a pack cannot switch a builtin off — not even by reusing its label', () => {
    installServerRulePack({
      // Same label as a builtin, pattern that matches nothing real.
      rules: [{ name: 'aws-access-token', regex: 'ZZZZ-not-a-key-ZZZZ', redact: true }],
    });
    expect(redactSecrets(`key ${AWS_KEY}`, { force: true })).toBe('key [REDACTED:aws-access-token]');
  });

  test('installing again replaces the pack, and clearing it restores baseline behaviour', () => {
    installServerRulePack({ version: 'v1', rules: [{ name: 'a', regex: 'ACME-\\d{4}', redact: true }] });
    installServerRulePack({ version: 'v2', rules: [{ name: 'b', regex: 'BOLT-\\d{4}', redact: true }] });
    expect(serverRulePackVersion()).toBe('v2');
    expect(redactSecrets('ACME-1234 BOLT-5678', { force: true })).toBe('ACME-1234 [REDACTED:tenant:b]');

    _clearServerRulePack();
    expect(serverRulePackVersion()).toBeNull();
    expect(redactSecrets('ACME-1234 BOLT-5678', { force: true })).toBe('ACME-1234 BOLT-5678');
  });

  test('an empty pack leaves the builtins exactly as they were', () => {
    const before = redactSecrets(`key ${AWS_KEY}`, { force: true });
    installServerRulePack({ rules: [] });
    expect(redactSecrets(`key ${AWS_KEY}`, { force: true })).toBe(before);
    expect(DEFAULT_REDACTION_RULES.length).toBeGreaterThan(10); // untouched
  });
});

describe('server rule pack — validation', () => {
  test('rejects patterns that would shred ordinary content', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['catch-all',     '.*',            /empty string|benign/],
      ['any-word',      '\\w+',          /benign/],
      ['optional',      'x?',            /empty string/],
      ['broken',        '([unclosed',    /invalid regex/],
      ['empty',         '',              /empty pattern/],
      ['sha-shaped',    '[a-f0-9]{40}',  /benign/], // would eat every git SHA
      ['too-long',      'a'.repeat(513), /longer than/],
    ];
    for (const [name, regex, why] of cases) {
      const v = validateRedactionRule({ name, regex });
      expect(v.ok, `${name} should be rejected`).toBe(false);
      if (!v.ok) expect(v.reason, name).toMatch(why);
    }
  });

  test('one bad rule does not take the pack down with it', () => {
    const r = installServerRulePack({
      rules: [
        { name: 'good', regex: 'ACME-\\d{4}-[A-Z]{2}', redact: true },
        { name: 'catch-all', regex: '.*', redact: true },
        { name: 'also-good', regex: 'BOLT-[0-9]{6}', redact: true },
      ],
    });
    expect(r.accepted).toBe(2);
    expect(r.rejected.map((x) => x.name)).toEqual(['catch-all']);
    // The accepted rules work; the rejected one is simply absent.
    expect(redactSecrets('ACME-9931-XZ and BOLT-123456', { force: true }))
      .toBe('[REDACTED:tenant:good] and [REDACTED:tenant:also-good]');
  });

  test('caps the pack size so a runaway server cannot install thousands of regexes', () => {
    const rules = Array.from({ length: 250 }, (_, i) => ({
      name: `r${i}`, regex: `ACME-${String(i).padStart(4, '0')}-[A-Z]{2}`, redact: true,
    }));
    const r = installServerRulePack({ rules });
    expect(r.accepted).toBe(200);
    expect(r.rejected).toHaveLength(50);
    expect(r.rejected[0].reason).toMatch(/exceeds 200/);
  });

  test('unsafe flags are dropped, safe ones kept, and g is always applied', () => {
    installServerRulePack({ rules: [{ name: 'ci', regex: 'acme-\\d{4}', flags: 'iyd', redact: true }] });
    // 'i' honoured (matches uppercase), 'g' applied (both occurrences replaced),
    // 'y'/'d' dropped (their lastIndex/indices semantics would break replace).
    expect(redactSecrets('ACME-1111 and acme-2222', { force: true }))
      .toBe('[REDACTED:tenant:ci] and [REDACTED:tenant:ci]');
  });

  test('redaction still respects the global toggle — a pack does not force it on', () => {
    installServerRulePack({ rules: [{ name: 'acme', regex: 'ACME-\\d{4}', redact: true }] });
    // No `force` and index-time redaction off by default ⇒ unchanged.
    expect(redactSecrets('ACME-1234')).toBe('ACME-1234');
  });
});
