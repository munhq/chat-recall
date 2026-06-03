import { describe, test, expect } from 'vitest';
import { stripInjectedBanners, chunkSession } from './chunker.js';
import type { SessionEntry, SessionContent } from './session.js';

describe('stripInjectedBanners', () => {
  test('removes "MCP issues detected" banner', () => {
    const out = stripInjectedBanners('MCP issues detected. Run /mcp list for status. real prompt');
    expect(out).not.toMatch(/MCP issues detected/);
    expect(out).toContain('real prompt');
  });

  test('removes "Context low" banner', () => {
    const out = stripInjectedBanners('Context low — Run /compact now\nthe rest');
    expect(out).not.toMatch(/Context low/);
  });

  test('passes prose without banners through unchanged', () => {
    expect(stripInjectedBanners('hello world')).toBe('hello world');
  });
});

describe('chunkSession', () => {
  function fakeEntry(): SessionEntry {
    return {
      sessionId: 'sess1',
      projectPath: '/p',
      fullPath: '/p/x.jsonl',
      created: '2026-01-01T00:00:00Z',
      modified: '2026-01-01T00:00:00Z',
      fileMtime: 1,
      firstPrompt: 'help me',
      messageCount: 4,
      gitBranch: 'main',
      isSidechain: false,
    };
  }
  function fakeContent(): SessionContent {
    return {
      sessionId: 'sess1',
      sessionPath: '/p/x.jsonl',
      summaries: ['User asked for help with auth.'],
      userMessages: [{ text: 'help me with oauth setup', lineNumber: 1, contentType: 'user' }],
      assistantMessages: [{ text: 'sure, here is how OAuth works...', lineNumber: 2, contentType: 'assistant' }],
      toolResults: [],
      toolsUsed: new Set(),
      firstPrompt: 'help me with oauth setup',
      metadata: {
        toolsUsed: [], gitBranch: '', slug: '', durationMs: 0, lastStopReason: '',
        filesModified: [], modelsUsed: [], inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0, peakContextTokens: 0, messageCount: 2,
        costUsd: 0, metadataVersion: 0,
      },
    };
  }

  test('emits at least one chunk for a non-empty session', () => {
    const chunks = chunkSession(fakeEntry(), fakeContent(), 5, 200);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test('respects maxChunks cap', () => {
    const content = fakeContent();
    content.summaries = Array(10).fill('Summary line.');
    content.userMessages = Array(10).fill({ text: 'prompt', lineNumber: 1, contentType: 'user' });
    const chunks = chunkSession(fakeEntry(), content, 3, 200);
    expect(chunks.length).toBeLessThanOrEqual(3);
  });
});
