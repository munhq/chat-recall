/**
 * gzipContainerStreamed writes the JSON of a container to gzip one piece of
 * file text at a time, so a server never holds the whole JSON text. Its JSON
 * and its size must be the ones gzipContainer gives, because the shrink guard
 * compares sizes from both.
 */
import { describe, test, expect } from 'vitest';
import { gunzipSync } from 'zlib';
import { gzipContainer, gzipContainerStreamed, gunzipContainer, rawParseMaxBytes, RAW_PARSE_HEAP_RESERVE, type RawContainer } from './raw.js';

const PIECE = 1 << 20;

async function same(c: RawContainer) {
  const whole = gzipContainer(c);
  const streamed = await gzipContainerStreamed(c);
  expect(gunzipSync(streamed.gz).toString('utf-8')).toBe(JSON.stringify(c));
  expect(streamed.size).toBe(whole.size);
  expect(gunzipContainer(streamed.gz)).toEqual(c);
}

describe('gzipContainerStreamed', () => {
  test('gives the JSON and the size of gzipContainer for a small container', async () => {
    await same({ v: 1, tool: 'claude', mtime: 1000, files: [{ name: 's.jsonl', text: '{"type":"user","message":{"content":"a \\"quoted\\" word\\n"}}\n' }] });
  });

  test('gives the same JSON for several files, an empty text and keys after files', async () => {
    const c = { v: 1, tool: 'codex', mtime: 2, files: [{ name: 'a.jsonl', text: 'x\ty\u0001' }, { name: 'subagents/b.jsonl', text: '' }], extra: 'after' } as unknown as RawContainer;
    await same(c);
  });

  test('a surrogate pair on a piece boundary stays one character', async () => {
    const text = 'a'.repeat(PIECE - 1) + '\u{1F600}' + 'b'.repeat(10);
    expect(text.charCodeAt(PIECE - 1)).toBe(0xd83d);
    await same({ v: 1, tool: 'claude', mtime: 3, files: [{ name: 's.jsonl', text }] });
  });

  test('a file name from a client that holds U+0000 or a placeholder shape gives the same JSON', async () => {
    await same({ v: 1, tool: 'claude', mtime: 5, files: [
      { name: '\u0000cr-text-0\u0000', text: 'first' },
      { name: 'cr-text-0', text: 'second "x"' },
    ] });
  });

  test('a lone surrogate is escaped as JSON.stringify escapes it', async () => {
    await same({ v: 1, tool: 'claude', mtime: 4, files: [{ name: 's.jsonl', text: 'x\ud800y' + '"'.repeat(PIECE + 5) }] });
  });
});

describe('rawParseMaxBytes', () => {
  test('a 259 MB heap unpacks less than 40 MB; a large heap stops at 40 MB', () => {
    const mb = 1024 * 1024;
    expect(rawParseMaxBytes(259 * mb)).toBeLessThan(40 * mb);
    expect(rawParseMaxBytes(259 * mb)).toBeGreaterThan(20 * mb);
    expect(rawParseMaxBytes(4096 * mb)).toBe(40 * mb);
    expect(rawParseMaxBytes(RAW_PARSE_HEAP_RESERVE)).toBe(0);
  });
});
