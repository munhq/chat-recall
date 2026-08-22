/**
 * One read per session while deriving, instead of four.
 *
 * Deriving a session called replaySessionAny, computeOutcome (which reads twice
 * internally) and extractTurnsAny — each re-reading the whole transcript from
 * disk. For the 36.8 MB session on this developer's machine that was ~150 MB of
 * reads per sync per target, to ship one conversation.
 *
 * The cache is deliberately scoped rather than ambient, because a long-lived
 * cache of transcript text is the exact shape of the out-of-memory bug that
 * took this daemon down. These tests pin both properties: it must dedupe INSIDE
 * a scope, and it must hold nothing OUTSIDE one.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionGroupText, withSessionReadCache } from './live-session-scan.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-readcache-'));
  file = join(dir, 'session.jsonl');
  writeFileSync(file, '{"type":"user","uuid":"a"}\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const group = () => ({ paths: [file] } as any);

describe('scoped session read cache', () => {
  test('inside a scope, repeated reads return the identical object', () => {
    withSessionReadCache(() => {
      const a = readSessionGroupText(group());
      const b = readSessionGroupText(group());
      const c = readSessionGroupText(group());
      // Same reference: proof the file was not re-read and re-merged.
      expect(b).toBe(a);
      expect(c).toBe(a);
    });
  });

  test('outside a scope nothing is cached — no ambient retention', () => {
    const a = readSessionGroupText(group());
    const b = readSessionGroupText(group());
    expect(b).not.toBe(a);
    expect(b.text).toBe(a.text);
  });

  test('the scope is dropped on exit, so the next scope re-reads', () => {
    const a = withSessionReadCache(() => readSessionGroupText(group()));
    const b = withSessionReadCache(() => readSessionGroupText(group()));
    expect(b).not.toBe(a);
  });

  test('a file that grows mid-scope is re-read, never served stale', () => {
    withSessionReadCache(() => {
      const a = readSessionGroupText(group());
      appendFileSync(file, '{"type":"user","uuid":"b"}\n');
      const b = readSessionGroupText(group());
      expect(b).not.toBe(a);
      expect(b.text).toContain('"b"');
    });
  });

  test('the scope is released even when the body throws', () => {
    expect(() => withSessionReadCache(() => { throw new Error('boom'); })).toThrow('boom');
    // If the finally had not run, this would hand back the previous entry.
    const a = readSessionGroupText(group());
    const b = readSessionGroupText(group());
    expect(b).not.toBe(a);
  });

  test('nested scopes share one entry and only the outermost clears it', () => {
    withSessionReadCache(() => {
      const outer = readSessionGroupText(group());
      const inner = withSessionReadCache(() => readSessionGroupText(group()));
      expect(inner).toBe(outer);
      // Still cached after the inner scope closed.
      expect(readSessionGroupText(group())).toBe(outer);
    });
  });
});
