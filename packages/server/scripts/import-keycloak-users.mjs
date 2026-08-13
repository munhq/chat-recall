#!/usr/bin/env node
/**
 * Import a Keycloak user into the better-auth tables, PRESERVING the Keycloak
 * sub as the better-auth user id.
 *
 * Why the id must survive: every ownership row in the control plane is keyed
 * on the Keycloak sub as an opaque string — teams.owner_sub,
 * memberships.user_sub, agent_tokens.user_sub, and author_sub attribution on
 * the data tables. Importing with the same id means zero data migration: the
 * user signs in with a new password and owns everything they owned before.
 *
 * Usage (run inside the server image / with server node_modules available):
 *
 *   IMPORT_PASSWORD='<new password>' DATABASE_URL='postgres://…' \
 *     node scripts/import-keycloak-users.mjs \
 *       --id 2491705a-…  --email adi@hotmun.com  --name adi
 *
 * Idempotent: an existing user row with the same id is left untouched (the
 * script reports it and exits 0). Requires the better-auth tables to exist —
 * boot the server once with AUTH_PROVIDER=better-auth first (its migrator
 * creates them).
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const id = arg('id');
const email = arg('email');
const name = arg('name') || (email ? email.split('@')[0] : undefined);
const password = process.env.IMPORT_PASSWORD;
const dbUrl = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;

if (!id || !email || !dbUrl || !password) {
  console.error('usage: IMPORT_PASSWORD=… DATABASE_URL=… node import-keycloak-users.mjs --id <sub> --email <email> [--name <name>]');
  process.exit(1);
}
if (password.length < 8) {
  console.error('IMPORT_PASSWORD must have at least 8 characters (better-auth minimum).');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
try {
  const existing = await pool.query('SELECT id, email FROM "user" WHERE id = $1 OR email = $2', [id, email]);
  if (existing.rowCount > 0) {
    console.log(`already imported: user ${existing.rows[0].id} (${existing.rows[0].email}) exists — nothing to do.`);
    process.exit(0);
  }
  const hash = await hashPassword(password);
  const now = new Date();
  await pool.query('BEGIN');
  await pool.query(
    'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, $4, $4)',
    [id, name, email, now],
  );
  await pool.query(
    'INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $6)',
    [randomUUID(), id, 'credential', id, hash, now],
  );
  await pool.query('COMMIT');
  console.log(`imported: ${email} as user id ${id} (email marked verified, credential account created).`);
} catch (err) {
  await pool.query('ROLLBACK').catch(() => {});
  console.error('import failed:', err.message || err);
  process.exit(1);
} finally {
  await pool.end();
}
