/**
 * The stamp of the last FULL walk (issue #22). A walk of the changed sessions
 * stamps the last success but not the last full walk, so the daily full walk
 * comes due even while the daemon syncs all day. A request for a full walk
 * stays until a full walk succeeds.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir = '';
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.CHAT_RECALL_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'walk-state-'));
  process.env.CHAT_RECALL_DATA_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const SERVER = 'https://example.test';
const write = (state: Record<string, number>) => writeFileSync(join(dir, 'walk-state.json'), JSON.stringify(state));

describe('lastFullWalkAt', () => {
  test('is 0 when no full walk was recorded, whatever the last success says', async () => {
    const { lastFullWalkAt, lastSuccessfulWalkAt } = await import('./sync-client.js');
    write({ [SERVER]: 5_000 });
    expect(lastSuccessfulWalkAt()).toBe(5_000);
    expect(lastFullWalkAt()).toBe(0);
  });

  test('reads the stamp of the full walk', async () => {
    const { lastFullWalkAt } = await import('./sync-client.js');
    write({ [SERVER]: 9_000, [`${SERVER}#full`]: 4_000 });
    expect(lastFullWalkAt(SERVER)).toBe(4_000);
    expect(lastFullWalkAt()).toBe(4_000);
  });

  test('the last success ignores the full-walk keys', async () => {
    const { lastSuccessfulWalkAt } = await import('./sync-client.js');
    write({ [SERVER]: 3_000, [`${SERVER}#full`]: 8_000 });
    expect(lastSuccessfulWalkAt()).toBe(3_000);
  });

  test('with two targets the oldest full walk counts', async () => {
    const { lastFullWalkAt } = await import('./sync-client.js');
    write({ [SERVER]: 9_000, 'https://other.test': 9_000, [`${SERVER}#full`]: 7_000 });
    expect(lastFullWalkAt()).toBe(0);
  });
});

describe('requestFullWalk', () => {
  test('makes the next walk a full one and leaves the last success alone', async () => {
    const { requestFullWalk, lastFullWalkAt, lastSuccessfulWalkAt } = await import('./sync-client.js');
    write({ [SERVER]: 9_000, [`${SERVER}#full`]: 8_000 });
    requestFullWalk(SERVER);
    expect(lastFullWalkAt(SERVER)).toBe(0);
    expect(lastSuccessfulWalkAt(SERVER)).toBe(9_000);
    expect(JSON.parse(readFileSync(join(dir, 'walk-state.json'), 'utf8'))[`${SERVER}#full`]).toBe(0);
  });
});

describe('noteWalkSuccess', () => {
  test('a walk of the changed sessions writes the last success and not the full walk', async () => {
    const { noteWalkSuccess } = await import('./sync-client.js');
    noteWalkSuccess(SERVER, false);
    const state = JSON.parse(readFileSync(join(dir, 'walk-state.json'), 'utf8'));
    expect(state[SERVER]).toBeGreaterThan(0);
    expect(state[`${SERVER}#full`]).toBeUndefined();
  });

  test('a complete full walk writes both', async () => {
    const { noteWalkSuccess, lastFullWalkAt } = await import('./sync-client.js');
    noteWalkSuccess(SERVER, true);
    const state = JSON.parse(readFileSync(join(dir, 'walk-state.json'), 'utf8'));
    expect(state[`${SERVER}#full`]).toBeGreaterThan(0);
    expect(lastFullWalkAt(SERVER)).toBe(state[`${SERVER}#full`]);
  });
});
