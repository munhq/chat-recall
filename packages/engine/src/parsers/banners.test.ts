/**
 * These assertions came from chunker.test.ts. The chunker they shared a file
 * with was unreachable and was removed; stripInjectedBanners was not — it runs
 * on every prompt the session parser records (session.ts recordPrompt) and
 * again in the summary generator, so its coverage moves here with it.
 */
import { describe, test, expect } from 'vitest';
import { stripInjectedBanners } from './banners.js';

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

  test('removes an API error banner', () => {
    const out = stripInjectedBanners('API Error: 529 overloaded\nwhat I actually asked');
    expect(out).not.toMatch(/API Error/);
    expect(out).toContain('what I actually asked');
  });

  test('passes prose without banners through unchanged', () => {
    expect(stripInjectedBanners('hello world')).toBe('hello world');
  });
});
