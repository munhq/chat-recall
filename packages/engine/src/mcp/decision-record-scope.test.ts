/**
 * Which scope a recorded decision binds.
 *
 * This is the failure these tests exist for: a session recorded eight
 * decisions with the subject `*:api`, `*:auth`, `*:frontend` and no `project`,
 * reading them out of ONE repository's package.json. Every other project then
 * inherited that repository's stack — a project with no Postgres was told its
 * database decision was Postgres, and the register looked identical for two
 * unrelated products.
 *
 * The subject shape is the tool's own output, so a caller passing it back is
 * normal. Reading the area out of it is what makes the write supersede
 * anything, and reading the scope out of it is what keeps the account tier for
 * things that are actually true everywhere.
 */
import { describe, test, expect } from 'vitest';
import { resolveRecordScope } from './tools.js';

describe('an area-keyed subject is read, not ignored', () => {
  test('THE FAILURE: an area-keyed subject no longer records an area-less fact', () => {
    const r = resolveRecordScope({ subject: '*:api', cwdWorkspace: null });
    expect(r.area).toBe('api');
    expect(r.scope).toBe('account');
    expect(r.project).toBeUndefined();
  });

  test('a project-keyed subject carries its project', () => {
    const r = resolveRecordScope({ subject: 'example-app:auth', cwdWorkspace: null });
    expect(r.area).toBe('auth');
    expect(r.project).toBe('example-app');
    expect(r.scope).toBeUndefined();   // the project is the narrowest thing named
  });

  test('a group-keyed subject carries its group', () => {
    const r = resolveRecordScope({ subject: 'ws:personal:deploy', cwdWorkspace: null });
    expect(r.area).toBe('deploy');
    expect(r.workspace).toBe('personal');
    expect(r.project).toBeUndefined();
  });

  test('free text that happens to contain a colon stays free text', () => {
    // The area must be a known one, or "use the new parser" becomes an area.
    const r = resolveRecordScope({ subject: 'chat-recall: use the new parser', cwdWorkspace: null });
    expect(r.area).toBeNull();
    expect(r.project).toBeUndefined();
  });

  test('a plain subject with no colon is unchanged', () => {
    expect(resolveRecordScope({ subject: 'auth strategy', cwdWorkspace: null }).area).toBeNull();
  });
});

describe('explicit arguments win over the subject', () => {
  test('an area passed outright beats the one in the subject', () => {
    const r = resolveRecordScope({ subject: '*:api', area: 'database', cwdWorkspace: null });
    expect(r.area).toBe('database');
  });

  test('a project passed outright beats the account the subject asked for', () => {
    const r = resolveRecordScope({ subject: '*:api', project: 'other-app', cwdWorkspace: null });
    expect(r.project).toBe('other-app');
  });

  test('an explicit scope is never overridden', () => {
    const r = resolveRecordScope({
      subject: 'auth', area: 'auth', project: 'example-app', scope: 'account', cwdWorkspace: 'personal',
    });
    expect(r.scope).toBe('account');
  });
});

describe('the folder group the caller is standing in', () => {
  test('fills in when nothing named one', () => {
    const r = resolveRecordScope({ subject: 'auth', area: 'auth', cwdWorkspace: 'personal' });
    expect(r.workspace).toBe('personal');
  });

  test('never overrides a group the caller named', () => {
    const r = resolveRecordScope({ subject: 'auth', area: 'auth', workspace: 'acme', cwdWorkspace: 'personal' });
    expect(r.workspace).toBe('acme');
  });

  test('a caller in no group passes none, and the server decides', () => {
    const r = resolveRecordScope({ subject: 'auth', area: 'auth', cwdWorkspace: null });
    expect(r.workspace).toBeUndefined();
  });

  test('a group present with a project does not steal the write — the project is narrower', () => {
    // Both travel; the server binds the narrowest. This asserts the tool does
    // not drop the project just because a group was resolved from the cwd.
    const r = resolveRecordScope({ subject: 'auth', area: 'auth', project: 'example-app', cwdWorkspace: 'personal' });
    expect(r.project).toBe('example-app');
    expect(r.workspace).toBe('personal');
    expect(r.scope).toBeUndefined();
  });
});
