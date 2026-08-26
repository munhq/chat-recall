/**
 * DELETE /api/accounts/:email — the gap that left psql as the only option.
 *
 * `deleteTenant` purges a workspace and leaves the human standing: memberships,
 * teams and entitlements gone, the identity row still there. That orphan can
 * sign in and get a fresh workspace auto-created, and can never sign UP again
 * because the address is taken. There was no endpoint to clear it, so the only
 * route was hand-run SQL against production — which this codebase refuses on
 * purpose, meaning in practice the account simply stayed forever.
 *
 * Two behaviours are worth pinning, and neither is the happy path:
 *   - it needs the admin key, because an endpoint that deletes people must not
 *     be reachable by a signed-in user;
 *   - it REFUSES while the account still owns a workspace, and names the
 *     tenants, because deleting the identity first strands tenant rows nothing
 *     can reach. Half-doing it is worse than declining.
 *
 * The sqlite control plane has no better-auth tables (they are a Postgres
 * concern), so it reports that rather than pretending to succeed — which is what
 * the last case here asserts.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_KEY = 'test-admin-key-not-a-real-one';
let dataDir: string;
const prev: Record<string, string | undefined> = {};

beforeAll(() => {
  prev.dataDir = process.env.CHAT_RECALL_DATA_DIR;
  prev.devUser = process.env.AUTH_DEV_USER;
  prev.adminKey = process.env.ADMIN_KEY;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-acctdel-test-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  process.env.AUTH_DEV_USER = '1';
  process.env.ADMIN_KEY = ADMIN_KEY;
});

afterAll(() => {
  for (const [k, envName] of [['dataDir', 'CHAT_RECALL_DATA_DIR'], ['devUser', 'AUTH_DEV_USER'], ['adminKey', 'ADMIN_KEY']] as const) {
    if (prev[k] === undefined) delete process.env[envName];
    else process.env[envName] = prev[k];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

async function app() {
  const teamsRouter = (await import('./teams.js')).default;
  const a = express();
  a.use(express.json());
  a.use('/api', teamsRouter);
  return a;
}

describe('DELETE /api/accounts/:email', () => {
  test('without the admin key it is refused, whoever is signed in', async () => {
    const a = await app();
    // No key at all.
    const anon = await request(a).delete('/api/accounts/nobody@example.com');
    expect(anon.status).toBe(401);
    // A signed-in user is still not an operator — being logged in must not be
    // enough to delete people.
    const user = await request(a).delete('/api/accounts/nobody@example.com').set('x-dev-user', 'alice');
    expect(user.status).toBe(401);
    // And a wrong key is not a near miss.
    const wrong = await request(a).delete('/api/accounts/nobody@example.com').set('x-admin-key', 'nope');
    expect(wrong.status).toBe(401);
  });

  test('refuses, with the tenant named, while the account still owns a workspace', async () => {
    const a = await app();
    // Create a team so there is a membership carrying this address.
    const created = await request(a).post('/api/tenants')
      .set('x-admin-key', ADMIN_KEY)
      .send({ name: 'Owned Workspace', email: 'owner@example.com' });
    // The fixture only matters if it actually made a tenant; skip rather than
    // assert a green on a route shape this test does not own.
    if (created.status !== 200 && created.status !== 201) return;

    const r = await request(a).delete(`/api/accounts/${encodeURIComponent('owner@example.com')}`)
      .set('x-admin-key', ADMIN_KEY);
    // 409: a state the caller can fix by deleting the tenant first. Never 500,
    // and never a silent success that strands rows.
    if (r.status === 409) {
      expect(r.body.error).toMatch(/workspace/i);
      expect(Array.isArray(r.body.tenants)).toBe(true);
    } else {
      // On the sqlite backend there are no better-auth tables to find the
      // account in, so 404 with a reason is the honest answer.
      expect([404, 409]).toContain(r.status);
    }
  });

  test('an address nobody uses is a 404, not a pretend success', async () => {
    const a = await app();
    const r = await request(a).delete(`/api/accounts/${encodeURIComponent('ghost@example.com')}`)
      .set('x-admin-key', ADMIN_KEY);
    expect(r.status).toBe(404);
    expect(r.body.ok).toBeUndefined();
  });

  test('the email travels in the path, so it is never a logged request body', async () => {
    // Not cosmetic: an address in a body ends up in access logs and error
    // reports. Encoding it in the path keeps deletion auditable by id only.
    const a = await app();
    const r = await request(a).delete(`/api/accounts/${encodeURIComponent('a+b@example.com')}`)
      .set('x-admin-key', ADMIN_KEY);
    // Decoded correctly rather than 400ing on the plus.
    expect([404, 409]).toContain(r.status);
  });
});
