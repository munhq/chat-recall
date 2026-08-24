/**
 * The resume command is a string handed to a human, so no type and no compiler
 * ever checked it — which is exactly how every call site came to print
 * `claude --resume` for tools that do not have that binary or that flag. These
 * tests are the check that was missing.
 */

import { describe, expect, test } from 'vitest';

import { resumeCommandFor } from './resume-command.js';

describe('resumeCommandFor', () => {
  test('a claude id keeps its id and names claude', () => {
    expect(resumeCommandFor('11111111-2222-4333-8444-555555555555'))
      .toBe('claude --resume 11111111-2222-4333-8444-555555555555');
  });

  test('each prefixed tool gets its own binary, and loses the prefix', () => {
    // The prefix is chat-recall's, not the tool's: pass it back and the tool
    // reports an unknown session.
    expect(resumeCommandFor('codex_abc123')).toBe('codex resume abc123');
    expect(resumeCommandFor('opencode_abc123')).toBe('opencode -s abc123');
    expect(resumeCommandFor('agy_abc123')).toBe('agy --conversation abc123');
    expect(resumeCommandFor('cursor_abc123')).toBe('cursor-agent --resume abc123');
  });

  test('gemini has no resume-by-id, so it returns null rather than a wrong command', () => {
    expect(resumeCommandFor('gemini_abc123')).toBeNull();
  });

  test('an explicit tool wins over the prefix', () => {
    // The caller that has the row knows the tool; the prefix is only a fallback.
    expect(resumeCommandFor('abc123', 'codex')).toBe('codex resume abc123');
    expect(resumeCommandFor('abc123', 'gemini')).toBeNull();
  });

  test('an unknown tool and an empty id return null', () => {
    expect(resumeCommandFor('abc123', 'zed')).toBeNull();
    expect(resumeCommandFor('')).toBeNull();
  });

  test('no command ever leaks a chat-recall prefix', () => {
    for (const id of ['codex_x', 'opencode_x', 'agy_x', 'cursor_x']) {
      const cmd = resumeCommandFor(id);
      expect(cmd).not.toBeNull();
      expect(cmd).not.toContain('_x');
    }
  });
});
