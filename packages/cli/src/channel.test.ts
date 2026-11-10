/**
 * The delivery loop.
 *
 * The rule that matters most is the acknowledgement: a message is acknowledged
 * only after the client has it. The channel is the one path with no exit code
 * to prove delivery, so the only evidence is that `notification` returned — and
 * if it throws, the lease must be left to expire so the waiter or the next turn
 * offers the message again.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { runChannel, type Target } from './channel.js';
import {
  channelOwnsSession, channelStateDir, clearChannelAlive, markChannelAlive,
  pruneSessionPids, recordSessionForPids, sessionIdFromPids,
} from './channel-state.js';

const target: Target = { base: 'https://example.test', token: 't' };

function message(id: string, body = 'hello') {
  return { id, fromSession: 'other', toSession: 'mine', body, replyTo: null, createdAt: Date.now(), deliveredAt: null };
}

/** A server stand-in that records what was emitted. */
function fakeServer(fail = false) {
  const sent: Array<{ method: string; params: { content: string; meta: Record<string, string> } }> = [];
  const capabilities: unknown[] = [];
  const server = {
    registerCapabilities: (c: unknown) => { capabilities.push(c); },
    notification: async (n: never) => {
      if (fail) throw new Error('the pipe is gone');
      sent.push(n);
    },
  } as unknown as Server;
  return { server, sent, capabilities };
}

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.CHAT_RECALL_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'cr-channel-'));
  process.env.CHAT_RECALL_DATA_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('runChannel', () => {
  test('emits one notification per batch and acknowledges it', async () => {
    const { server, sent } = fakeServer();
    const calls: Array<{ path: string; body: never }> = [];
    let n = 0;
    await runChannel({
      server, target, sessionId: () => 'mine',
      sleep: async () => {},
      post: async (_t, path, body) => {
        calls.push({ path, body: body as never });
        n += 1;
        if (n === 1) return { status: 200, body: { messages: [message('m1'), message('m2')], labels: { other: 'backend' } } };
        if (n === 2) return { status: 200, body: { acked: 2 } };
        return { status: 200, body: { ended: true } };
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('notifications/claude/channel');
    expect(sent[0].params.content).toContain('m1');
    expect(sent[0].params.content).toContain('backend');
    expect(sent[0].params.meta).toEqual({ from: 'chat-recall', session: 'mine' });
    expect(calls.map((c) => c.path)).toEqual([
      '/api/live-sessions/wait', '/api/live-sessions/ack', '/api/live-sessions/wait',
    ]);
    expect((calls[1].body as { ids: string[] }).ids).toEqual(['m1', 'm2']);
  });

  test('does not acknowledge a batch the client never got', async () => {
    const { server } = fakeServer(true);
    const paths: string[] = [];
    await runChannel({
      server, target, sessionId: () => 'mine',
      sleep: async () => {},
      post: async (_t, path) => {
        paths.push(path);
        return { status: 200, body: { messages: [message('m1')] } };
      },
    });
    expect(paths).toEqual(['/api/live-sessions/wait']);
  });

  test('waits for the hook to record the session id, then delivers', async () => {
    recordSessionForPids('mine', [currentPid()]);
    const { server, sent } = fakeServer();
    let asked = 0;
    let n = 0;
    await runChannel({
      server, target,
      sessionId: () => { asked += 1; return asked > 3 ? sessionIdFromPids([currentPid()]) : null; },
      sleep: async () => {},
      post: async () => {
        n += 1;
        return n === 1 ? { status: 200, body: { messages: [message('m1')] } } : { status: 200, body: { ended: true } };
      },
    });
    expect(sent).toHaveLength(1);
    expect(asked).toBeGreaterThan(3);
  });

  test('gives up when the server does not know the session', async () => {
    const { server, sent } = fakeServer();
    let calls = 0;
    await runChannel({
      server, target, sessionId: () => 'mine',
      sleep: async () => {},
      post: async () => { calls += 1; return { status: 404, body: null }; },
    });
    expect(calls).toBe(5);
    expect(sent).toHaveLength(0);
  });

  test('stops on an authorization failure instead of retrying', async () => {
    const { server } = fakeServer();
    let calls = 0;
    await runChannel({
      server, target, sessionId: () => 'mine',
      sleep: async () => {},
      post: async () => { calls += 1; return { status: 401, body: null }; },
    });
    expect(calls).toBe(1);
  });

  test('stops when the session ended', async () => {
    const { server } = fakeServer();
    let calls = 0;
    await runChannel({
      server, target, sessionId: () => 'mine',
      sleep: async () => {},
      post: async () => { calls += 1; return { status: 200, body: { ended: true } }; },
    });
    expect(calls).toBe(1);
  });
});

describe('the channel marker', () => {
  test('is gone once the loop stops', async () => {
    const { server } = fakeServer();
    await runChannel({
      server, target, sessionId: () => 'mine',
      sleep: async () => {},
      post: async () => ({ status: 200, body: { ended: true } }),
    });
    expect(channelOwnsSession('mine')).toBe(false);
  });

  test('a marker from a process that is gone is not trusted', () => {
    mkdirSync(channelStateDir(), { recursive: true });
    writeFileSync(join(channelStateDir(), 'mine.channel'), '999999999');
    expect(channelOwnsSession('mine')).toBe(false);
  });

  test('a stale marker is not trusted even when its process lives', () => {
    mkdirSync(channelStateDir(), { recursive: true });
    const path = join(channelStateDir(), 'mine.channel');
    writeFileSync(path, String(currentPid()));
    expect(channelOwnsSession('mine', Date.now() + 10 * 60_000)).toBe(false);
  });

  test('a fresh marker of a live process is trusted', () => {
    mkdirSync(channelStateDir(), { recursive: true });
    writeFileSync(join(channelStateDir(), 'mine.channel'), String(currentPid()));
    expect(channelOwnsSession('mine')).toBe(true);
  });

  test('a marker whose pid was reused is not trusted', () => {
    // Our pid, and a start time that is not ours: the kernel gave the number to
    // this process after the channel that wrote the marker died.
    mkdirSync(channelStateDir(), { recursive: true });
    writeFileSync(join(channelStateDir(), 'mine.channel'), `${currentPid()} 1`);
    expect(channelOwnsSession('mine')).toBe(false);
  });

  test('a marker written by this process in this life is trusted', () => {
    markChannelAlive('mine');
    expect(channelOwnsSession('mine')).toBe(true);
  });

  test('clearing removes our own claim', () => {
    markChannelAlive('mine');
    expect(channelOwnsSession('mine')).toBe(true);
    clearChannelAlive('mine');
    expect(channelOwnsSession('mine')).toBe(false);
  });

  test('clearing leaves a newer channel of the same session alone', () => {
    mkdirSync(channelStateDir(), { recursive: true });
    writeFileSync(join(channelStateDir(), 'mine.channel'), '424242');
    clearChannelAlive('mine');
    expect(readFileSync(join(channelStateDir(), 'mine.channel'), 'utf-8')).toBe('424242');
  });
});

describe('the session id the hook records', () => {
  // Windows has neither /proc nor ps: the record carries no start time there.
  test.skipIf(process.platform === 'win32')('is keyed by a pid both processes share', () => {
    recordSessionForPids('abc', [currentPid()]);
    expect(sessionIdFromPids([currentPid()])).toBe('abc');
    expect(readFileSync(join(channelStateDir(), 'by-pid', String(currentPid())), 'utf-8')).toMatch(/^abc \d+$/);
  });

  test('a record from a process that had the same pid is not taken', () => {
    // What a recycled pid looks like: the id, and a start time that is not this
    // process's.
    mkdirSync(join(channelStateDir(), 'by-pid'), { recursive: true });
    writeFileSync(join(channelStateDir(), 'by-pid', String(currentPid())), 'abc 1');
    expect(sessionIdFromPids([currentPid()])).toBeNull();
  });

  test('a record without a start time is taken as it is', () => {
    // Written by an older build, or on a platform with no /proc.
    mkdirSync(join(channelStateDir(), 'by-pid'), { recursive: true });
    writeFileSync(join(channelStateDir(), 'by-pid', String(currentPid())), 'abc');
    expect(sessionIdFromPids([currentPid()])).toBe('abc');
  });

  test('the records of dead processes are pruned, live ones stay', () => {
    recordSessionForPids('abc', [currentPid()]);
    recordSessionForPids('gone', [4_194_303]);
    pruneSessionPids();
    expect(sessionIdFromPids([currentPid()])).toBe('abc');
    expect(() => statSync(join(channelStateDir(), 'by-pid', '4194303'))).toThrow();
  });

  test('a second pid is used when the first has no record', () => {
    recordSessionForPids('abc', [424242]);
    expect(sessionIdFromPids([currentPid(), 424242])).toBe('abc');
  });

  test('nothing recorded is null', () => {
    expect(sessionIdFromPids([currentPid()])).toBeNull();
  });

  test('pid 1 and nonsense are never written', () => {
    recordSessionForPids('abc', [0, 1, -5, 1.5]);
    expect(sessionIdFromPids([0, 1, -5, 1.5])).toBeNull();
  });
});

function currentPid(): number {
  return process.pid;
}
