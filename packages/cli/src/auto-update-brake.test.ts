/**
 * The brake on a self-update that keeps failing.
 *
 * One machine attempted 0.5.32 -> 0.6.4 four thousand two hundred and forty-eight
 * times over ten days. Nothing applied a brake: the flow is best-effort, so each
 * attempt returned a reason, dropped it, and the next sync tried again. These
 * tests pin the three behaviours that stop that happening again.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
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
