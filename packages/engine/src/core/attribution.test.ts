/**
 * The whole point of this module is that a launch is attributable, so the tests
 * are written as the questions a launch actually asks: did Reddit produce this
 * signup, and does a hostile cookie break the signup path.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyFirstTouch,
  parseFirstTouchCookie,
  firstTouchFromCookieHeader,
  SIGNUP_SOURCES,
} from './attribution.js';

describe('classifyFirstTouch — referrer buckets', () => {
  it.each([
    ['reddit.com', 'reddit'],
    ['www.reddit.com', 'reddit'],
    ['old.reddit.com', 'reddit'],
    ['out.reddit.com', 'reddit'],
    ['redd.it', 'reddit'],
    ['news.ycombinator.com', 'hn'],
    ['x.com', 'x'],
    ['twitter.com', 'x'],
    ['t.co', 'x'],
    ['github.com', 'github'],
    ['npmjs.com', 'npm'],
    ['google.com', 'google'],
    ['google.co.uk', 'google'],
    ['duckduckgo.com', 'duckduckgo'],
    ['discord.gg', 'discord'],
    ['smithery.ai', 'mcp-registry'],
    ['glama.ai', 'mcp-registry'],
  ])('%s → %s', (host, expected) => {
    expect(classifyFirstTouch({ r: host }).source).toBe(expected);
  });

  it('the five ways Reddit spells itself all collapse to one bucket', () => {
    // This is the reason the closed set exists. Five rows for one channel is
    // what makes a dashboard unreadable.
    const spellings = ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'redd.it',
                       'android-app://com.reddit.frontpage'];
    const buckets = new Set(spellings.map((r) => classifyFirstTouch({ r }).source));
    expect([...buckets]).toEqual(['reddit']);
  });

  it('an unknown host is other, and keeps the raw host for debugging', () => {
    const a = classifyFirstTouch({ r: 'some-aggregator.example' });
    expect(a.source).toBe('other');
    expect(a.referrer).toBe('some-aggregator.example');
  });

  it('no referrer at all is direct', () => {
    expect(classifyFirstTouch({}).source).toBe('direct');
    expect(classifyFirstTouch(null).source).toBe('direct');
    expect(classifyFirstTouch(undefined).source).toBe('direct');
  });

  it('strips scheme, port, path, query and credentials from a full URL', () => {
    expect(classifyFirstTouch({ r: 'https://user:pw@www.reddit.com:443/r/ClaudeAI/x?y=1#z' }).source)
      .toBe('reddit');
  });
});

describe('classifyFirstTouch — utm beats referrer', () => {
  it('an explicit utm_source we set wins over the browser referrer', () => {
    // Browsers lie about referrers constantly — privacy modes, Referrer-Policy,
    // in-app webviews. A utm we put on our own link is the stronger claim.
    const a = classifyFirstTouch({ r: 'google.com', u: 'reddit' });
    expect(a.source).toBe('reddit');
    expect(a.referrer).toBe('google.com');   // raw host still recorded
  });

  it('an unrecognised utm falls through to the referrer', () => {
    expect(classifyFirstTouch({ r: 'reddit.com', u: 'some-newsletter' }).source).toBe('reddit');
  });

  it('utm with no referrer and no match is direct, not other', () => {
    expect(classifyFirstTouch({ u: 'mystery' }).source).toBe('direct');
  });

  it('carries the campaign through and caps its length', () => {
    expect(classifyFirstTouch({ r: 'reddit.com', c: 'claudeai-launch' }).campaign)
      .toBe('claudeai-launch');
    expect(classifyFirstTouch({ r: 'reddit.com', c: 'x'.repeat(500) }).campaign!.length).toBe(120);
  });
});

describe('parseFirstTouchCookie — hostile input must never throw', () => {
  it('parses what the site writes', () => {
    const written = encodeURIComponent(JSON.stringify({ r: 'reddit.com', u: '', c: 'claudeai', t: 1 }));
    expect(parseFirstTouchCookie(written)).toMatchObject({ r: 'reddit.com', c: 'claudeai' });
  });

  it.each([
    ['not json', 'x'.repeat(20)],
    ['empty', ''],
    ['null', null],
    ['a bare array', encodeURIComponent('[1,2,3]')],
    ['a bare number', encodeURIComponent('42')],
    ['broken percent-encoding', '%E0%A4%A'],
    ['over the size cap', encodeURIComponent(JSON.stringify({ r: 'a'.repeat(900) }))],
  ])('%s → null, no throw', (_label, value) => {
    expect(() => parseFirstTouchCookie(value as string)).not.toThrow();
    expect(parseFirstTouchCookie(value as string)).toBeNull();
  });

  it('truncates oversized fields that are still inside the cookie cap', () => {
    // 300 chars of host encodes to well under the 600-byte cap, so this parses —
    // and the host is then clamped to the longest legal DNS name.
    const v = encodeURIComponent(JSON.stringify({ r: 'a'.repeat(300), u: 'b'.repeat(90) }));
    const p = parseFirstTouchCookie(v);
    expect(p!.r!.length).toBe(253);
    expect(p!.u!.length).toBe(60);
  });

  it('rejects the whole cookie once it exceeds the cap, rather than truncating it', () => {
    // The writer caps its own payload at 300 chars. Anything materially larger
    // did not come from us, so it is discarded rather than salvaged.
    const v = encodeURIComponent(JSON.stringify({ r: 'a'.repeat(400), u: 'b'.repeat(200) }));
    expect(v.length).toBeGreaterThan(600);
    expect(parseFirstTouchCookie(v)).toBeNull();
  });

  it('a wrong-typed field is dropped, not coerced', () => {
    const v = encodeURIComponent(JSON.stringify({ r: 12345, u: { nested: true }, t: 'soon' }));
    expect(parseFirstTouchCookie(v)).toEqual({ r: undefined, u: undefined, c: undefined, t: undefined });
  });
});

describe('firstTouchFromCookieHeader', () => {
  it('finds cr_src among other cookies', () => {
    const v = encodeURIComponent(JSON.stringify({ r: 'news.ycombinator.com' }));
    expect(firstTouchFromCookieHeader(`session=abc; cr_src=${v}; theme=dark`).source).toBe('hn');
  });

  it('does not match a cookie whose name merely ends in cr_src', () => {
    const v = encodeURIComponent(JSON.stringify({ r: 'reddit.com' }));
    expect(firstTouchFromCookieHeader(`not_cr_src=${v}`).source).toBe('direct');
  });

  it('no header, or a garbage header, is direct rather than an error', () => {
    expect(firstTouchFromCookieHeader(null).source).toBe('direct');
    expect(firstTouchFromCookieHeader('').source).toBe('direct');
    expect(firstTouchFromCookieHeader('=;;=;').source).toBe('direct');
  });
});

describe('the closed set stays closed', () => {
  it('every classification result is a member of SIGNUP_SOURCES', () => {
    const probes = ['reddit.com', 'news.ycombinator.com', 'nothing.example', '', 'x.com'];
    for (const r of probes) {
      expect(SIGNUP_SOURCES).toContain(classifyFirstTouch({ r }).source);
    }
  });

  it('direct and other both exist, because they are the two honest fallbacks', () => {
    expect(SIGNUP_SOURCES).toContain('direct');
    expect(SIGNUP_SOURCES).toContain('other');
  });
});
