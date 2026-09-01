/**
 * A DEVICE THAT WILL NEVER UPDATE ITSELF MUST SAY SO, ONCE.
 *
 * ── The silence this closes ───────────────────────────────────────────────
 * A machine sat six releases behind with `CHAT_RECALL_AUTO_UPDATE=0` in its
 * systemd unit. Every layer was working as designed and none of them said a
 * word: the daemon's own log suppresses "disabled" and "no CLI release" on
 * purpose (they would be printed every six hours, forever), and the only
 * telemetry — `auto_update_failed` — is reported after the plan is EXECUTED, so
 * a plan that never runs never reports.
 *
 * The result was a collector running old code, reporting perfectly correct
 * numbers about everything except the one fact that mattered.
 *
 * "Once per process per server" is the whole design: a standing condition
 * repeated every six hours is noise, and noise is what got the log line
 * suppressed in the first place.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const reported: Array<{ kind: string; message?: string }> = [];
vi.mock('./client-events.js', () => ({
  reportClientEvent: (kind: string, opts: { message?: string } = {}) => {
    reported.push({ kind, message: opts.message });
  },
}));

const realFetch = globalThis.fetch;

/** /api/capabilities, advertising a release far newer than anything on disk. */
function stubCapabilities(): void {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ edition: 'cloud', cli: { version: '99.0.0', sha256: 'a'.repeat(64) } }),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  reported.length = 0;
  stubCapabilities();
  vi.resetModules();          // a fresh module = a fresh "reported once" set
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CHAT_RECALL_AUTO_UPDATE;
});

describe('a standing refusal to self-update is reported', () => {
  test('an explicitly disabled updater reports the reason and both versions', async () => {
    process.env.CHAT_RECALL_AUTO_UPDATE = '0';
    const { runAutoUpdate } = await import('./auto-update.js');

    const r = await runAutoUpdate('https://recall.example.com', {}, '0.5.24');
    expect(r.updated).toBe(false);
    expect(r.reason).toContain('disabled');

    expect(reported).toHaveLength(1);
    expect(reported[0].kind).toBe('auto_update_skipped');
    // Both numbers, because "disabled" alone does not say what is being missed.
    expect(reported[0].message).toContain('disabled');
    expect(reported[0].message).toContain('99.0.0');
  });

  test('it is reported ONCE, not every six hours forever', async () => {
    process.env.CHAT_RECALL_AUTO_UPDATE = '0';
    const { runAutoUpdate } = await import('./auto-update.js');

    for (let i = 0; i < 5; i++) await runAutoUpdate('https://recall.example.com', {}, '0.5.24');
    expect(reported).toHaveLength(1);
  });

  test('a second server is its own standing condition', async () => {
    process.env.CHAT_RECALL_AUTO_UPDATE = '0';
    const { runAutoUpdate } = await import('./auto-update.js');

    await runAutoUpdate('https://recall.example.com', {}, '0.5.24');
    await runAutoUpdate('http://192.168.1.9:8085', {}, '0.5.24');
    expect(reported).toHaveLength(2);
  });

  test('a server offering no CLI release is also a standing condition', async () => {
    globalThis.fetch = (async () => ({
      ok: true, status: 200, json: async () => ({ edition: 'self-host', cli: null }),
    })) as unknown as typeof fetch;
    const { runAutoUpdate } = await import('./auto-update.js');

    await runAutoUpdate('https://recall.example.com', {}, '0.5.24');
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toContain('no CLI release');
  });

  // THE NOISE TEST. "already current" is the healthy answer, and reporting it
  // would put an event on the wire every six hours from every healthy machine.
  test('a device that is already current reports NOTHING', async () => {
    globalThis.fetch = (async () => ({
      ok: true, status: 200, json: async () => ({ edition: 'cloud', cli: { version: '0.0.1', sha256: 'b'.repeat(64) } }),
    })) as unknown as typeof fetch;
    const { runAutoUpdate } = await import('./auto-update.js');

    const r = await runAutoUpdate('https://recall.example.com', {}, '9.9.9');
    expect(r.reason).toContain('already current');
    expect(reported).toEqual([]);
  });
});
