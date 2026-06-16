import { describe, test, expect } from 'vitest';
import { isInternalToolPrompt } from './internal-prompts.js';

describe('isInternalToolPrompt — skip chat-recall self-pollution', () => {
  test('matches the summary-generator prompt (the ~5000-session polluter)', () => {
    expect(isInternalToolPrompt('You are summarizing a coding assistant conversation. Create a structured technical summary using this format:')).toBe(true);
    // wrapped / quoted variants still match
    expect(isInternalToolPrompt('  "You are summarizing a coding assistant conversation...')).toBe(true);
  });

  test('matches PONG health-check pings', () => {
    expect(isInternalToolPrompt('say just the word PONG')).toBe(true);
    expect(isInternalToolPrompt('"Say exactly the word PONG and nothing else."')).toBe(true);
  });

  test('does NOT match real conversations (incl. ones that quote the prompt mid-text)', () => {
    expect(isInternalToolPrompt('help me fix the summarizer')).toBe(false);
    expect(isInternalToolPrompt('the bug is that "You are summarizing a coding assistant" never returns')).toBe(false);
    expect(isInternalToolPrompt('')).toBe(false);
    expect(isInternalToolPrompt(undefined)).toBe(false);
    expect(isInternalToolPrompt('please continue claude --resume ce8f0806')).toBe(false);
  });
});
