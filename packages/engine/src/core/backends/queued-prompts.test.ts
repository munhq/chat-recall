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
import { useHomeDir } from '../../test-support/home-env.js';

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
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    CHAT_RECALL_CLAUDE_HOME: process.env.CHAT_RECALL_CLAUDE_HOME,
    CLAUDE_DIRS: process.env.CLAUDE_DIRS,
    CHAT_RECALL_DATA_DIR: process.env.CHAT_RECALL_DATA_DIR,
  };
  home = mkdtempSync(join(tmpdir(), 'cr-queued-'));
  useHomeDir(home);
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

/**
 * The dedupe must not eat real repetition.
 *
 * parseSessionFile runs for EVERY tool's transcript (see sync-client.ts: "for
 * other tools the fields it can't read stay at their zero defaults"), so a
 * session-wide dedupe on prompt text would silently delete repeated turns in
 * Gemini, OpenCode, Codex and Antigravity sessions as well as Claude's. People
 * repeat themselves constantly: "continue", "yes", "go on".
 */
describe('repetition is not duplication', () => {
  test('two identical typed prompts are both kept', async () => {
    const file = writeSession([
      userRec('continue where we left off please'),
      userRec('and now the second, different prompt entirely'),
      userRec('continue where we left off please'),
    ]);
    const { parseSessionFile } = await import('../../parsers/session.js');
    const parsed = await parseSessionFile(file);
    expect(parsed.userMessages.map((m) => m.text)).toEqual([
      'continue where we left off please',
      'and now the second, different prompt entirely',
      'continue where we left off please',
    ]);
  });

  test('a queued record that repeats a typed prompt is stored once', async () => {
    const file = writeSession([
      userRec('please run the migration and report back'),
      enqueue('please run the migration and report back'),
    ]);
    const { parseSessionFile } = await import('../../parsers/session.js');
    const parsed = await parseSessionFile(file);
    expect(parsed.userMessages).toHaveLength(1);
  });
});

/**
 * Harness text is stored as `user` records, and a prompt typed while the agent
 * works reaches the transcript as a `queued_command` attachment. In one real
 * session, 6 prompts existed only as that attachment, and recall_show did not
 * have them; about 20 of 45 "user prompts" were harness text.
 */
const record = (text: string, extra: Record<string, unknown>) => JSON.stringify({
  uuid: `r-${text.slice(0, 8)}`, type: 'user', timestamp: '2026-08-21T09:02:00.000Z',
  message: { role: 'user', content: text }, ...extra,
});
const delivered = (prompt: string, origin: Record<string, unknown> = { kind: 'human' }) => JSON.stringify({
  uuid: `a-${prompt.slice(0, 8)}`, type: 'attachment', timestamp: '2026-08-21T09:03:00.000Z',
  attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin, humanTurn: origin.kind === 'human' },
});

describe('harness records and delivered prompts', () => {
  const session = () => writeSession([
    userRec('the opening ask, typed between turns'),
    record('<task-notification>\n<task-id>b1</task-id>\n</task-notification>', { origin: { kind: 'task-notification' } }),
    record('Stop hook feedback:\nanswer these questions', { isMeta: true }),
    record('Another Claude session sent a message:\n<agent-message from="a1">', { isMeta: true, origin: { kind: 'peer' } }),
    enqueue('show me the flow before and after as a diagram'),
    delivered('show me the flow before and after as a diagram'),
    enqueue('let them finish, then implement everything'),
    record('let them finish, then implement everything', { origin: { kind: 'human' } }),
    delivered('<agent-message from="a2">\nreport', { kind: 'peer' }),
  ]);

  test('THE FAILURE: the event stream holds only the person, each prompt once', async () => {
    session();
    const { claudeBackend } = await import('./index.js');
    const users = claudeBackend.readEvents(SID).filter((e) => e.kind === 'user');
    expect(users.map((u) => [u.line, u.text])).toEqual([
      [1, 'the opening ask, typed between turns'],
      [6, 'show me the flow before and after as a diagram'],
      [8, 'let them finish, then implement everything'],
    ]);
  });

  test('a subagent transcript contributes no prompts', async () => {
    const main = session();
    const subDir = join(main.slice(0, -'.jsonl'.length), 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-a1.jsonl'),
      record('Repo: /home/user/code/example. Read-only. Map the code.', { isSidechain: true }) + '\n');
    const { claudeBackend } = await import('./index.js');
    const texts = claudeBackend.readEvents(SID).filter((e) => e.kind === 'user').map((u) => u.text);
    expect(texts).not.toContain('Repo: /home/user/code/example. Read-only. Map the code.');
    expect(texts).toHaveLength(3);
  });

  test('the transcript view shows the delivered prompt and labels harness text', async () => {
    const file = session();
    const { readFileSync } = await import('node:fs');
    const { parseClaudeTranscriptText } = await import('../../transcript/claude.js');
    const users = parseClaudeTranscriptText(readFileSync(file, 'utf8')).filter((m) => m.role === 'user');
    expect(users.map((m) => [m.line, m.origin ?? 'person'])).toEqual([
      [1, 'person'],
      [2, 'task-notification'],
      [3, 'meta'],
      [4, 'peer'],
      [6, 'person'],
      [8, 'person'],
      [9, 'peer'],
    ]);
  });

  test('the search parser records only the person', async () => {
    const file = session();
    const { parseSessionFile } = await import('../../parsers/session.js');
    const parsed = await parseSessionFile(file);
    expect(parsed.userMessages.map((m) => m.text)).toEqual([
      'the opening ask, typed between turns',
      'show me the flow before and after as a diagram',
      'let them finish, then implement everything',
    ]);
  });
});
