/**
 * The "you are running an old CLI" line, and who can actually see it.
 *
 * Auto-update lives in the watch daemon, and `init` deliberately stopped
 * installing that daemon ("a second, unlocked writer raced the sync ledger").
 * So a normal user runs the MCP server and nothing else: never self-updates,
 * and — until this — never saw a word about it either, because the notice had
 * exactly one channel, a stderr line on CLI invocations they do not make.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.CHAT_RECALL_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'cr-update-'));
  process.env.CHAT_RECALL_DATA_DIR = dir;
  vi.resetModules();
});
afterEach(() => {
  if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const writeProbe = (serverVersion: string) =>
  writeFileSync(join(dir, 'update-check.json'), JSON.stringify({ serverVersion, checkedAt: Date.now() }));

describe('updateNotice', () => {
  test('names both versions and how to fix it when the server is ahead', async () => {
    writeProbe('99.0.0');
    const { updateNotice } = await import('./update-notice.js');
    const msg = updateNotice();
    expect(msg).toContain('99.0.0');
    expect(msg).toContain('chat-recall update');
  });

  test('silent when the server is not ahead', async () => {
    writeProbe('0.0.1');
    const { updateNotice } = await import('./update-notice.js');
    expect(updateNotice()).toBeNull();
  });

  test('silent when no probe has ever been written', async () => {
    const { updateNotice } = await import('./update-notice.js');
    expect(updateNotice()).toBeNull();
  });

  test('an unreadable probe is silence, never a crash', async () => {
    writeFileSync(join(dir, 'update-check.json'), '{ this is not json');
    const { updateNotice } = await import('./update-notice.js');
    expect(() => updateNotice()).not.toThrow();
    expect(updateNotice()).toBeNull();
  });
});
