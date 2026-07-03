/**
 * The collector's security posture: codeindex's name-matching secret rules
 * are dropped wholesale (measured 15/16 false positives on this repo —
 * function names like maskSecret(), scanner regexes, docs — which floored
 * the health score to 0/100). Real secret detection comes from
 * gitleaks/trufflehog via scanDirForSecrets(), the same engine as the
 * session security pipeline. This suite pins the rule classifier that
 * decides which codeindex rules get dropped.
 */
import { describe, test, expect } from 'vitest';
import { isSecretRule } from './collector.js';

describe('isSecretRule — codeindex rules replaced by the real scanners', () => {
  test('secret-shaped rules are dropped (gitleaks/trufflehog own this domain)', () => {
    expect(isSecretRule('hardcoded_secret_assignment')).toBe(true);
    expect(isSecretRule('private_key_block')).toBe(true);
    expect(isSecretRule('hardcoded_password')).toBe(true);
    expect(isSecretRule('api_key_literal')).toBe(true);
    expect(isSecretRule('credential_in_url')).toBe(true);
  });
  test('non-secret security rules pass through from codeindex', () => {
    expect(isSecretRule('sql_injection')).toBe(false);
    expect(isSecretRule('command_injection')).toBe(false);
    expect(isSecretRule('unsafe_deserialization')).toBe(false);
    expect(isSecretRule('path_traversal')).toBe(false);
  });
});
