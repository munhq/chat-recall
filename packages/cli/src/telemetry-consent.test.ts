/**
 * Telemetry must be impossible to collect from someone who said no, and from a
 * tenant that is not paying — and it must be structurally incapable of carrying
 * the user's work.
 *
 * The two gates are tested independently because that is the property that
 * matters: conflating "the user agreed" with "the plan includes it" is how a
 * product ends up collecting from someone who opted out.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prevDir: string | undefined;
let prevEnv: string | undefined;
let mod: typeof import('./telemetry-consent.js');

const SERVER = 'https://recall.test';

/** Write a settings file with the given privacy block. */
function settings(privacy: Record<string, unknown>): void {
  mkdirSync(join(dataDir, 'settings'), { recursive: true });
  writeFileSync(
    join(dataDir, 'settings', 'settings.json'),
    JSON.stringify({ v: 1, privacy, sources: {}, sync: {}, team: {} }),
  );
}

beforeEach(async () => {
  prevDir = process.env.CHAT_RECALL_DATA_DIR;
  prevEnv = process.env.CHAT_RECALL_TELEMETRY;
  delete process.env.CHAT_RECALL_TELEMETRY;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-telemetry-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  vi.resetModules();
  mod = await import('./telemetry-consent.js');
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = prevDir;
  if (prevEnv === undefined) delete process.env.CHAT_RECALL_TELEMETRY; else process.env.CHAT_RECALL_TELEMETRY = prevEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the user can always say no', () => {
  test('telemetry:false blocks reporting even when the server allows it', () => {
    settings({ telemetry: false });
    mod.setTelemetryEligible(SERVER, true);
    expect(mod.userConsents()).toBe(false);
    expect(mod.mayReport(SERVER)).toBe(false);
  });

  test.each(['0', 'off', 'false', 'no', 'OFF'])('CHAT_RECALL_TELEMETRY=%s blocks it', (v) => {
    process.env.CHAT_RECALL_TELEMETRY = v;
    mod.setTelemetryEligible(SERVER, true);
    expect(mod.userConsents()).toBe(false);
    expect(mod.mayReport(SERVER)).toBe(false);
  });

  // NO SETTINGS FILE IS THE COMMON CASE — a fresh install has none — and
  // loadSettings() returns defaults rather than throwing, so it cannot be
  // distinguished from a corrupt one. Resolving "unknown" to the documented
  // default (on) is therefore correct; resolving it to off would mean telemetry
  // never worked for anyone until they happened to write a settings file.
  //
  // The try/catch in userConsents() still exists for the case loadSettings()
  // DOES throw, and that path returns false. This asserts the reachable
  // behaviour rather than the one I assumed.
  test('a machine with no settings file follows the documented default', () => {
    mod.setTelemetryEligible(SERVER, true);
    expect(mod.userConsents()).toBe(true);
    // And the env kill-switch still works on such a machine, which is what
    // makes "I never configured anything but I want no telemetry" answerable.
    process.env.CHAT_RECALL_TELEMETRY = '0';
    expect(mod.userConsents()).toBe(false);
  });

  test('the documented default is ON — this is an opt-OUT', () => {
    settings({});
    expect(mod.userConsents()).toBe(true);
  });
});

describe('only paying tenants', () => {
  // DEFAULT DENY. An older server that says nothing about telemetry must get
  // nothing, rather than being assumed permissive.
  test('a server that never answered is not eligible', () => {
    settings({});
    expect(mod.serverAllowsTelemetry(SERVER)).toBe(false);
    expect(mod.mayReport(SERVER)).toBe(false);
  });

  test('the server can allow and later revoke', () => {
    settings({});
    mod.setTelemetryEligible(SERVER, true);
    expect(mod.mayReport(SERVER)).toBe(true);
    mod.setTelemetryEligible(SERVER, false);   // plan lapsed
    expect(mod.mayReport(SERVER)).toBe(false);
  });

  test('eligibility is per server, not global', () => {
    settings({});
    mod.setTelemetryEligible('https://paid.test', true);
    expect(mod.mayReport('https://paid.test')).toBe(true);
    expect(mod.mayReport('https://other.test')).toBe(false);
  });

  test('a trailing slash is the same server', () => {
    settings({});
    mod.setTelemetryEligible('https://paid.test/', true);
    expect(mod.mayReport('https://paid.test')).toBe(true);
  });

  test('BOTH gates must open', () => {
    settings({ telemetry: true });
    mod.setTelemetryEligible(SERVER, true);
    expect(mod.mayReport(SERVER)).toBe(true);
  });
});

describe('a payload can never carry the user\'s work', () => {
  test('operational facts pass', () => {
    const ok = {
      kind: 'walk_complete', walkMs: 91_000, considered: 15_727, shipped: 262,
      uploadedBytes: 6_701_234, http429: 3, breakerTrips: 0, rssPeakMb: 494,
      cliVersion: '0.5.6', os: 'linux',
    };
    expect(mod.findSensitiveKeys(ok)).toEqual([]);
    expect(() => mod.assertNoSensitiveKeys(ok)).not.toThrow();
  });

  // Each of these is exactly the "just a bit of context" field that erodes the
  // promise one commit at a time.
  test.each([
    ['projectPath', { projectPath: '/home/adi/code/secret' }],
    ['sessionId', { sessionId: 'abc-123' }],
    ['prompt', { prompt: 'what the user typed' }],
    ['filePath', { filePath: '/etc/passwd' }],
    ['repo', { repo: 'acme/private' }],
    ['content', { content: 'transcript text' }],
    ['email', { email: 'someone@example.com' }],
    ['cwd', { cwd: '/home/adi' }],
  ])('%s is refused', (_name, payload) => {
    expect(mod.findSensitiveKeys(payload).length).toBeGreaterThan(0);
    expect(() => mod.assertNoSensitiveKeys(payload)).toThrow(/forbidden key/);
  });

  test('nested and arrayed offenders are caught, not just top-level ones', () => {
    const bad = { kind: 'x', detail: { inner: [{ sessionId: 'leak' }] } };
    const found = mod.findSensitiveKeys(bad);
    expect(found.length).toBe(1);
    expect(found[0].where).toContain('detail.inner');
  });

  test('the error names the offending key, so it is fixable without a debugger', () => {
    expect(() => mod.assertNoSensitiveKeys({ projectPath: '/x' })).toThrow(/projectPath/);
  });
});
