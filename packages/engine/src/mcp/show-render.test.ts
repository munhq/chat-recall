/**
 * recall_show returns every message in full.
 *
 * The failure these tests exist for: each message was cut at 1500 characters
 * (8000 with include_code) and ended in "...". An agent reading a past session
 * got the first part of a long answer with no way to fetch the rest, so it read
 * the raw transcript file instead.
 */
import { describe, test, expect } from 'vitest';
import { renderShowMessages } from './tools.js';

describe('renderShowMessages', () => {
  test('THE FAILURE: a long message is returned whole', () => {
    const content = 'a'.repeat(20_000) + 'END';
    const text = renderShowMessages([{ line: 7, role: 'assistant', content }]).join('\n');
    expect(text).toContain(content);
    expect(text).not.toContain('a...');
  });

  test('a long Bash command is returned whole', () => {
    const command = 'echo ' + 'x'.repeat(10_000);
    const text = renderShowMessages([{
      line: 3, role: 'assistant', content: '',
      toolCalls: [{ name: 'Bash', input: { command, description: 'print' } }],
    }]).join('\n');
    expect(text).toContain(`$ ${command}`);
    expect(text).toContain('# print');
  });

  test('a long input of another tool is returned whole', () => {
    const prompt = 'p'.repeat(5_000);
    const text = renderShowMessages([{
      line: 4, role: 'assistant', content: '',
      toolCalls: [{ name: 'Agent', input: { prompt } }],
    }]).join('\n');
    expect(text).toContain(prompt);
  });

  test('a file tool renders as its path', () => {
    const text = renderShowMessages([{
      line: 5, role: 'assistant', content: 'editing',
      toolCalls: [{ name: 'Edit', input: { file_path: '/home/user/code/example/a.ts', old_string: 'x' } }],
    }]).join('\n');
    expect(text).toContain('[Edit] /home/user/code/example/a.ts');
    expect(text).not.toContain('old_string');
  });

  test('a turn with no text and no tool calls is marked empty', () => {
    expect(renderShowMessages([{ line: 1, role: 'user', content: '  ' }]))
      .toEqual(['**user** (line 1)', '_(empty)_', '']);
  });
});
