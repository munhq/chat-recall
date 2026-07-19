/**
 * TenantTtlCache — the guard against cross-tenant response-cache leaks.
 *
 * The regression this pins down: module-level response caches used to be
 * plain `let cache = …` values, so in cloud mode (all tenants in one
 * process) tenant A's cached payload was served to tenant B for the TTL
 * window. Every entry must be invisible outside the ambient tenant that
 * wrote it.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { runWithTenant, runWithAuthor } from '@chat-recall/engine/core/store/tenant-context.js';
import { TenantTtlCache } from './tenant-cache.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('TenantTtlCache', () => {
  test('a value cached by tenant A is INVISIBLE to tenant B and to no-tenant', () => {
    const cache = new TenantTtlCache<string>(60_000);
    runWithTenant('team-a', () => cache.set('analytics from A'));

    expect(runWithTenant('team-a', () => cache.get())).toBe('analytics from A');
    expect(runWithTenant('team-b', () => cache.get())).toBeUndefined();
    // Outside any request context (no ambient tenant) → the 'default' scope,
    // which must not see team-a's entry either.
    expect(cache.get()).toBeUndefined();
  });

  test('same explicit key, different tenants → independent entries', () => {
    const cache = new TenantTtlCache<number>(60_000);
    runWithTenant('team-a', () => cache.set('k', 1));
    runWithTenant('team-b', () => cache.set('k', 2));
    expect(runWithTenant('team-a', () => cache.get('k'))).toBe(1);
    expect(runWithTenant('team-b', () => cache.get('k'))).toBe(2);
  });

  test('a separator-bearing key cannot cross into another tenant scope', () => {
    const cache = new TenantTtlCache<string>(60_000);
    // Keys are built from user-controlled input (filter params), so a key
    // may contain anything -- including the NUL separator itself. Whatever
    // the key, the composite always starts with `<tenant>\u0000`, and tenant
    // slugs (validated at team creation) can never contain NUL, so no key
    // can produce another tenant's composite.
    runWithTenant('a', () => cache.set('b\u0000k', 'poison'));
    expect(runWithTenant('b', () => cache.get('k'))).toBeUndefined();
    expect(runWithTenant('a', () => cache.get('b\u0000k'))).toBe('poison');
  });

  test('entries expire after the TTL', () => {
    vi.useFakeTimers();
    const cache = new TenantTtlCache<string>(1000);
    runWithTenant('t', () => cache.set('v'));
    expect(runWithTenant('t', () => cache.get())).toBe('v');
    vi.advanceTimersByTime(1001);
    expect(runWithTenant('t', () => cache.get())).toBeUndefined();
  });

  test('maxEntries caps total size across tenants (oldest evicts first)', () => {
    const cache = new TenantTtlCache<number>(60_000, 3);
    runWithTenant('t1', () => cache.set('a', 1));
    runWithTenant('t2', () => cache.set('b', 2));
    runWithTenant('t3', () => cache.set('c', 3));
    runWithTenant('t4', () => cache.set('d', 4)); // evicts t1's entry
    expect(runWithTenant('t1', () => cache.get('a'))).toBeUndefined();
    expect(runWithTenant('t4', () => cache.get('d'))).toBe(4);
  });

  test('within one tenant, different VIEWERS get independent entries (no per-member leak)', () => {
    // Many cached reads are RLS-filtered per viewer now; a cache keyed by tenant
    // alone would serve member A's filtered aggregate to member B. Entries must
    // be invisible across viewers within the same tenant.
    const cache = new TenantTtlCache<string>(60_000);
    runWithTenant('team', () => runWithAuthor({ sub: 'alice', device: null }, () => cache.set('alice-only view')));
    expect(runWithTenant('team', () => runWithAuthor({ sub: 'alice', device: null }, () => cache.get()))).toBe('alice-only view');
    // bob (same tenant, different viewer) must NOT see alice's cached entry.
    expect(runWithTenant('team', () => runWithAuthor({ sub: 'bob', device: null }, () => cache.get()))).toBeUndefined();
    // a worker (no author context → '*' scope) must not see it either.
    expect(runWithTenant('team', () => cache.get())).toBeUndefined();
  });

  test('clear() empties every tenant scope', () => {
    const cache = new TenantTtlCache<string>(60_000);
    runWithTenant('a', () => cache.set('x'));
    runWithTenant('b', () => cache.set('y'));
    cache.clear();
    expect(runWithTenant('a', () => cache.get())).toBeUndefined();
    expect(runWithTenant('b', () => cache.get())).toBeUndefined();
  });
});
