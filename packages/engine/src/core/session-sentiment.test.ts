import { describe, test, expect } from 'vitest';
import { markPrompt, summarizeMarkers, pickMarkersPayload, markersFromTurns, markersVersion, MARKERS_VERSION, MARKERS_TURN_OPTS } from './session-sentiment.js';
import { extractTurnsFromEvents } from './generic-engine.js';

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

describe('pickMarkersPayload', () => {
  const p = (text: string, line: number) => ({ line, ts: 0, text, markers: [], intensity: 0 });
  const payload = (texts: string[], v?: number) => ({
    ...(v ? { v } : {}), sessionId: 's1',
    prompts: texts.map((t, i) => p(t, i + 1)), summary: summarizeMarkers([]),
  });
  const person = ['fix the login bug', 'now add a test', 'ok go on'];
  const harness = ['<task-notification>\n<task-id>b</task-id>', 'Stop hook feedback:\nanswer', '<agent-message from="a">'];

  test('THE FAILURE: a version 1 row loses to a version 2 row with fewer prompts', () => {
    const best = pickMarkersPayload('s1', [
      { source: 'markers', data: payload([...person, ...harness, 'Repo: map the code']) },
      { source: 'markers', data: payload(person, MARKERS_VERSION) },
    ]);
    expect(best?.prompts.map((x) => x.text)).toEqual(person);
  });

  test('with no version 2 row, harness text is filtered out of the version 1 row', () => {
    const best = pickMarkersPayload('s1', [{ source: 'markers', data: payload([...person, ...harness]) }]);
    expect(best?.prompts.map((x) => x.text)).toEqual(person);
    expect(best?.summary.total).toBe(3);
    expect(best?.v).toBeUndefined();
  });

  test('a fuller envelope still beats a truncated version 2 row', () => {
    const best = pickMarkersPayload('s1', [
      { source: 'markers', data: payload(['fix the login bug'], MARKERS_VERSION) },
      { source: 'envelope', data: payload(person) },
    ]);
    expect(best?.prompts).toHaveLength(3);
  });

  test('nothing usable returns null', () => {
    expect(pickMarkersPayload('s1', [{ source: 'chunks', data: payload(harness) }])).toBeNull();
    expect(pickMarkersPayload('s1', [])).toBeNull();
  });

  test('markersFromTurns writes the current version and keeps user turns only', () => {
    const out = markersFromTurns('s1', [
      { kind: 'user', line: 1, ts: 1, text: 'fix the login bug' },
      { kind: 'assistant_text', line: 2, ts: 2, text: 'done' },
    ]);
    expect(out.v).toBe(MARKERS_VERSION);
    expect(out.prompts.map((x) => x.line)).toEqual([1]);
    expect(markersVersion({ prompts: [] })).toBe(1);
  });
});

/**
 * A prompt longer than 1200 characters reached recall_user_prompts as its
 * first 1200 and an ellipsis. The CLI built the markers row from turns cut for
 * the conversation view, and the server took that row over the whole envelope
 * because both held the same number of prompts.
 */
describe('whole prompt text', () => {
  const long = 'this is too ai - ' + 'x'.repeat(1300) + ' - Where it says no - SCREAMS AI';
  const cut = long.slice(0, 1200) + '…';
  const row = (texts: string[], v?: number) => ({
    ...(v ? { v } : {}), sessionId: 's1',
    prompts: texts.map((text, i) => ({ line: 10 * (i + 1), ts: i, text, markers: [], intensity: 0 })),
    summary: summarizeMarkers([]),
  });

  test('THE FAILURE: the markers compute keeps each prompt whole', () => {
    const events = [{ kind: 'user' as const, ts: 1, line: 3047, text: long }];
    expect(markersFromTurns('s1', extractTurnsFromEvents('s1', events, MARKERS_TURN_OPTS).turns).prompts[0].text).toBe(long);
    // The conversation view keeps its own limit.
    expect(extractTurnsFromEvents('s1', events).turns[0].text).toBe(cut);
  });

  test('THE FAILURE: a cut prompt in a synced row is restored from the envelope', () => {
    const best = pickMarkersPayload('s1', [
      { source: 'markers', data: row(['fix the login bug', cut], MARKERS_VERSION) },
      { source: 'envelope', data: { ...row(['fix the login bug', long]), prompts: row(['fix the login bug', long]).prompts.map(p => ({ ...p, ...markPrompt(p.text) })) } },
    ]);
    expect(best?.v).toBe(MARKERS_VERSION);
    expect(best?.prompts.map((x) => x.text)).toEqual(['fix the login bug', long]);
    expect(best?.prompts[1].markers).toEqual(markPrompt(long).markers);
  });

  test('an envelope prompt that does not continue the cut text is left alone', () => {
    const best = pickMarkersPayload('s1', [
      { source: 'markers', data: row(['a', cut], MARKERS_VERSION) },
      { source: 'envelope', data: row(['a', 'something else entirely' + 'y'.repeat(2000)]) },
    ]);
    expect(best?.prompts[1].text).toBe(cut);
  });

  test('a prompt that ends in an ellipsis the person typed is left alone', () => {
    const best = pickMarkersPayload('s1', [
      { source: 'markers', data: row(['wait…'], MARKERS_VERSION) },
      { source: 'envelope', data: row(['wait…']) },
    ]);
    expect(best?.prompts[0].text).toBe('wait…');
  });
});
