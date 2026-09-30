/**
 * The sync redacts a transcript's JSONL before it leaves the machine. Rules
 * that ran over the raw line saw `\"` for a quote and `\n` for a newline, and
 * on one machine a secret went out in clear text from 582 lines in 203
 * sessions. These tests hold the line's decoded text to the same rules.
 */
import { describe, test, expect } from 'vitest';
import { redactJsonLine, redactContainer } from './raw.js';
import { redactSecrets } from '../core/secret-redactor.js';

const red = (t: string) => redactSecrets(t, { force: true });
// SYNTHETIC values, shape-valid only.
const KEY = 'sk-AbCdEfGh1234567890IjKlMnOp';
// Under the contextual pass's 32-char mixed-case bar, so only env-secret finds it.
const ENV_VALUE = 'dbpass0example0value';

describe('redactJsonLine', () => {
  test('THE FAILURE: an env secret in escaped quotes is redacted', () => {
    const line = JSON.stringify({ type: 'user', message: { content: `run it with export API_KEY="${ENV_VALUE}" set` } });
    expect(red(line)).toContain(ENV_VALUE);
    const out = redactJsonLine(line, red);
    expect(out).not.toContain(ENV_VALUE);
    expect(JSON.parse(out).message.content).toBe('run it with export API_KEY="[REDACTED:env-secret]" set');
  });

  test('THE FAILURE: a key at the start of a line inside a string is redacted', () => {
    const line = JSON.stringify({ content: `the key is\n${KEY}\nkeep it safe` });
    expect(red(line)).toContain(KEY);
    const out = redactJsonLine(line, red);
    expect(out).not.toContain(KEY);
    expect(JSON.parse(out).content).toBe('the key is\n[REDACTED:openai-key]\nkeep it safe');
  });

  test('context across strings still redacts', () => {
    const out = redactJsonLine(JSON.stringify({ env: { API_KEY: ENV_VALUE } }), red);
    expect(out).not.toContain(ENV_VALUE);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test('a line with nothing to redact is returned byte for byte', () => {
    const line = String.raw`{"type":"user","message":{"content":"café \/ path\\to\n\"quoted\""},"n":1.0}`;
    expect(redactJsonLine(line, red)).toBe(line);
  });

  test('text that is not JSON is redacted as plain text', () => {
    expect(redactJsonLine(`partial {"a": "${KEY}`, red)).not.toContain(KEY);
  });
});

describe('redactContainer', () => {
  test('JSONL files by line, other files as text', () => {
    const c = redactContainer({ v: 1, tool: 'claude', mtime: 1, files: [
      { name: 'abc.jsonl', text: `${JSON.stringify({ content: `x\n${KEY}` })}\n\n${JSON.stringify({ ok: true })}\n` },
      { name: 'subagents/agent-1.meta.json', text: `{"description":"uses ${KEY}"}` },
    ] }, red);
    expect(c.files[0].text).not.toContain(KEY);
    expect(c.files[0].text.split('\n')).toHaveLength(4);
    for (const l of c.files[0].text.split('\n').filter(Boolean)) expect(() => JSON.parse(l)).not.toThrow();
    expect(c.files[1].text).not.toContain(KEY);
  });
});
