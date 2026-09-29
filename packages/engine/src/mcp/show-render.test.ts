/**
 * recall_show returns what a past session said, ran and got back.
 *
 * Two failures these tests exist for:
 * 1. Each message was cut at 1500 characters (8000 with include_code) and ended
 *    in "...". An agent got the start of a long answer with no way to fetch the
 *    rest, so it read the raw transcript file instead.
 * 2. The server envelope holds every tool input and result, but a file tool
 *    printed its path alone and no call printed its result. "What did the Write
 *    put in the file" and "what did that command print" had no answer.
 */
import { describe, test, expect } from 'vitest';
import { renderShowMessages, resultText, BODY_LIMIT, EDGE } from './show-render.js';

const render = (...args: Parameters<typeof renderShowMessages>) => renderShowMessages(...args).join('\n');
const hint = (line: number) => `Call recall_show with expand_line ${line} for the whole text.`;

describe('message text', () => {
  test('THE FAILURE: a long message is returned whole', () => {
    const content = 'a'.repeat(20_000) + 'END';
    const text = render([{ line: 7, role: 'assistant', content }]);
    expect(text).toContain(content);
    expect(text).not.toContain('a...');
  });

  test('thinking with text is shown, and a thinking block with no text is skipped', () => {
    const text = render([
      { line: 1, role: 'assistant', content: '', thinking: 'weigh the two options' },
      { line: 2, role: 'assistant', content: '', thinking: '' },
    ]);
    expect(text).toContain('_(thinking)_\nweigh the two options');
    expect(text).not.toContain('(line 2)');
  });

  test('a turn with no text and no tool calls is marked empty', () => {
    expect(renderShowMessages([{ line: 1, role: 'user', content: '  ' }]))
      .toEqual(['**user** (line 1)', '_(empty)_', '']);
  });
});

describe('tool inputs', () => {
  test('a long Bash command is returned whole', () => {
    const command = 'echo ' + 'x'.repeat(10_000);
    const text = render([{
      line: 3, role: 'assistant', content: '',
      toolCalls: [{ name: 'Bash', input: { command, description: 'print' } }],
    }]);
    expect(text).toContain(`$ ${command}`);
    expect(text).toContain('# print');
  });

  test('THE FAILURE: a Write shows its content, an Edit its old and new strings', () => {
    const text = render([{
      line: 5, role: 'assistant', content: '',
      toolCalls: [
        { name: 'Write', input: { file_path: '/home/user/code/example/a.ts', content: 'export const a = 1;\nexport const b = 2;\n' } },
        { name: 'Edit', input: { file_path: '/home/user/code/example/b.ts', old_string: 'let x = 1;\nlet y = 2;', new_string: 'const x = 1;', replace_all: false } },
      ],
    }]);
    expect(text).toContain('[Write] /home/user/code/example/a.ts');
    expect(text).toContain('  content:\n    export const a = 1;\n    export const b = 2;');
    expect(text).toContain('[Edit] /home/user/code/example/b.ts {"new_string":"const x = 1;","replace_all":false}');
    expect(text).toContain('  old_string:\n    let x = 1;\n    let y = 2;');
  });

  test('short options of a file tool sit on the path line', () => {
    const text = render([{
      line: 6, role: 'assistant', content: '',
      toolCalls: [{ name: 'Read', input: { file_path: '/home/user/code/example/a.ts', offset: 440, limit: 120 } }],
    }]);
    expect(text).toContain('[Read] /home/user/code/example/a.ts {"offset":440,"limit":120}');
  });

  test('a short input of another tool prints on one line', () => {
    const text = render([{
      line: 4, role: 'assistant', content: '',
      toolCalls: [{ name: 'Agent', input: { prompt: 'find the caller' } }],
    }]);
    expect(text).toContain('[Agent] {"prompt":"find the caller"}');
  });
});

