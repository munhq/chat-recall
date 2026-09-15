import { describe, test, expect } from 'vitest';
import {
  canonArea, isKnownArea, decisionSubject, parseDecisionSubject, inferArea,
  ACCOUNT_SCOPE, DECISION_AREAS,
  scopeChain, scopeKind, workspaceScope, workspaceFromPath, userScope,
  decisionProjectKey, decisionProjectAliases,
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

describe('inferArea', () => {
  test('names the area for values people actually decide between', () => {
    expect(inferArea('Keycloak')).toBe('auth');
    expect(inferArea('BetterAuth')).toBe('auth');
    expect(inferArea('Postgres')).toBe('database');
    expect(inferArea('Stripe')).toBe('payments');
    expect(inferArea('Playwright')).toBe('testing');
    expect(inferArea('Grafana')).toBe('observability');
    expect(inferArea('ArgoCD')).toBe('deploy');
  });

  test('a longer key wins over one contained inside it', () => {
    // "auth" must not match inside "betterauth" and mislabel it.
    expect(inferArea('betterauth')).toBe('auth');
    expect(inferArea('next-auth')).toBe('auth');
  });

  test('finds the value inside a sentence, on word boundaries', () => {
    expect(inferArea('moved the writer off the pooler to postgres')).toBe('database');
    expect(inferArea('we standardised on playwright for the dashboard')).toBe('testing');
  });

  test('does not match a substring that is not its own word', () => {
    // "go" is not in the map, but this guards the boundary rule generally:
    // "restore" must not resolve to the `rest` api entry.
    expect(inferArea('restore from backup')).toBeNull();
  });

  test('returns null rather than inventing an area', () => {
    expect(inferArea('the second option')).toBeNull();
    expect(inferArea('')).toBeNull();
    expect(inferArea(null)).toBeNull();
  });
});

describe('workspaceFromPath', () => {
  test('the folder above the repository is the group', () => {
    expect(workspaceFromPath('/home/user/code/personal/example-app')).toBe('ws:personal');
    expect(workspaceFromPath('/home/user/code/acme/billing')).toBe('ws:acme');
  });

  test('the same group on a second machine', () => {
    // The reason the key is a name and not an absolute prefix: one decision
    // recorded on either machine resolves on both.
    expect(workspaceFromPath('/home/user/code/personal/example-app'))
      .toBe(workspaceFromPath('/Users/alice/code/personal/other-app'));
  });

  test('a worktree resolves to its repository group, not to "worktrees"', () => {
    expect(workspaceFromPath('/home/user/code/personal/example-app/.agent/worktrees/a1'))
      .toBe('ws:personal');
  });

  test('a repository with no folder group returns null', () => {
    expect(workspaceFromPath('/home/user/example-app')).toBeNull();
    expect(workspaceFromPath('/Users/alice/example-app')).toBeNull();
    expect(workspaceFromPath('/example-app')).toBeNull();
    expect(workspaceFromPath('')).toBeNull();
    expect(workspaceFromPath('relative/path/app')).toBeNull();
  });
});

describe('scope keys', () => {
  test('each tier is recognised from its key alone', () => {
    expect(scopeKind(ACCOUNT_SCOPE)).toBe('account');
    expect(scopeKind('ws:personal')).toBe('workspace');
    expect(scopeKind('user:u1')).toBe('user');
    expect(scopeKind('munbot')).toBe('project');
  });

  test('a scope key round-trips through a subject', () => {
    // The subject splits on the LAST colon, so a key that contains one
    // (`ws:personal`, `user:u1`) must survive the trip.
    for (const key of ['ws:personal', 'user:u1', 'munbot', ACCOUNT_SCOPE]) {
      const parsed = parseDecisionSubject(decisionSubject(key, 'auth'));
      expect(parsed).toEqual({ project: key, area: 'auth' });
    }
  });

  test('prefixes are not doubled', () => {
    expect(workspaceScope('ws:personal')).toBe('ws:personal');
    expect(userScope('user:u1')).toBe('user:u1');
    expect(workspaceScope('')).toBe('');
  });
});

describe('scopeChain', () => {
  test('most specific first, user last', () => {
    expect(scopeChain({ project: 'munbot', workspace: 'personal', userId: 'u1' }))
      .toEqual(['munbot', 'ws:personal', ACCOUNT_SCOPE, 'user:u1']);
  });

  test('absent tiers are skipped, never filled with a placeholder', () => {
    expect(scopeChain({})).toEqual([ACCOUNT_SCOPE]);
    expect(scopeChain({ project: 'munbot' })).toEqual(['munbot', ACCOUNT_SCOPE]);
    expect(scopeChain({ workspace: 'personal' })).toEqual(['ws:personal', ACCOUNT_SCOPE]);
  });

  test('a workspace asked for as a project is not listed twice', () => {
    expect(scopeChain({ project: 'ws:personal', workspace: 'personal' }))
      .toEqual(['ws:personal', ACCOUNT_SCOPE]);
  });
});

describe('decisionProjectKey', () => {
  test('THE POINT: one repository on two machines gets ONE key', () => {
    // A project_id cannot do this. Without a git remote it is a sha1 of the
    // absolute path, so the same repository checked out in two places has two
    // ids, and keying decisions on it would give each machine its own register.
    const a = decisionProjectKey('git-local:aaaaaaaaaaaa', '/home/user/code/personal/example-app');
    const b = decisionProjectKey('git-local:bbbbbbbbbbbb', '/Users/alice/code/personal/example-app');
    expect(a).toBe(b);
    expect(a).toBe('ws:personal/example-app');
  });

  test('a repository with a remote keys on the remote, which is the same everywhere', () => {
    expect(decisionProjectKey('git:github.com/owner/repo', '/home/user/code/personal/repo'))
      .toBe('git:github.com/owner/repo');
    // The path is irrelevant once a remote exists.
    expect(decisionProjectKey('git:github.com/owner/repo', '/somewhere/else/repo'))
      .toBe('git:github.com/owner/repo');
  });

  test('a declared project keeps the name its owner chose', () => {
    expect(decisionProjectKey('user:billing', '/home/user/code/acme/billing')).toBe('user:billing');
  });

  test('a worktree keys as the repository it belongs to', () => {
    expect(decisionProjectKey('git-local:cccccccccccc', '/home/user/code/personal/example-app/.agent/worktrees/a1'))
      .toBe('ws:personal/example-app');
  });

  test('a repository in no folder group is just its name', () => {
    expect(decisionProjectKey('git-local:dddddddddddd', '/home/user/example-app')).toBe('example-app');
  });

  test('two repositories of the same name in different groups do not collide', () => {
    expect(decisionProjectKey('git-local:1', '/home/user/code/personal/api'))
      .not.toBe(decisionProjectKey('git-local:2', '/home/user/code/acme/api'));
  });

  test('with nothing but a name, the name is the key', () => {
    expect(decisionProjectKey('example-app', null)).toBe('example-app');
  });

  test('the key round-trips through a subject', () => {
    for (const id of ['git:github.com/owner/repo', 'ws:personal/example-app', 'example-app']) {
      expect(parseDecisionSubject(decisionSubject(id, 'auth'))).toEqual({ project: id, area: 'auth' });
    }
  });
});

describe('decisionProjectAliases', () => {
  test('the canonical key comes first, older spellings after', () => {
    const keys = decisionProjectAliases('git:github.com/owner/repo', '/home/user/code/personal/repo', 'repo');
    expect(keys[0]).toBe('git:github.com/owner/repo');
    expect(keys).toContain('repo');
  });

  test('THE POINT: a decision recorded under the old spelling is still found', () => {
    // Canonicalising without this orphans every decision recorded before it,
    // silently, for every existing user.
    const keys = decisionProjectAliases('git:github.com/owner/example-app', '/home/user/code/personal/example-app', 'example-app');
    expect(keys).toEqual(['git:github.com/owner/example-app', 'example-app']);
  });

  test('no duplicates, so the chain never checks one key twice', () => {
    const keys = decisionProjectAliases('example-app', '/home/user/example-app', 'example-app');
    expect(keys).toEqual([...new Set(keys)]);
  });
});

describe('scopeChain with several project keys', () => {
  test('every project spelling is tried before the group', () => {
    expect(scopeChain({
      project: ['git:github.com/owner/repo', 'repo'],
      workspace: 'personal',
      userId: 'u1',
    })).toEqual(['git:github.com/owner/repo', 'repo', 'ws:personal', ACCOUNT_SCOPE, 'user:u1']);
  });

  test('a single key still works', () => {
    expect(scopeChain({ project: 'repo' })).toEqual(['repo', ACCOUNT_SCOPE]);
  });
});
