/**
 * A prompt typed WHILE A TOOL RUNS is still a prompt.
 *
 * Claude Code does not store it as a `type:'user'` record. It stores it as
 * `{type:'queue-operation', operation:'enqueue', content}` — and a matching
 * `operation:'remove'` when the prompt is dequeued. Both readers here only knew
 * about `type:'user'`, so every such prompt was invisible: never a turn, never a
 * marker, never a chunk, never searchable.
 *
 * Measured on one real session (d22eb6bf, 2026-08-21): 12 of 61 prompts — 20% —
 * were queued, and they were the interruptions and the corrections ("talk to me
 * man…", "what is this ai slop?", "dude I should be able to…"). The calm
 * approvals survived; the course changes did not.
 *
 * These tests pin both readers: the canonical event stream (turns, markers,
 * outcome) and the session parser (the search index).
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SID = '99999999-8888-7777-6666-555555555555';
const PROJ = '-home-user-code-demo';

let home: string;
let prev: Record<string, string | undefined> = {};

const userRec = (text: string) => JSON.stringify({
  uuid: `u-${text.slice(0, 8)}`, type: 'user', timestamp: '2026-08-21T09:00:00.000Z',
  message: { role: 'user', content: text },
});
const enqueue = (content: string) => JSON.stringify({
  type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-21T09:01:00.000Z', content,
});
const dequeue = (content: string) => JSON.stringify({
  type: 'queue-operation', operation: 'remove', timestamp: '2026-08-21T09:01:05.000Z', content,
});

function writeSession(lines: string[]): string {
  const dir = join(home, '.claude', 'projects', PROJ);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${SID}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

beforeEach(() => {
  prev = {
    HOME: process.env.HOME,
    CHAT_RECALL_CLAUDE_HOME: process.env.CHAT_RECALL_CLAUDE_HOME,
    CLAUDE_DIRS: process.env.CLAUDE_DIRS,
    CHAT_RECALL_DATA_DIR: process.env.CHAT_RECALL_DATA_DIR,
  };
  home = mkdtempSync(join(tmpdir(), 'cr-queued-'));
  process.env.HOME = home;
  delete process.env.CHAT_RECALL_CLAUDE_HOME;   // a home override kills sibling discovery
  delete process.env.CLAUDE_DIRS;
  process.env.CHAT_RECALL_DATA_DIR = join(home, '.chat-recall');
});

afterEach(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('queued prompts reach the canonical event stream', () => {
  test('an enqueued prompt becomes a user event, and the dequeue does not double it', async () => {
    writeSession([
      userRec('this one was typed between turns, at leisure'),
      enqueue('dude I should be able to have either a trial or a team directly paid'),
      dequeue('dude I should be able to have either a trial or a team directly paid'),
    ]);
    const { claudeBackend } = await import('./index.js');
    const users = claudeBackend.readEvents(SID).filter((e) => e.kind === 'user');
    expect(users.map((u) => u.text)).toEqual([
      'this one was typed between turns, at leisure',
      'dude I should be able to have either a trial or a team directly paid',
    ]);
  });

  test('a queued task-notification is not a prompt', async () => {
    writeSession([
      userRec('a real prompt that is comfortably long enough'),
      enqueue('<task-notification>\n<task-id>abc</task-id>\n</task-notification>'),
    ]);
    const { claudeBackend } = await import('./index.js');
    const users = claudeBackend.readEvents(SID).filter((e) => e.kind === 'user');
    expect(users).toHaveLength(1);
  });

  test('a system reminder is stripped, not used to discard the prompt', async () => {
    writeSession([
      userRec('please fix the entitlements bug\n<system-reminder>be careful</system-reminder>'),
    ]);
    const { claudeBackend } = await import('./index.js');
    const users = claudeBackend.readEvents(SID).filter((e) => e.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].text).toBe('please fix the entitlements bug');
  });
});

describe('queued prompts reach the search index', () => {
  test('parseSessionFile records them alongside the typed ones, once', async () => {
    const file = writeSession([
      userRec('the first prompt, typed while nothing was running'),
      enqueue('what is this ai slop? the pricing copy reads like a brochure'),
      dequeue('what is this ai slop? the pricing copy reads like a brochure'),
      enqueue('next time be specific about how much effort a tier costs'),
    ]);
    const { parseSessionFile } = await import('../../parsers/session.js');
    const parsed = await parseSessionFile(file);
    const texts = parsed.userMessages.map((m) => m.text);
    expect(texts).toEqual([
      'the first prompt, typed while nothing was running',
      'what is this ai slop? the pricing copy reads like a brochure',
      'next time be specific about how much effort a tier costs',
    ]);
  });

  test('firstPrompt still comes from the earliest record', async () => {
    const file = writeSession([
      userRec('the opening ask, long enough to survive the length floor'),
      enqueue('a later interruption that must not become the first prompt'),
    ]);
    const { parseSessionFile } = await import('../../parsers/session.js');
    const parsed = await parseSessionFile(file);
    expect(parsed.firstPrompt).toBe('the opening ask, long enough to survive the length floor');
  });
});
