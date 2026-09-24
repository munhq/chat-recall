/**
 * Postgres-backed tests connect as a role that row-level security applies to.
 *
 * Every Postgres test reads DATABASE_URL, and in CI and in a local Docker run
 * that URL names the container's bootstrap role: SUPERUSER and BYPASSRLS.
 * PostgreSQL skips row-level security for such a role, and FORCE ROW LEVEL
 * SECURITY does not change that. Production connects as a role that owns the
 * tables and has neither attribute. So an RLS defect passed every test here and
 * failed every production sync for eight days:
 *
 *   42501: new row violates row-level security policy "author_visibility"
 *          for table "compute_cache"
 *
 * When DATABASE_URL is privileged, this setup creates APP_ROLE with the
 * production shape and hands the test workers a URL for it (see
 * vitest.setup.ts). The privileged URL stays available to the tests as
 * CHAT_RECALL_TEST_ADMIN_DATABASE_URL, for setup that production never does:
 * creating roles, granting, and reading or seeding rows past RLS.
 *
 * When DATABASE_URL already names an unprivileged role, the tests use it as
 * given, and CHAT_RECALL_TEST_ADMIN_DATABASE_URL may name the admin role.
 */
import pg from 'pg';
import type { TestProject } from 'vitest/node';

/** The login role the tests connect as. It owns what it creates, like production. */
const APP_ROLE = 'cr_app_test';
const APP_PASSWORD = 'cr_app_test_pw';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The URL the Postgres tests connect with. Empty when there is no Postgres. */
    pgAppUrl: string;
    /** A privileged URL for test setup. Empty when none is known. */
    pgAdminUrl: string;
  }
}

function withRole(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

export default async function setup(project: TestProject): Promise<void> {
  const given = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL || '';
  const explicitAdmin = process.env.CHAT_RECALL_TEST_ADMIN_DATABASE_URL || '';
  project.provide('pgAppUrl', given);
  project.provide('pgAdminUrl', explicitAdmin);
  if (!given) return;

  const admin = new pg.Client({ connectionString: given });
  await admin.connect();
  try {
    const me = (await admin.query(
      `SELECT current_user AS name, rolsuper, rolbypassrls,
              current_setting('server_version_num')::int AS version
         FROM pg_roles WHERE rolname = current_user`,
    )).rows[0];
    if (!me.rolsuper && !me.rolbypassrls) return;

    const role = admin.escapeIdentifier(APP_ROLE);
    // `vector` is not a trusted extension, so a role without SUPERUSER cannot
    // create it. The store's own CREATE EXTENSION IF NOT EXISTS then finds it.
    for (const ext of ['vector', 'btree_gin', 'pg_trgm']) {
      await admin.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${admin.escapeLiteral(APP_ROLE)}) THEN
        CREATE ROLE ${role} LOGIN;
      END IF;
    END $$;`);
    await admin.query(
      `ALTER ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD ${admin.escapeLiteral(APP_PASSWORD)}`,
    );
    // PostgreSQL 15 stopped granting CREATE on `public` to PUBLIC, and the store
    // runs its idempotent schema bootstrap on connect, as production does.
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);

    // On a fresh database the app role creates, and so owns, every table. On a
    // database an earlier run bootstrapped as the admin, the tables belong to
    // another role, and the bootstrap's ALTER TABLE needs ownership. Membership
    // in the owner gives ownership privileges. SUPERUSER and BYPASSRLS are role
    // attributes, which membership never passes on. On PostgreSQL 16 and later
    // SET FALSE also stops the app role from a SET ROLE to the owner.
    const owners = (await admin.query(
      `SELECT DISTINCT pg_get_userbyid(o.owner) AS name FROM (
         SELECT 'pg_class'::regclass AS cls, oid, relowner AS owner FROM pg_class WHERE relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'pg_proc'::regclass, oid, proowner FROM pg_proc WHERE pronamespace = 'public'::regnamespace
         -- An array type or a row type goes with its element type or its table.
         UNION ALL SELECT 'pg_type'::regclass, oid, typowner FROM pg_type
           WHERE typnamespace = 'public'::regnamespace AND typelem = 0 AND typrelid = 0
       ) o
       WHERE pg_get_userbyid(o.owner) <> $1
         -- Objects an extension created belong to the extension, and the store
         -- never alters them.
         AND NOT EXISTS (SELECT 1 FROM pg_depend d
                          WHERE d.classid = o.cls AND d.objid = o.oid AND d.deptype = 'e')`,
      [APP_ROLE],
    )).rows.map((r: { name: string }) => r.name);
    const option = me.version >= 160000 ? ' WITH INHERIT TRUE, SET FALSE' : '';
    for (const owner of owners) {
      await admin.query(`GRANT ${admin.escapeIdentifier(owner)} TO ${role}${option}`);
    }

    project.provide('pgAppUrl', withRole(given, APP_ROLE, APP_PASSWORD));
    project.provide('pgAdminUrl', given);
  } finally {
    await admin.end();
  }
}
