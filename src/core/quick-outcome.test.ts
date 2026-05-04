import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { quickOutcomeStatus, quickStatusEmoji } from './quick-outcome.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cr-quickout-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeJsonl(name: string, lines: object[]): string {
  const p = join(tmp, name);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

function setMtime(file: string, hoursAgo: number): void {
  const ts = (Date.now() - hoursAgo * 3600 * 1000) / 1000;
  utimesSync(file, ts, ts);
}

function userMsg(text: string) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

describe('quickOutcomeStatus', () => {
  test('returns unknown when file is missing', () => {
    const out = quickOutcomeStatus(join(tmp, 'nope.jsonl'), 'sess-x');
    expect(out.status).toBe('unknown');
    expect(out.reason).toMatch(/not found/);
    expect(out.sessionId).toBe('sess-x');
  });

  test('classifies recently-modified file as in_progress', () => {
    const f = writeJsonl('hot.jsonl', [userMsg('working on it')]);
    // Default mtime is now — well within the 2h window.
    const out = quickOutcomeStatus(f, 'hot');
    expect(out.status).toBe('in_progress');
    expect(out.reason).toMatch(/last 2 hours/);
  });

  test('classifies an older file with [Request interrupted by user] as interrupted', () => {
    const f = writeJsonl('done.jsonl', [
      userMsg('start the work'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }] } },
      userMsg('[Request interrupted by user]'),
    ]);
    setMtime(f, 5); // 5h ago — outside the in_progress window
    const out = quickOutcomeStatus(f, 'done');
    expect(out.status).toBe('interrupted');
    expect(out.reason).toMatch(/interrupt/);
  });

  test('classifies an older file with normal final user message as completed', () => {
    const f = writeJsonl('shipped.jsonl', [
      userMsg('please add the feature'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      userMsg('thanks, looks good'),
    ]);
    setMtime(f, 24);
    const out = quickOutcomeStatus(f, 'shipped');
    expect(out.status).toBe('completed');
  });

  test('does not misclassify when the interrupt marker appears mid-session, not at the end', () => {
    // Earlier interrupt that the user recovered from shouldn't make the
    // whole session look "interrupted" — only the LAST user prompt matters.
    const f = writeJsonl('recovered.jsonl', [
      userMsg('start the work'),
      userMsg('[Request interrupted by user]'),
      userMsg('actually carry on please'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'continuing' }] } },
      userMsg('great, all done'),
    ]);
    setMtime(f, 12);
    const out = quickOutcomeStatus(f, 'recovered');
    expect(out.status).toBe('completed');
  });

  test('boundary: file modified exactly at the in_progress window edge', () => {
    const f = writeJsonl('edge.jsonl', [userMsg('borderline')]);
    // Just past the 2h window — should NOT be in_progress.
    setMtime(f, 2.1);
    const out = quickOutcomeStatus(f, 'edge');
    expect(out.status).not.toBe('in_progress');
  });

  test('handles malformed lines without crashing', () => {
    const p = join(tmp, 'corrupt.jsonl');
    writeFileSync(p,
      'not-json garbage\n' +
      JSON.stringify(userMsg('valid prompt')) + '\n' +
      'more garbage\n'
    );
    setMtime(p, 6);
    const out = quickOutcomeStatus(p, 'corrupt');
    // Last *valid* user message is the 'valid prompt' — not an interrupt — so completed.
    expect(out.status).toBe('completed');
  });

  test('survives an empty file (no user messages at all)', () => {
    const f = writeJsonl('empty.jsonl', []);
    setMtime(f, 8);
    const out = quickOutcomeStatus(f, 'empty');
    // No interrupt found → not interrupted → completed (per the 4-state model).
    expect(out.status).toBe('completed');
  });

  test('mtime is propagated into the response', () => {
    const f = writeJsonl('mtime.jsonl', [userMsg('check mtime')]);
    setMtime(f, 1);
    const out = quickOutcomeStatus(f, 'mtime');
    expect(out.mtime).toBeGreaterThan(0);
    // 1h ago plus tolerance.
    const expected = Date.now() - 1 * 3600 * 1000;
    expect(Math.abs(out.mtime - expected)).toBeLessThan(60_000);
  });
});

describe('quickStatusEmoji', () => {
  test.each([
    ['in_progress', '🟡'],
    ['interrupted', '⏸'],
    ['completed', '✓'],
    ['unknown', '❔'],
  ] as const)('%s → %s', (status, emoji) => {
    expect(quickStatusEmoji(status)).toBe(emoji);
  });
});
