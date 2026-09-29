/**
 * recall_show says when this machine's transcript holds messages the server
 * does not. One session was synced to 20:18 while its transcript ran to 07:52
 * the next morning, and the agent read the whole raw file to find the rest.
 */
import { describe, test, expect } from 'vitest';
import { unsyncedLocalMessages, newestTimestamp, type LocalTranscript } from './show-freshness.js';

const at = (iso: string) => ({ timestamp: iso });
const server = [at('2026-09-28T20:10:00Z'), at('2026-09-28T20:18:00Z'), {}];

function local(mtimeIso: string | null, messages: Array<{ timestamp?: string }>): LocalTranscript & { parsed: number } {
  const l = {
    parsed: 0,
    mtime: () => (mtimeIso ? Date.parse(mtimeIso) : null),
    messages: async () => { l.parsed++; return messages; },
  };
  return l;
}

describe('unsyncedLocalMessages', () => {
  test('THE FAILURE: messages newer than the server are counted', async () => {
    const l = local('2026-09-29T07:52:00Z', [...server, at('2026-09-29T07:02:00Z'), at('2026-09-29T07:52:00Z')]);
    expect(await unsyncedLocalMessages(server, l)).toBe(2);
  });

  test('a file not written since the server newest message is not parsed', async () => {
    const l = local('2026-09-28T20:18:00Z', server);
    expect(await unsyncedLocalMessages(server, l)).toBe(0);
    expect(l.parsed).toBe(0);
  });

  test('a file written later with no newer message reports 0', async () => {
    const l = local('2026-09-29T07:00:00Z', server);
    expect(await unsyncedLocalMessages(server, l)).toBe(0);
  });

  test('nothing to compare returns null', async () => {
    expect(await unsyncedLocalMessages(server, local(null, []))).toBeNull();
    expect(await unsyncedLocalMessages([{}], local('2026-09-29T07:00:00Z', []))).toBeNull();
  });

  test('newestTimestamp skips messages without a time', () => {
    expect(newestTimestamp(server)).toBe(Date.parse('2026-09-28T20:18:00Z'));
    expect(newestTimestamp([{}, { timestamp: 'not a date' }])).toBe(0);
  });
});
