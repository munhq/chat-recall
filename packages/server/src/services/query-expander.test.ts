import { describe, test, expect, vi, afterEach } from 'vitest';
import { QueryExpander, queryExpansionEnabled } from './query-expander.js';
import type { SummaryGeneratorConfig } from '../imports.js';

const CFG: SummaryGeneratorConfig = { provider: 'openai', apiKey: 'k', apiModel: 'gpt-x', apiBaseUrl: 'https://x/v1' };

/** Build an expander with an injected fake LLM (no network). */
function make(reply: string | (() => Promise<string>), opts: Partial<{ enabled: boolean; config: SummaryGeneratorConfig | null }> = {}) {
  const llmCall = vi.fn(async () => (typeof reply === 'function' ? reply() : reply));
  const exp = new QueryExpander({
    enabled: opts.enabled ?? true,
    config: opts.config !== undefined ? opts.config : CFG,
    llmCall,
  });
  return { exp, llmCall };
}

describe('QueryExpander', () => {
  test('expands a natural-language query with deduped, capped keywords', async () => {
    // Reply repeats "database" (already in query) and offers 12 terms; expect
    // dedupe + cap at 10.
    const { exp } = make('postgres migration schema database connection pool dsn orm sql sqlite cnpg pgbouncer');
    const r = await exp.expand('where did I set up the database');
    expect(r.used).toBe(true);
    expect(r.addedTerms).not.toContain('database');          // deduped vs original
    expect(r.addedTerms.length).toBeLessThanOrEqual(10);     // capped
    expect(r.addedTerms).toContain('postgres');
    expect(r.expanded.startsWith('where did I set up the database ')).toBe(true);
    expect(r.expanded).toContain('postgres');
  });

  test('skips short / precise queries without calling the LLM', async () => {
    const { exp, llmCall } = make('a b c d e f');
    const r = await exp.expand('oauth login');               // 2 words < MIN_WORDS
    expect(r.used).toBe(false);
    expect(r.expanded).toBe('oauth login');
    expect(llmCall).not.toHaveBeenCalled();
  });

  test('caches by normalized query — one LLM call for repeats', async () => {
    const { exp, llmCall } = make('alpha beta gamma');
    await exp.expand('how to configure the proxy');
    await exp.expand('how to   configure the proxy');         // whitespace variant
    await exp.expand('how to configure the proxy');
    expect(llmCall).toHaveBeenCalledTimes(1);
  });

  test('fails open to the original query when the LLM throws', async () => {
    const { exp } = make(async () => { throw new Error('502 upstream'); });
    const r = await exp.expand('debug the failing migration job');
    expect(r.used).toBe(false);
    expect(r.expanded).toBe('debug the failing migration job');
    expect(r.addedTerms).toEqual([]);
  });

  test('disabled when no provider configured, even if asked on', async () => {
    const { exp, llmCall } = make('x y z', { enabled: true, config: null });
    expect(exp.isEnabled).toBe(false);
    const r = await exp.expand('set up the postgres cluster image');
    expect(r.used).toBe(false);
    expect(llmCall).not.toHaveBeenCalled();
  });

  test('disabled for shell-only providers (cli/gemini-cli) on the hot path', async () => {
    const { exp } = make('x y z', { enabled: true, config: { provider: 'gemini-cli' } });
    expect(exp.isEnabled).toBe(false);
  });

  test('disabled when the enable flag is off', async () => {
    const { exp, llmCall } = make('x y z', { enabled: false });
    expect(exp.isEnabled).toBe(false);
    await exp.expand('a longer natural language query here');
    expect(llmCall).not.toHaveBeenCalled();
  });
});

describe('queryExpansionEnabled (env)', () => {
  const orig = { QUERY_EXPANSION: process.env.QUERY_EXPANSION, SUMMARY_PROVIDER: process.env.SUMMARY_PROVIDER };
  afterEach(() => {
    process.env.QUERY_EXPANSION = orig.QUERY_EXPANSION;
    process.env.SUMMARY_PROVIDER = orig.SUMMARY_PROVIDER;
  });

  test('off unless QUERY_EXPANSION=on AND a hot-path summary provider is set', () => {
    process.env.QUERY_EXPANSION = 'on'; delete process.env.SUMMARY_PROVIDER;
    expect(queryExpansionEnabled()).toBe(false);              // no provider
    process.env.SUMMARY_PROVIDER = 'openai';
    expect(queryExpansionEnabled()).toBe(true);
    process.env.SUMMARY_PROVIDER = 'gemini-cli';
    expect(queryExpansionEnabled()).toBe(false);              // shell-only provider
    process.env.QUERY_EXPANSION = 'off'; process.env.SUMMARY_PROVIDER = 'openai';
    expect(queryExpansionEnabled()).toBe(false);              // flag off
  });
});
