/**
 * How a session says it wants channel delivery.
 *
 * The MCP server is the child of `claude`, so the flag the user typed is two
 * processes up and only visible through the argument list. These are the shapes
 * that appear in practice, including the one that bit us: the flag's value list
 * keeps going until the next argument that starts with `-`, so the prompt after
 * it is read as a channel name too.
 */
import { describe, test, expect } from 'vitest';
import { ancestorCommandLines, channelDecision, listsOurServer } from './channel-detect.js';

describe('listsOurServer', () => {
  test('reads the plain flag', () => {
    expect(listsOurServer(['claude', '--channels', 'server:chat-recall'])).toBe(true);
  });

  test('reads the development flag, which is the one that works today', () => {
    expect(listsOurServer(['claude', '--dangerously-load-development-channels', 'server:chat-recall'])).toBe(true);
  });

  test('accepts the bare name as well as the tagged one', () => {
    expect(listsOurServer(['claude', '--channels', 'chat-recall'])).toBe(true);
  });

  test('ignores another server', () => {
    expect(listsOurServer(['claude', '--dangerously-load-development-channels', 'server:other'])).toBe(false);
  });

  test('reads the whole list, not just its first entry', () => {
    expect(listsOurServer(['claude', '--channels', 'server:other', 'server:chat-recall'])).toBe(true);
    expect(listsOurServer(['claude', '--channels', 'plugin:x@y', 'server:chat-recall'])).toBe(true);
  });

  test('stops the list at the next flag', () => {
    expect(listsOurServer(['claude', '--channels', 'server:other', '--model', 'chat-recall'])).toBe(false);
  });

  test('a prompt that follows the flag is not a server name', () => {
    // The real command line: the prompt came right after the flag's list.
    expect(listsOurServer(['claude', '--dangerously-load-development-channels', 'server:other', 'Say one word.'])).toBe(false);
  });

  test('no flags at all', () => {
    expect(listsOurServer(['claude', 'chat-recall is a good server'])).toBe(false);
  });
});

describe('channelDecision', () => {
  const none = () => [] as string[][];

  test('off by default', () => {
    expect(channelDecision({}, ['claude'], none)).toEqual({ enabled: false, reason: 'no channel flag' });
  });

  test('the flag above us turns it on', () => {
    const r = channelDecision({}, ['claude'], () => [['claude', '--channels', 'server:chat-recall']]);
    expect(r.enabled).toBe(true);
    expect(r.reason).toBe('a --channels flag above us');
  });

  test('0 turns it off even with the flag present', () => {
    const r = channelDecision({ CHAT_RECALL_CHANNEL: '0' }, ['claude', '--channels', 'server:chat-recall'], none);
    expect(r).toEqual({ enabled: false, reason: 'CHAT_RECALL_CHANNEL=0' });
  });

  test('1 turns it on with no flag, which is how a test or a wrapper drives it', () => {
    expect(channelDecision({ CHAT_RECALL_CHANNEL: '1' }, ['claude'], none)).toEqual({ enabled: true, reason: 'CHAT_RECALL_CHANNEL=1' });
  });

  test('a value that is neither 0 nor 1 is not guessed at', () => {
    expect(channelDecision({ CHAT_RECALL_CHANNEL: 'yes' }, ['claude', '--channels', 'server:chat-recall'], none).enabled).toBe(false);
  });

  test('an empty value is the same as unset', () => {
    const r = channelDecision({ CHAT_RECALL_CHANNEL: '' }, ['claude', '--channels', 'server:chat-recall'], none);
    expect(r.enabled).toBe(true);
  });
});

describe('ancestorCommandLines', () => {
  test('returns the processes it was given, unreadable ones dropped', () => {
    // A pid above the kernel's maximum cannot exist, so nothing is read for it.
    expect(ancestorCommandLines([4_194_303])).toEqual([]);
  });

  // Windows has neither /proc nor ps: a process cannot be read there.
  test.skipIf(process.platform === 'win32')('reads a process that does exist', () => {
    expect(ancestorCommandLines([process.pid]).length).toBe(1);
  });
});
