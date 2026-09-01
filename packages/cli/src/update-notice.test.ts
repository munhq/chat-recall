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

const writeProbe = (serverVersion: string, npmVersion?: string) =>
  writeFileSync(join(dir, 'update-check.json'), JSON.stringify(
    npmVersion === undefined
      ? { serverVersion, checkedAt: Date.now() }
      : { serverVersion, npmVersion, checkedAt: Date.now() }));

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

/**
 * The server cannot be the only source of "what is the newest CLI".
 *
 * `/api/capabilities` reports `cli.version` from `/app/install/cli-version.txt`
 * — a file stamped into the server's Docker image and cached for the life of
 * the process. It is therefore whatever was current when that IMAGE was built.
 * On release day 0.5.32 was live on npm while the deployed image still said
 * 0.5.31, so every CLI was told "0.5.31 is available", and `chat-recall update`
 * — same-origin and checksum-pinned against that server's tarball — could only
 * ever hand back 0.5.31. The notice was wrong and the remedy it named was a
 * circle.
 */
describe('npm as a second version source', () => {
  // Versions must sit ABOVE this package's own version or there is nothing to
  // report — the shape being tested is "npm ahead of server", not the literal
  // 0.5.31/0.5.32 pair, which the running test binary has already caught up to.
  const SERVER_LAGS = '98.0.0';
  const NPM_AHEAD = '99.0.0';

  test('reports the npm release when the server image lags behind it', async () => {
    writeProbe(SERVER_LAGS, NPM_AHEAD);   // the release-day state
    const { updateNotice } = await import('./update-notice.js');
    const msg = updateNotice();
    expect(msg).toContain(NPM_AHEAD);
    expect(msg).not.toContain(SERVER_LAGS);
  });

  test('and names npm, not `chat-recall update`, which cannot deliver it', async () => {
    // Pointing at the same-origin updater here sends the user in a circle: the
    // server does not have the bytes yet.
    writeProbe(SERVER_LAGS, NPM_AHEAD);
    const { updateNotice } = await import('./update-notice.js');
    const msg = updateNotice();
    expect(msg).toContain('npm install -g chat-recall@latest');
    expect(msg).toContain('has not rolled it yet');
  });

  test('a server AHEAD of npm still wins, and still names the same-origin path', async () => {
    // Self-hosted: the deployment serves its own build. That tarball is
    // checksum-pinned and compat-matched, so it remains the right answer.
    writeProbe('99.0.0', '98.0.0');
    const { updateNotice } = await import('./update-notice.js');
    const msg = updateNotice();
    expect(msg).toContain('99.0.0');
    expect(msg).toContain('chat-recall update');
    expect(msg).not.toContain('npm install');
  });

  test('a cache with no npmVersion behaves exactly as before', async () => {
    // Written by an older CLI, or by any air-gapped box where the registry is
    // unreachable. Adding a source must not change the offline answer.
    writeProbe('99.0.0');
    const { updateNotice } = await import('./update-notice.js');
    const msg = updateNotice();
    expect(msg).toContain('99.0.0');
    expect(msg).toContain('chat-recall update');
  });

  test('silent when neither source is ahead of what is installed', async () => {
    writeProbe('0.0.1', '0.0.2');
    const { updateNotice } = await import('./update-notice.js');
    expect(updateNotice()).toBeNull();
  });

  test('newestKnown picks the higher source and says which one it was', async () => {
    const { newestKnown } = await import('./update-notice.js');
    expect(newestKnown({ serverVersion: '0.5.31', npmVersion: '0.5.32', checkedAt: 0 }))
      .toEqual({ version: '0.5.32', source: 'npm' });
    expect(newestKnown({ serverVersion: '0.6.0', npmVersion: '0.5.32', checkedAt: 0 }))
      .toEqual({ version: '0.6.0', source: 'server' });
    // Equal versions are not a reason to send someone to npm.
    expect(newestKnown({ serverVersion: '0.5.32', npmVersion: '0.5.32', checkedAt: 0 }).source)
      .toBe('server');
    expect(newestKnown({ serverVersion: '0.5.31', checkedAt: 0 }))
      .toEqual({ version: '0.5.31', source: 'server' });
  });
});
