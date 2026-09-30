/**
 * Archive lines that the redactor made unparseable before 0.7.12. Every reader
 * skips a line that does not parse, so the record was gone from the view, the
 * search index and the prompt list. On one machine 211 lines in 75 sessions
 * were broken, 44 of them prompts.
 */
import { describe, test, expect } from 'vitest';
import { repairRedactedJsonl, repairContainer } from './raw.js';

// What the old redactor made of `curl -H "Authorization: Bearer <token>" <url>`.
const quoteBroken = String.raw`{"type":"user","message":{"content":"curl -H \"Authorization: Bearer [REDACTED:auth-header]" https://example.com/v1"}}`;
const quoteFixed = String.raw`{"type":"user","message":{"content":"curl -H \"Authorization: Bearer [REDACTED:auth-header]\" https://example.com/v1"}}`;

describe('repairRedactedJsonl', () => {
  test('THE FAILURE: the backslash a marker took from an escaped quote is put back', () => {
    expect(() => JSON.parse(quoteBroken)).toThrow();
    const r = repairRedactedJsonl(quoteBroken);
    expect(r.repaired).toBe(1);
    expect(r.text).toBe(quoteFixed);
    expect(JSON.parse(r.text).message.content).toBe('curl -H "Authorization: Bearer [REDACTED:auth-header]" https://example.com/v1');
  });

  test('a marker quote that really ends a string is left alone', () => {
    const line = String.raw`{"a":"Bearer [REDACTED:auth-header]","b":"x -H \"Authorization: Bearer [REDACTED:auth-header]" y","c":"[REDACTED:openai-key]"}`;
    const r = repairRedactedJsonl(line);
    expect(r.repaired).toBe(1);
    expect(JSON.parse(r.text)).toEqual({
      a: 'Bearer [REDACTED:auth-header]',
      b: 'x -H "Authorization: Bearer [REDACTED:auth-header]" y',
      c: '[REDACTED:openai-key]',
    });
  });

  test('a backslash left in front of a marker is removed', () => {
    const line = String.raw`{"content":"my api token is\[REDACTED:secret-context] and more"}`;
    const r = repairRedactedJsonl(line);
    expect(r.repaired).toBe(1);
    expect(JSON.parse(r.text).content).toBe('my api token is[REDACTED:secret-context] and more');
  });

  test('an escaped backslash in front of a marker is not damage', () => {
    const line = String.raw`{"content":"C:\\[REDACTED:secret-context]"}`;
    expect(repairRedactedJsonl(line)).toEqual({ text: line, repaired: 0 });
  });

  test('valid lines, lines without a marker and lines it cannot fix are unchanged', () => {
    const text = [quoteFixed, '{"type":"user"', String.raw`{"a":"[REDACTED:x]" }}`].join('\n');
    expect(repairRedactedJsonl(text)).toEqual({ text, repaired: 0 });
  });

  test('repairContainer repairs JSONL files only and counts the lines', () => {
    const c = { v: 1 as const, tool: 'claude' as const, mtime: 1, files: [
      { name: 'abc.jsonl', text: `${quoteBroken}\n${quoteFixed}\n` },
      { name: 'subagents/agent-1.meta.json', text: quoteBroken },
    ] };
    const r = repairContainer(c);
    expect(r.repaired).toBe(1);
    expect(r.container.files[0].text).toBe(`${quoteFixed}\n${quoteFixed}\n`);
    expect(r.container.files[1].text).toBe(quoteBroken);
    expect(repairContainer(r.container).repaired).toBe(0);
  });
});
