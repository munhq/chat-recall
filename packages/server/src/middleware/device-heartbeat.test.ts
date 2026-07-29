/**
 * The device heartbeat, end to end: an authenticated request from a device
 * token stamps that device's row with when it called and what CLI it runs.
 *
 * Why this is worth a test — before it, a machine could stop syncing, or sit on
 * a CLI too old to self-update, and NOTHING server-side recorded either fact.
 * The Account "Devices" card and the sync matrix's "not syncing" column both
 * read what this middleware writes; if the stamp silently stops, they go back
 * to showing every device as healthy forever.
 *
 * Isolated CHAT_RECALL_DATA_DIR → the SQLite control plane; no Keycloak needed
 * because `ct_` tokens authenticate in every provider.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prevDataDir: string | undefined;

beforeAll(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-heartbeat-test-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

/** The stamp is fire-and-forget (it must never delay the request it observes),
 *  so poll briefly rather than assuming it landed by the time the response did. */
async function waitForSeen(tenant: string, deviceId: string, tries = 40) {
  const { createControlPlane } = await import('../imports.js');
  for (let i = 0; i < tries; i++) {
    const cp = await createControlPlane();
    try {
      const d = (await cp.listAgentTokens(tenant)).find((x: { deviceId: string }) => x.deviceId === deviceId);
      if (d?.lastSeenAt) return d;
    } finally { await cp.close(); }
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('device heartbeat middleware', () => {
  test('a device-token request records last-seen, CLI version and platform', async () => {
    const { tenantAuth } = await import('./auth.js');
    const { createControlPlane } = await import('../imports.js');

    const cp = await createControlPlane();
    let token: string;
    try { token = await cp.mintAgentToken('acme', 'work-laptop'); } finally { await cp.close(); }

    const app = express();
    app.use(tenantAuth);
    app.get('/ping', (req, res) => res.json({ tenant: req.tenant, userId: req.userId }));

    const res = await request(app)
      .get('/ping')
      .set('authorization', `Bearer ${token}`)
      .set('x-chat-recall-cli', '0.4.4')
      .set('x-chat-recall-os', 'darwin-arm64');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tenant: 'acme', userId: 'device:work-laptop' });

    const seen = await waitForSeen('acme', 'work-laptop');
    expect(seen).not.toBeNull();
    expect(seen!.cliVersion).toBe('0.4.4');
    expect(seen!.os).toBe('darwin-arm64');
  });

  test('an invalid device token is rejected and stamps nothing', async () => {
    const { tenantAuth } = await import('./auth.js');
    const { createControlPlane } = await import('../imports.js');

    const app = express();
    app.use(tenantAuth);
    app.get('/ping', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/ping').set('authorization', 'Bearer ct_deadbeef');
    expect(res.status).toBe(401);

    const cp = await createControlPlane();
    try {
      const devices = await cp.listAgentTokens('acme');
      expect(devices.every((d: { deviceId: string }) => d.deviceId !== 'ct_deadbeef')).toBe(true);
    } finally { await cp.close(); }
  });
});
