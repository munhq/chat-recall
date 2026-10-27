/**
 * Regression: a Pi append must ship the new turns.
 *
 * Pi advertises `isAppendOnly()`, so a grown session takes the tail path. The
 * tail parser knew Claude and Codex only. A Pi tail parsed to nothing: the
 * sync sent an empty envelope and the server moved `from_offset` to the file
 * size. Every later turn of that session stayed on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildConversationTail } from './sync-client.js';
import { bootstrapBackends, PiBackend } from '@chat-recall/engine/core/backends/index.js';
import type { SessionRef } from '@chat-recall/engine/core/tool-backend.js';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const CWD = '/home/user/code/example-app';

let home: string;
let saved: string | undefined;
let savedSessions: string | undefined;
let sessionPath: string;

function userLine(text: string, ts = '2026-05-06T06:00:01.000Z'): string {
  return JSON.stringify({
    type: 'message', id: `u-${text}`, parentId: null, timestamp: ts,
    message: { role: 'user', content: text, timestamp: Date.parse(ts) },
  });
}

function assistantLine(text: string, ts = '2026-05-06T06:00:02.000Z'): string {
  return JSON.stringify({
    type: 'message', id: `a-${text}`, parentId: null, timestamp: ts,
    message: {
      role: 'assistant', content: [{ type: 'text', text }],
      api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.parse(ts),
    },
  });
}

function ref(): SessionRef {
  // The key carries the project hash, so read it from the listing.
  const found = new PiBackend().listSessions({ previews: false })[0];
  if (!found) throw new Error('fixture session not listed');
  return found;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pi-tail-'));
  saved = process.env.CHAT_RECALL_PI_HOME;
  savedSessions = process.env.CHAT_RECALL_PI_SESSION_DIR;
  process.env.CHAT_RECALL_PI_HOME = home;
  delete process.env.CHAT_RECALL_PI_SESSION_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  const dir = join(home, 'sessions', '--home-user-code-example-app--');
  mkdirSync(dir, { recursive: true });
  sessionPath = join(dir, `2026-05-06T06-00-00-000Z_${SESSION_ID}.jsonl`);
  writeFileSync(sessionPath, [
    JSON.stringify({ type: 'session', version: 3, id: SESSION_ID, timestamp: '2026-05-06T06:00:00.000Z', cwd: CWD }),
    userLine('first prompt'),
    assistantLine('first answer'),
  ].join('\n') + '\n');
  bootstrapBackends();
});

afterEach(() => {
  if (saved === undefined) delete process.env.CHAT_RECALL_PI_HOME;
  else process.env.CHAT_RECALL_PI_HOME = saved;
  if (savedSessions === undefined) delete process.env.CHAT_RECALL_PI_SESSION_DIR;
  else process.env.CHAT_RECALL_PI_SESSION_DIR = savedSessions;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  rmSync(home, { recursive: true, force: true });
});

describe('Pi append tail', () => {
  it('ships the turns after the head, not an empty envelope', async () => {
    const head = await buildConversationTail(ref(), 0);
    expect(head).not.toBeNull();
    expect(head!.conv.envelope).toBeTruthy();
    expect((head!.conv.envelope as any).messages).toHaveLength(2);

    // Two more turns land while the session is open.
    appendFileSync(sessionPath,
      userLine('second prompt', '2026-05-06T06:00:03.000Z') + '\n' +
      assistantLine('second answer', '2026-05-06T06:00:04.000Z') + '\n');

    const tail = await buildConversationTail(ref(), head!.newOffset);
    expect(tail).not.toBeNull();
    const messages = (tail!.conv.envelope as any).messages as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.content)).toEqual(['second prompt', 'second answer']);
    expect(messages[0].role).toBe('user');
    // The cursor advances to the end of the file, so nothing is re-read.
    expect(tail!.newOffset).toBeGreaterThan(head!.newOffset);
  });

  it('returns null when there is nothing new', async () => {
    const head = await buildConversationTail(ref(), 0);
    expect(await buildConversationTail(ref(), head!.newOffset)).toBeNull();
  });
});
