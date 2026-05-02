import { describe, test, expect } from 'vitest';
import { markPrompt, summarizeMarkers } from './session-sentiment.js';

describe('markPrompt', () => {
  test('flags an "[Request interrupted by user]" marker as interrupt', () => {
    const r = markPrompt('[Request interrupted by user] stop');
    expect(r.markers).toContain('interrupt');
    expect(r.intensity).toBeGreaterThan(0);
  });

  test('flags profanity / all-caps as frustrated', () => {
    const r = markPrompt('what the fuck is this????');
    expect(r.markers).toContain('frustrated');
  });

  test('flags directives starting with "please add/build/fix"', () => {
    const r = markPrompt('please add error handling to the auth flow');
    expect(r.markers).toContain('directive');
  });

  test('flags approval ("yes", "ok", "ship it")', () => {
    expect(markPrompt('ok ship it').markers).toContain('approval');
    expect(markPrompt('yes please').markers).toContain('approval');
  });

  test('flags corrections ("no", "stop", "wrong")', () => {
    expect(markPrompt("no, that's wrong").markers).toContain('correction');
  });

  test('flags questions starting with "why/what/how"', () => {
    expect(markPrompt('why is this broken?').markers).toContain('question');
  });

  test('returns empty markers for neutral prose', () => {
    const r = markPrompt('the weather looks nice today');
    expect(r.markers).toEqual([]);
  });

  test('summarizeMarkers totals + per-marker counts', () => {
    const marked = [
      markPrompt('please fix the bug'),
      markPrompt("no, that's wrong"),
      markPrompt('ok ship it'),
    ];
    const s = summarizeMarkers(marked);
    expect(s.total).toBe(3);
    expect(s.directive).toBeGreaterThanOrEqual(1);
    expect(s.correction).toBeGreaterThanOrEqual(1);
    expect(s.approval).toBeGreaterThanOrEqual(1);
    expect(s.peakIntensity).toBeGreaterThan(0);
  });
});
