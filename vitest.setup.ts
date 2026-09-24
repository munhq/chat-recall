import { inject } from 'vitest';

// resolveBackend() is fail-closed: an unset CHAT_RECALL_STORAGE throws instead
// of silently falling back to sqlite (a misconfigured server must not boot onto
// a local file). Tests are the one place sqlite is a legitimate backend, so the
// suite opts in explicitly here. Postgres-mode runs (store parity/isolation)
// export CHAT_RECALL_STORAGE=postgres + DATABASE_URL themselves.
if (!process.env.CHAT_RECALL_STORAGE) {
  process.env.CHAT_RECALL_STORAGE = 'sqlite';
}

// Postgres tests connect as the unprivileged role vitest.global-setup.ts
// prepared, so row-level security applies to them as it does in production.
// Setup that needs the privileged role reads pgAdminUrl() from
// packages/engine/src/test-support/pg-urls.ts.
const pgAppUrl = inject('pgAppUrl');
if (pgAppUrl) {
  if (process.env.DATABASE_URL) process.env.DATABASE_URL = pgAppUrl;
  if (process.env.CHAT_RECALL_DATABASE_URL) process.env.CHAT_RECALL_DATABASE_URL = pgAppUrl;
}
const pgAdmin = inject('pgAdminUrl');
if (pgAdmin) process.env.CHAT_RECALL_TEST_ADMIN_DATABASE_URL = pgAdmin;
