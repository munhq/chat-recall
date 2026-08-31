/**
 * Copy rules for the Account surface, enforced against the source.
 *
 * Read the component source rather than render it: these are React client
 * components with network calls in effects, and the assertion here is about the
 * strings an author typed, not about a mounted tree. Same approach as
 * two-factor.test.ts.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const CLIENT = join(__dirname, '../../client/src/components');
const FILES = ['AccountPage.tsx', 'ProfileCard.tsx', 'TwoFactorCard.tsx'];

/** Source with every comment removed, so only text a user can see remains. */
function visibleSource(file: string): string {
  return readFileSync(join(CLIENT, file), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')   // JSX comments
    .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments (incl. inside CSS strings)
    .replace(/^\s*\/\/.*$/gm, '');          // line comments
}

describe('Account copy', () => {
  test('contains no em-dash or en-dash in anything a user reads', () => {
    // The em-dash is the clearest single tell that a machine wrote the copy. A
    // hyphen doing its job reads as a typo, so the fix is always to restructure:
    // a period, a comma, a colon, or parentheses.
    for (const f of FILES) {
      const found = visibleSource(f).match(/[—–]/g) ?? [];
      expect(found, `${f} has ${found.length} em/en-dash(es) in visible copy`).toEqual([]);
    }
  });

  test('makes no claim about how codes are delivered beyond the second factor', () => {
    // "we never send codes by SMS or email" was false: the product emails a code
    // at sign-up, sign-in, password reset and change-email.
    for (const f of FILES) {
      expect(visibleSource(f)).not.toMatch(/never send codes by (SMS|email)/i);
    }
  });

  test('the account page groups its cards instead of listing them flat', () => {
    const src = readFileSync(join(CLIENT, 'AccountPage.tsx'), 'utf8');
    for (const id of ['sec-profile', 'sec-security', 'sec-billing', 'sec-machines', 'sec-data']) {
      expect(src).toContain(id);
    }
  });
});
