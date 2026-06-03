/**
 * Ambient tenant context. The server's auth middleware wraps each request in
 * `runWithTenant(tenant, () => next())`; the store factories then default their
 * tenant to `currentTenant()` when no explicit `tenant` option is passed. This
 * keeps the ~45 `createStore()` call-sites untouched — they automatically scope
 * to the request's tenant — while the CLI / auto-indexer (which never call
 * runWithTenant) fall through to env / 'default'.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<string>();

/** Run `fn` with `tenant` as the ambient tenant for all async work it spawns. */
export function runWithTenant<T>(tenant: string, fn: () => T): T {
  return als.run(tenant, fn);
}

/** The ambient tenant for the current async context, or undefined outside one. */
export function currentTenant(): string | undefined {
  return als.getStore();
}
