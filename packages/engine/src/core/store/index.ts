import { currentTenant } from './tenant-context.js';
/**
 * Storage factory — the one place that turns the `storage` flag into a
 * concrete StorageDriver. Callers do `const store = await createStore()` and
 * never know which backend they got.
 *
 *   storage: postgres → PgStore     — the product (self-host compose / cloud)
 *   storage: sqlite   → SqliteStore — unit tests ONLY, never a user-facing mode
 *
 * Resolution order for the backend: explicit `opts.backend` > env
 * `CHAT_RECALL_STORAGE`. There is deliberately NO fallback: an unset or
 * unrecognized value throws. A silent sqlite fallback here once meant a
 * misconfigured server would boot fine and write every tenant into one
 * un-isolated local file — fail closed instead. The Postgres driver is
 * dynamic-imported so test runs never load `pg`.
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

/** Resolve the configured storage backend from options/env. Fail-closed: throws when unset or unrecognized. */
export function resolveBackend(opts: CreateStoreOptions = {}): StorageBackend {
  const raw = (opts.backend || process.env.CHAT_RECALL_STORAGE || '').toLowerCase();
  if (raw === 'postgres' || raw === 'pg' || raw === 'postgresql') return 'postgres';
  if (raw === 'sqlite') return 'sqlite';
  if (!raw) {
    throw new Error(
      'CHAT_RECALL_STORAGE is not set. Set CHAT_RECALL_STORAGE=postgres (the only supported product backend). ' +
        'The sqlite backend exists for unit tests only and must be requested explicitly.',
    );
  }
  throw new Error(
    `Unrecognized CHAT_RECALL_STORAGE value "${raw}" — expected "postgres" (or "sqlite" in unit tests). ` +
      'Refusing to guess a storage backend.',
  );
}

export async function createStore(opts: CreateStoreOptions = {}): Promise<StorageDriver> {
  if (resolveBackend(opts) === 'postgres') {
    const { PgStore } = await import('./pg.js');
    const store = new PgStore(opts.databaseUrl, opts.tenant ?? currentTenant());
    await store.init();
    return store;
  }
  const { SqliteStore } = await import('./sqlite.js');
  return new SqliteStore(opts.sqlitePath);
}
