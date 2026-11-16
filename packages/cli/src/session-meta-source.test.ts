/**
 * The telemetry parser reads a file line by line, so it is given a JSONL transcript and nothing else:
 * the path of an OpenCode session is the database of the tool.
 */
import { describe, test, expect } from 'vitest';
import { isJsonlTranscript } from './sync-client.js';

describe('isJsonlTranscript', () => {
  test('is true for the transcripts of the file-based tools', () => {
    expect(isJsonlTranscript('/home/user/.claude/projects/-home-user-code-example/11111111-2222-3333-4444-555555555555.jsonl')).toBe(true);
    expect(isJsonlTranscript('/home/user/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-11111111-2222-3333-4444-555555555555.jsonl')).toBe(true);
    expect(isJsonlTranscript('C:\\Users\\alice\\.claude\\projects\\p\\s.JSONL')).toBe(true);
  });

  test('is false for the databases of the database-based tools', () => {
    expect(isJsonlTranscript('/home/user/.local/share/opencode/opencode.db')).toBe(false);
    expect(isJsonlTranscript('/home/user/.cursor/chats/abc/def/store.db')).toBe(false);
    expect(isJsonlTranscript('')).toBe(false);
  });
});
