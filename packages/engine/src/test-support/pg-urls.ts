/**
 * The two Postgres URLs a test can use. vitest.global-setup.ts explains why
 * there are two.
 *
 * pgTestUrl() connects as the role row-level security applies to. Run the code
 * under test with it.
 *
 * pgAdminUrl() connects as a privileged role. Use it only for setup that
 * production never does: creating and granting roles, and reading or seeding
 * rows past RLS. When no privileged URL is known it falls back to the test URL,
 * and setup that needs privilege fails with the database's own error.
 */
export function pgTestUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL || undefined;
}

export function pgAdminUrl(): string | undefined {
  return process.env.CHAT_RECALL_TEST_ADMIN_DATABASE_URL || pgTestUrl();
}
