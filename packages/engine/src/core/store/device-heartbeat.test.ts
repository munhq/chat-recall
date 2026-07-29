/**
 * Device liveness: touchAgentToken → listAgentTokens.
 *
 * This is what makes "that machine stopped syncing / runs an old CLI"
 * answerable at all — before it, the server knew a device token existed and
 * nothing else, so a stale box was invisible to every UI.
 *
 * The one non-obvious rule is COALESCE: most requests carry no version header
 * (a bare curl, an older CLI), and those must NOT wipe the version a real
 * check-in reported — otherwise the field flaps to unknown and the "outdated"
 * badge disappears exactly when it matters.
 *
 * SQLite-only here (no DATABASE_URL needed): the pg path runs the same UPDATE
 * with the same COALESCE, so the semantics are identical by construction.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createControlPlane, type ControlPlane } from './control-plane.js';

let tmp: string;
let cp: ControlPlane;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cr-cp-device-'));
  cp = await createControlPlane({ sqlitePath: join(tmp, 'cache.db') });
});
afterEach(async () => {
  await cp.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('device heartbeat', () => {
  test('a freshly minted device has never been seen', async () => {
    await cp.mintAgentToken('acme', 'laptop');
    const [d] = await cp.listAgentTokens('acme');
    expect(d.deviceId).toBe('laptop');
    expect(d.lastSeenAt).toBeNull();
    expect(d.cliVersion).toBeNull();
    expect(d.os).toBeNull();
  });

  test('touch records when it checked in, with version + platform', async () => {
    await cp.mintAgentToken('acme', 'laptop');
    const before = Date.now();
    await cp.touchAgentToken('acme', 'laptop', { cliVersion: '0.4.4', os: 'darwin-arm64' });
    const [d] = await cp.listAgentTokens('acme');
    expect(d.lastSeenAt).not.toBeNull();
    expect(d.lastSeenAt!).toBeGreaterThanOrEqual(before);
    expect(d.cliVersion).toBe('0.4.4');
    expect(d.os).toBe('darwin-arm64');
  });

  test('a versionless touch refreshes last-seen without erasing the version', async () => {
    await cp.mintAgentToken('acme', 'laptop');
    await cp.touchAgentToken('acme', 'laptop', { cliVersion: '0.4.4', os: 'darwin-arm64' });
    const first = (await cp.listAgentTokens('acme'))[0].lastSeenAt!;
    await new Promise((r) => setTimeout(r, 5));
    await cp.touchAgentToken('acme', 'laptop');
    const [d] = await cp.listAgentTokens('acme');
    expect(d.cliVersion).toBe('0.4.4');
    expect(d.os).toBe('darwin-arm64');
    expect(d.lastSeenAt!).toBeGreaterThan(first);
  });

  test('touching one device never touches another tenant\'s same-named device', async () => {
    await cp.mintAgentToken('acme', 'laptop');
    await cp.mintAgentToken('other', 'laptop');
    await cp.touchAgentToken('acme', 'laptop', { cliVersion: '0.4.4' });
    expect((await cp.listAgentTokens('other'))[0].lastSeenAt).toBeNull();
  });

  test('touching an unknown device is a no-op, not an error', async () => {
    await expect(cp.touchAgentToken('acme', 'ghost', { cliVersion: '0.4.4' })).resolves.toBeUndefined();
  });
});
