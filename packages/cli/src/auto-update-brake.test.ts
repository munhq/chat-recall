/**
 * The brake on a self-update that keeps failing.
 *
 * One machine attempted 0.5.32 -> 0.6.4 four thousand two hundred and forty-eight
 * times over ten days. Nothing applied a brake: the flow is best-effort, so each
 * attempt returned a reason, dropped it, and the next sync tried again. These
 * tests pin the three behaviours that stop that happening again.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasGivenUpOn, noteUpdateFailure, clearUpdateFailures, readUpdateState,
} from './auto-update.js';

let dir: string;
const orig = process.env.CHAT_RECALL_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-update-brake-'));
  process.env.CHAT_RECALL_DATA_DIR = dir;
});
afterEach(() => {
  if (orig === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = orig;
  rmSync(dir, { recursive: true, force: true });
});

describe('giving up on a target that will not install', () => {
  test('a fresh device has no brake', () => {
    expect(hasGivenUpOn('0.6.4')).toBe(false);
  });

  test('two failures still retry — a flaky network is not a broken install', () => {
    expect(noteUpdateFailure('0.6.4')).toBe(1);
    expect(hasGivenUpOn('0.6.4')).toBe(false);
    expect(noteUpdateFailure('0.6.4')).toBe(2);
    expect(hasGivenUpOn('0.6.4')).toBe(false);
  });

  test('the third failure stops it', () => {
    noteUpdateFailure('0.6.4');
    noteUpdateFailure('0.6.4');
    expect(noteUpdateFailure('0.6.4')).toBe(3);
    expect(hasGivenUpOn('0.6.4')).toBe(true);
  });

  test('THE POINT: a stuck device stops trying instead of running forever', () => {
    // Simulates the real incident shape: attempt after attempt, same target.
    for (let i = 0; i < 50; i++) noteUpdateFailure('0.6.4');
    expect(hasGivenUpOn('0.6.4')).toBe(true);
    // And the count is still recorded, so the state is legible rather than a
    // silent boolean nobody can explain later.
    expect(readUpdateState().failures).toBeGreaterThanOrEqual(3);
  });
});

describe('the brake is per target version', () => {
  test('a NEW release clears it and gets a fresh three attempts', () => {
    for (let i = 0; i < 5; i++) noteUpdateFailure('0.6.4');
    expect(hasGivenUpOn('0.6.4')).toBe(true);

    // The next release must not inherit the previous one's brake, or a single
    // bad build strands the machine permanently.
    expect(hasGivenUpOn('0.6.5')).toBe(false);
    expect(noteUpdateFailure('0.6.5')).toBe(1);
    expect(hasGivenUpOn('0.6.5')).toBe(false);
  });

  test('counting a different target resets the count rather than adding to it', () => {
    noteUpdateFailure('0.6.4');
    noteUpdateFailure('0.6.4');
    expect(noteUpdateFailure('0.7.0')).toBe(1);
    expect(readUpdateState().target).toBe('0.7.0');
  });
});

describe('recovery', () => {
  test('a successful install clears the brake', () => {
    for (let i = 0; i < 5; i++) noteUpdateFailure('0.6.4');
    expect(hasGivenUpOn('0.6.4')).toBe(true);
    clearUpdateFailures();
    expect(hasGivenUpOn('0.6.4')).toBe(false);
  });

  test('unreadable state means retry, never refuse', () => {
    // Failing to persist a brake must degrade toward updating. A corrupt file
    // that blocked updates would be strictly worse than the loop it replaced.
    process.env.CHAT_RECALL_DATA_DIR = join(dir, 'does', 'not', 'exist');
    expect(readUpdateState()).toEqual({});
    expect(hasGivenUpOn('0.6.4')).toBe(false);
  });
});

// The whole flow, with an install that always fails. The 0.5.32 collector had
// no brake and ran this 5,769 times. Here the fourth and later ticks must not
// download or install, and only three events reach the server.
describe('runAutoUpdate applies the brake', () => {
  test('three failed installs, one "giving up" event, then no more attempts', async () => {
    vi.resetModules();
    const reported: string[] = [];
    vi.doMock('./client-events.js', () => ({
      reportClientEvent: (_kind: string, opts: { message?: string } = {}) => { reported.push(opts.message ?? ''); },
    }));
    const realFetch = globalThis.fetch;
    try {
      const { runAutoUpdate } = await import('./auto-update.js');
      const bytes = Buffer.from('tarball');
      let downloads = 0;
      let installs = 0;
      const deps = {
        download: async () => { downloads++; return bytes; },
        install: () => { installs++; throw new Error('Command failed: npm install -g'); },
        restart: () => {},
      };
      // The checksum must match or the install step is never reached.
      const { createHash } = await import('node:crypto');
      globalThis.fetch = (async () => ({
        ok: true, status: 200,
        json: async () => ({ edition: 'cloud', cli: { version: '99.0.0', sha256: createHash('sha256').update(bytes).digest('hex') } }),
      })) as unknown as typeof fetch;

      for (let i = 0; i < 10; i++) await runAutoUpdate('https://recall.example.com', {}, '0.5.32', deps);

      expect(installs).toBe(3);
      expect(downloads).toBe(3);
      expect(reported).toHaveLength(3);
      expect(reported[0]).toContain('attempt 1 of 3');
      expect(reported[2]).toContain('giving up after 3 attempts');
      const last = await runAutoUpdate('https://recall.example.com', {}, '0.5.32', deps);
      expect(last.reason).toMatch(/gave up installing 99\.0\.0/);
    } finally {
      globalThis.fetch = realFetch;
      vi.doUnmock('./client-events.js');
    }
  });
});
