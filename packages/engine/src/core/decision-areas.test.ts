import { describe, test, expect } from 'vitest';
import {
  canonArea, isKnownArea, decisionSubject, parseDecisionSubject,
  ACCOUNT_SCOPE, DECISION_AREAS,
} from './decision-areas.js';

describe('canonArea', () => {
  test('canonical areas pass through', () => {
    for (const a of DECISION_AREAS) expect(canonArea(a)).toBe(a);
  });

  test('the split that made supersede useless now collapses', () => {
    // These three were three different KG subjects, so a decision recorded
    // under one never closed a decision recorded under another.
    const keys = ['auth', 'authentication', 'Auth Setup'].map(canonArea);
    expect(keys[0]).toBe('auth');
    expect(keys[1]).toBe('auth');
    // "auth setup" is not an alias, but it must at least be stable.
    expect(keys[2]).toBe('auth-setup');
    expect(canonArea('auth_setup')).toBe(keys[2]);
    expect(canonArea('Auth  Setup')).toBe(keys[2]);
  });

  test('separators and case do not create new keys', () => {
    expect(canonArea('Sign In')).toBe('auth');
    expect(canonArea('sign_in')).toBe('auth');
    expect(canonArea('sign-in')).toBe('auth');
    expect(canonArea('  SSO  ')).toBe('auth');
  });

  test('aliases reach their canonical area', () => {
    expect(canonArea('db')).toBe('database');
    expect(canonArea('Billing')).toBe('payments');
    expect(canonArea('infrastructure')).toBe('deploy');
    expect(canonArea('monitoring')).toBe('observability');
    expect(canonArea('license')).toBe('licensing');
  });

  test('business areas are first-class, not code-only', () => {
    expect(canonArea('pricing')).toBe('pricing');
    expect(canonArea('tiers')).toBe('pricing');
    expect(canonArea('branding')).toBe('positioning');
  });

  test('an unlisted area still gets a stable slug', () => {
    expect(canonArea('Package Pinning')).toBe('package-pinning');
    expect(canonArea('package-pinning')).toBe('package-pinning');
  });

  test('empty or punctuation-only input is null, never an empty key', () => {
    expect(canonArea(null)).toBeNull();
    expect(canonArea(undefined)).toBeNull();
    expect(canonArea('')).toBeNull();
    expect(canonArea('   ')).toBeNull();
    expect(canonArea('!!!')).toBeNull();
  });

  test('a pasted sentence cannot become an unmatchable key', () => {
    const key = canonArea('we should probably decide how authentication works across every service someday');
    expect(key).not.toBeNull();
    expect(key!.length).toBeLessThanOrEqual(40);
  });
});

describe('isKnownArea', () => {
  test('separates canonical areas from slug fallbacks', () => {
    expect(isKnownArea('auth')).toBe(true);
    expect(isKnownArea('package-pinning')).toBe(false);
    expect(isKnownArea(null)).toBe(false);
  });
});

describe('decisionSubject', () => {
  test('scopes the key to a project', () => {
    expect(decisionSubject('chat-recall', 'auth')).toBe('chat-recall:auth');
  });

  test('a missing project means account scope, not an empty prefix', () => {
    expect(decisionSubject(null, 'auth')).toBe(`${ACCOUNT_SCOPE}:auth`);
    expect(decisionSubject('  ', 'auth')).toBe(`${ACCOUNT_SCOPE}:auth`);
  });

  test('two projects deciding the same area do not collide', () => {
    // The case that makes per-area supersede safe: a client mandating Keycloak
    // must not close the account-wide decision.
    expect(decisionSubject('acme', 'auth')).not.toBe(decisionSubject('example-app', 'auth'));
  });

  test('round-trips through parseDecisionSubject', () => {
    const s = decisionSubject('git:github.com/owner/repo', 'database');
    expect(parseDecisionSubject(s)).toEqual({ project: 'git:github.com/owner/repo', area: 'database' });
  });

  test('parse returns null for a subject that is not area-keyed', () => {
    expect(parseDecisionSubject('auth')).toBeNull();
    expect(parseDecisionSubject('chat-recall:')).toBeNull();
    expect(parseDecisionSubject(':auth')).toBeNull();
  });
});
