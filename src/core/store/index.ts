/**
 * Storage factory — the one place that turns the `storage` flag into a
 * concrete StorageDriver. Callers do `const store = await createStore()` and
 * never know which backend they got.
 *
 *   storage: sqlite    (default) → SqliteStore  — solo / local, zero deps
 *   storage: postgres            → PgStore      — team self-host / our cloud
 *
 * Resolution order for the backend: explicit `opts.backend` > env
 * `CHAT_RECALL_STORAGE` > 'sqlite'. The Postgres driver is dynamic-imported
 * so SQLite users never load `pg`.
 */

import type { StorageBackend, StorageDriver } from './driver.js';

export type { StorageDriver, StorageBackend } from './driver.js';

export interface CreateStoreOptions {
  /** Override the configured backend. */
  backend?: StorageBackend;
  /** SQLite file path (sqlite backend only). Defaults to the cache db path. */
  sqlitePath?: string;
  /** Postgres connection string (postgres backend only). Defaults to DATABASE_URL. */
  databaseUrl?: string;
  /** Tenant/team scope (postgres backend only). Defaults to CHAT_RECALL_TENANT or 'default'. */
  tenant?: string;
}

/** Resolve the configured storage backend from options/env. */
export function resolveBackend(opts: CreateStoreOptions = {}): StorageBackend {
  const raw = (opts.backend || process.env.CHAT_RECALL_STORAGE || 'sqlite').toLowerCase();
  if (raw === 'postgres' || raw === 'pg' || raw === 'postgresql') return 'postgres';
  return 'sqlite';
}

export async function createStore(opts: CreateStoreOptions = {}): Promise<StorageDriver> {
  if (resolveBackend(opts) === 'postgres') {
    const { PgStore } = await import('./pg.js');
    const store = new PgStore(opts.databaseUrl, opts.tenant);
    await store.init();
    return store;
  }
  const { SqliteStore } = await import('./sqlite.js');
  return new SqliteStore(opts.sqlitePath);
}
