/**
 * The Codex parser reads a rollout one line at a time and cuts a tool input or
 * a reasoning summary as its line is read. The cut messages must be the ones
 * trimTranscriptForSync gives for the parse of the whole text.
 */
import { describe, test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseCodexTranscript, parseCodexTranscriptText } from './codex.js';
import { trimTranscriptForSync, SYNC_PAYLOAD_CAP } from './index.js';

const wire = (v: unknown) => JSON.parse(JSON.stringify(v));

function rollout(): string {
  const rec = (o: unknown) => JSON.stringify(o);
  return [
    rec({ type: 'session_meta', payload: { id: 'x' } }),
    rec({ type: 'event_msg', timestamp: 't1', payload: { type: 'user_message', message: 'fix the parser' } }),
    rec({ type: 'event_msg', timestamp: 't1', payload: { type: 'user_message', message: '<environment_context>x</environment_context>' } }),
    rec({ type: 'response_item', timestamp: 't2', payload: { type: 'reasoning', summary: [{ text: 'r'.repeat(6000) }] } }),
    rec({ type: 'response_item', timestamp: 't3', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['echo', 'c'.repeat(9000)] }) } }),
    rec({ type: 'response_item', timestamp: 't4', payload: { type: 'function_call', name: 'raw', arguments: 'not json '.repeat(900) } }),
    rec({ type: 'response_item', timestamp: 't5', payload: { type: 'message', role: 'assistant', content: [{ text: 'done' }] } }),
    'not json',
    '',
  ].join('\n');
}

describe('the Codex parser', () => {
  const text = rollout();

  test('a file read line by line gives the messages of the same text read whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-stream-'));
    try {
      const file = join(dir, 'rollout.jsonl');
      writeFileSync(file, text);
      expect(wire(await parseCodexTranscript(file))).toEqual(wire(parseCodexTranscriptText(text)));
      expect(wire(await parseCodexTranscript(file, { payloadCap: SYNC_PAYLOAD_CAP }))).toEqual(wire(parseCodexTranscriptText(text, { payloadCap: SYNC_PAYLOAD_CAP })));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('with a cap gives what trimTranscriptForSync gives for the whole parse', () => {
    const expected = trimTranscriptForSync({ messages: parseCodexTranscriptText(text), subagents: [] }).messages;
    expect(wire(parseCodexTranscriptText(text, { payloadCap: SYNC_PAYLOAD_CAP }))).toEqual(wire(expected));
  });

  test('keeps the line numbers, the user prompt and the final answer', () => {
    const got = parseCodexTranscriptText(text, { payloadCap: SYNC_PAYLOAD_CAP });
    expect(got.map((m) => m.line)).toEqual([2, 4, 5, 6, 7]);
    expect(got[0]).toMatchObject({ role: 'user', content: 'fix the parser' });
    expect(got.at(-1)).toMatchObject({ role: 'assistant', content: 'done' });
  });
});
