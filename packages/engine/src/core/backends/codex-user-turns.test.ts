/**
 * Codex prompts live in TWO shapes, and only one was read.
 *
 * readEvents() took user text exclusively from `event_msg` + `user_message`.
 * Current rollouts do not write that record — they write
 * `response_item` + `payload.type='message'` + `role='user'`, with the text in
 * `content[].input_text`. That branch existed but matched role='assistant' only,
 * so EVERY Codex session extracted zero user turns: no prompts, no markers, no
 * first prompt, nothing for recall_user_prompts.
 *
 * Measured before the fix on six real rollouts: 0 user events out of 36, 11, 2,
 * 11, 2 and 5. After: 7, 3, 1, 4, 1, 2.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SID = '01a01fc6-3581-7283-bf57-a591cf30e310';
let home: string;
let prev: Record<string, string | undefined> = {};

/** The record shape a current rollout actually writes. */
const userItem = (text: string, ordinal: number) => JSON.stringify({
  timestamp: '2026-08-20T15:25:43.429Z', ordinal, type: 'response_item',
  payload: { type: 'message', id: `msg_${ordinal}`, role: 'user', content: [{ type: 'input_text', text }] },
});
const assistantItem = (text: string) => JSON.stringify({
  timestamp: '2026-08-20T15:26:00.000Z', type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});
/** The legacy shape, which must keep working. */
const legacyUser = (message: string) => JSON.stringify({
  timestamp: '2026-08-20T15:25:00.000Z', type: 'event_msg', payload: { type: 'user_message', message },
});

beforeEach(() => {
  prev = { HOME: process.env.HOME, CHAT_RECALL_CODEX_HOME: process.env.CHAT_RECALL_CODEX_HOME };
  home = mkdtempSync(join(tmpdir(), 'cr-codex-'));
  process.env.HOME = home;
  process.env.CHAT_RECALL_CODEX_HOME = join(home, '.codex');
  const dir = join(home, '.codex', 'sessions', '2026', '08', '20');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-08-20T18-24-38-${SID}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: SID, cwd: '/home/u/proj' } }),
    userItem('please read everything and tell me what is broken', 8),
    assistantItem('Reading now.'),
    userItem('now fix the second one too', 12),
    legacyUser('and this legacy-shaped prompt still counts'),
  ].join('\n') + '\n');
});

afterEach(() => {
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
});

describe('codex user turns', () => {
  test('prompts in response_item/message become user events', async () => {
    const { codexBackend } = await import('./index.js');
    const users = codexBackend.readEvents(SID).filter((e) => e.kind === 'user');
    expect(users.map((u) => u.text)).toEqual([
      'please read everything and tell me what is broken',
      'now fix the second one too',
      'and this legacy-shaped prompt still counts',
    ]);
  });

  test('assistant messages are still assistant, not user', async () => {
    const { codexBackend } = await import('./index.js');
    const ev = codexBackend.readEvents(SID);
    expect(ev.filter((e) => e.kind === 'assistant_text').map((e) => e.text)).toEqual(['Reading now.']);
  });
});
