/**
 * loadSettings is called about 314,000 times in one sync walk.
 *
 * Every claudeProjectDirs() -> applyDecisions() -> homeDecision() chain reads
 * it, and that chain runs several times per session across 15,700 sessions.
 * Uncached, each call was two file reads and two JSON/line parses for a file
 * that only changes when a human edits it.
 *
 * Caching config is easy to get wrong in two specific ways, and both are
 * pinned here: serving a stale file after an edit, and letting one caller's
 * mutation of the returned object leak into every later read.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let saved: string | undefined;

async function mod() {
  const m = await import('./settings.js');
  m._resetSettingsCacheForTests();
  m._resetSecretsCacheForTests();
  return m;
}

const write = (endpoint: string) => {
  mkdirSync(join(dir, 'settings'), { recursive: true });
  writeFileSync(join(dir, 'settings', 'settings.json'),
    JSON.stringify({ v: 3, sync: { enabled: true, endpoint } }));
};

beforeEach(() => {
  saved = process.env.CHAT_RECALL_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'cr-settings-cache-'));
  process.env.CHAT_RECALL_DATA_DIR = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe('settings cache', () => {
  test('reads the file', async () => {
    write('https://a.test');
    const { loadSettings } = await mod();
    expect(loadSettings().sync.endpoint).toBe('https://a.test');
  });

  test('an edit is picked up — a stale config is worse than a slow one', async () => {
    write('https://a.test');
    const { loadSettings } = await mod();
    expect(loadSettings().sync.endpoint).toBe('https://a.test');

    // Same path, different content and length. Even inside one millisecond the
    // size differs, which is why the key is mtime AND size.
    write('https://b.test/much/longer/endpoint');
    expect(loadSettings().sync.endpoint).toBe('https://b.test/much/longer/endpoint');
  });

  test('a caller mutating the result cannot poison the next read', async () => {
    write('https://a.test');
    const { loadSettings } = await mod();
    const first = loadSettings();
    first.sync.endpoint = 'https://tampered.test';
    (first.sync.excludeProjects as string[]).push('/secret');

    const second = loadSettings();
    expect(second.sync.endpoint).toBe('https://a.test');
    expect(second.sync.excludeProjects).not.toContain('/secret');
  });

  test('each call returns a distinct object, not the cached instance', async () => {
    write('https://a.test');
    const { loadSettings } = await mod();
    expect(loadSettings()).not.toBe(loadSettings());
  });

  test('a missing file still yields defaults', async () => {
    const { loadSettings } = await mod();
    expect(loadSettings().v).toBeGreaterThan(0);
  });

  test('secrets come from the live environment, never from the cache', async () => {
    // A cached credential is the one thing that must not go stale: rotating a
    // key in the environment has to take effect on the next read.
    write('https://a.test');
    const { loadSettings } = await mod();
    loadSettings();
    process.env.GEMINI_API_KEY = 'rotated-key-value';
    try {
      expect(loadSettings().embedding.geminiApiKey).toBe('rotated-key-value');
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });
});