describe('tool results', () => {
  test('THE FAILURE: a result is shown under its call', () => {
    const text = render([{
      line: 8, role: 'assistant', content: '',
      toolCalls: [{ name: 'Bash', input: { command: 'git status --short' }, result: ' M a.ts\n?? b.ts' }],
    }]);
    expect(text).toContain('$ git status --short\n  → result:\n     M a.ts\n    ?? b.ts');
  });

  test('an error result is labelled as an error', () => {
    const text = render([{
      line: 9, role: 'assistant', content: '',
      toolCalls: [{ name: 'Bash', input: { command: 'false' }, result: 'Exit code 1', isError: true }],
    }]);
    expect(text).toContain('  → error:\n    Exit code 1');
  });

  test('a call with no recorded result prints no result line', () => {
    const text = render([{
      line: 10, role: 'assistant', content: '',
      toolCalls: [{ name: 'Bash', input: { command: 'sleep 1' } }],
    }]);
    expect(text).not.toContain('→');
  });

  test('content blocks become text, and images and tool references are named', () => {
    expect(resultText([
      { type: 'text', text: 'line one' },
      { type: 'image', source: { type: 'base64', data: 'AAAA' } },
      { type: 'tool_reference', tool_name: 'recall_show' },
    ])).toBe('line one\n[image]\n[tool_reference: recall_show]');
  });
});

describe('large bodies', () => {
  const big = 'HEAD' + 'm'.repeat(BODY_LIMIT * 5) + 'TAIL';

  test('a result over the limit shows its first and last characters and how to get it whole', () => {
    const text = render([{
      line: 408, role: 'assistant', content: '',
      toolCalls: [{ name: 'Read', input: { file_path: '/home/user/code/example/big.ts' }, result: big }],
    }], { expandHint: hint });
    expect(text).toContain(`    ${big.slice(0, EDGE)}\n`);
    expect(text).toContain(`\n    ${big.slice(-EDGE)}`);
    expect(text).toContain(`… ${big.length - 2 * EDGE} characters cut (${big.length} in all, 1 lines). ${hint(408)} …`);
    expect(text).not.toContain(big);
  });

  test('a large Write content is cut the same way', () => {
    const text = render([{
      line: 12, role: 'assistant', content: '',
      toolCalls: [{ name: 'Write', input: { file_path: '/home/user/code/example/big.ts', content: big } }],
    }], { expandHint: hint });
    expect(text).toContain('characters cut');
    expect(text).not.toContain(big);
  });

  test('a large input of another tool is cut the same way', () => {
    const text = render([{
      line: 13, role: 'assistant', content: '',
      toolCalls: [{ name: 'Agent', input: { prompt: big } }],
    }], { expandHint: hint });
    expect(text).toContain('[Agent]\n    {"prompt":"HEAD');
    expect(text).toContain('characters cut');
  });

  test('full: true returns every body whole', () => {
    const text = render([{
      line: 408, role: 'assistant', content: '',
      toolCalls: [{ name: 'Read', input: { file_path: '/home/user/code/example/big.ts' }, result: big }],
    }], { full: true });
    expect(text).toContain(big);
    expect(text).not.toContain('characters cut');
  });

  test('a body at the limit is not cut', () => {
    const exact = 'x'.repeat(BODY_LIMIT);
    const text = render([{
      line: 1, role: 'assistant', content: '',
      toolCalls: [{ name: 'Bash', input: { command: 'cat f' }, result: exact }],
    }]);
    expect(text).toContain(exact);
  });

  test('a cut never splits a surrogate pair', () => {
    const emoji = '😀';
    const body = 'a'.repeat(EDGE - 1) + emoji + 'b'.repeat(BODY_LIMIT * 2);
    const text = render([{
      line: 1, role: 'assistant', content: '',
      toolCalls: [{ name: 'Bash', input: { command: 'cat f' }, result: body }],
    }]);
    expect(text).toContain(emoji);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('harness messages', () => {
  test('a user message the harness wrote is labelled with its origin', () => {
    const text = render([
      { line: 176, role: 'user', content: '<task-notification>done</task-notification>', origin: 'task-notification' },
      { line: 177, role: 'user', content: 'show me a diagram' },
    ]);
    expect(text).toContain('**user** (line 176, written by the harness: task-notification)');
    expect(text).toContain('**user** (line 177)\n');
  });
});
