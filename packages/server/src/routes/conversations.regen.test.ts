/**
 * Regenerate-summary retry behavior (generateSummaryWithRetry) — a transient
 * upstream failure (gateway 5xx/429, dropped connection) must be retried with
 * backoff instead of surfacing to the user; non-transient errors must fail
 * fast; a persistent outage must still throw after the attempts run out.
 * Motivated by the 2026-07-03 incident: Ollama Cloud 503'd for ~3s and the
 * raw upstream_failed reached the dashboard on the first click.
 */
import { describe, test, expect } from 'vitest';
import { generateSummaryWithRetry } from './conversations.js';
import type { SessionContent } from '../imports.js';

const CONTENT = {} as SessionContent;

function generator(outcomes: Array<string | Error>): { generate: () => Promise<string>; calls: () => number } {
  let i = 0;
  return {
    calls: () => i,
    generate: async () => {
      const o = outcomes[Math.min(i++, outcomes.length - 1)];
      if (o instanceof Error) throw o;
      return o;
    },
  };
}

describe('generateSummaryWithRetry', () => {
  test('retries a transient 502/upstream_failed and returns the eventual summary', async () => {
    const g = generator([
      new Error('openai-compat API error: 502 Bad Gateway {"error":{"code":"upstream_failed","message":"Retryable status=503"}}'),
      'the summary',
    ]);
    await expect(generateSummaryWithRetry(g, CONTENT, 1)).resolves.toBe('the summary');
    expect(g.calls()).toBe(2);
  });

  test('retries a dropped connection (ECONNRESET)', async () => {
    const g = generator([new Error('fetch failed: ECONNRESET'), 'ok']);
    await expect(generateSummaryWithRetry(g, CONTENT, 1)).resolves.toBe('ok');
    expect(g.calls()).toBe(2);
  });

  test('fails fast on a non-transient error (no retry)', async () => {
    const g = generator([new Error('openai-compat embedder requires OPENAI_COMPAT_BASE_URL')]);
    await expect(generateSummaryWithRetry(g, CONTENT, 1)).rejects.toThrow(/OPENAI_COMPAT_BASE_URL/);
    expect(g.calls()).toBe(1);
  });

  test('gives up after 3 attempts on a persistent transient failure', async () => {
    const g = generator([new Error('Retryable status=503')]);
    await expect(generateSummaryWithRetry(g, CONTENT, 1)).rejects.toThrow(/503/);
    expect(g.calls()).toBe(3);
  });
});
