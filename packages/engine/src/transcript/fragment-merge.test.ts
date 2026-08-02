/**
 * The archive's shrink guard rejects any capture smaller than what is stored.
 * That is correct for a resume-TRUNCATED file and wrong for a disjoint
 * FRAGMENT — a second device, or a session resumed under another profile,
 * legitimately holds records the archive has never seen while being smaller
 * overall. Size cannot tell those two apart; records can.
 *
 * These pin the merge the sync route runs when the guard fires, and — just as
 * importantly — that it still refuses to let a truncation shrink history.
 */
import { describe, test, expect } from 'vitest';
import { mergeContainer, gzipContainer, gunzipContainer } from './index.js';
import type { RawContainer } from './index.js';

const rec = (uuid: string, text = 'x') =>
  JSON.stringify({ uuid, type: 'user', message: { role: 'user', content: text } });

/** A container shaped like a real one. `v` and `mtime` matter: mergeContainer
 *  always emits them, so a fixture without them makes the merged envelope look
 *  16 bytes bigger than the stored one and the size comparisons below become
 *  meaningless. Anything from buildRawContainer/gunzipContainer has them. */
function container(lines: string[], name = 'sess.jsonl'): RawContainer {
  return { v: 1, tool: 'claude', mtime: 0, files: [{ name, text: lines.join('\n') + '\n' }] } as unknown as RawContainer;
}
function uuidsOf(c: RawContainer): Set<string> {
  const out = new Set<string>();
  for (const f of c.files) {
    for (const l of f.text.split('\n')) {
      if (!l.trim()) continue;
      try { const u = JSON.parse(l).uuid; if (u) out.add(u); } catch { /* not a record */ }
    }
  }
  return out;
}
/** Sum of record bytes — a readable proxy for "did this grow?" in the
 *  disjoint-vs-subset assertions. NOT the unit the archive stores (see the
 *  size test below). */
const sizeOf = (c: RawContainer) => c.files.reduce((n, f) => n + f.text.length, 0);

describe('disjoint fragment from another device', () => {
  test('a SMALLER disjoint capture contributes its records', () => {
    const stored = container([rec('a'), rec('b'), rec('c'), rec('d')]);
    const incoming = container([rec('x'), rec('y')]);          // smaller AND disjoint
    expect(sizeOf(incoming)).toBeLessThan(sizeOf(stored));      // the guard would reject it

    const merged = mergeContainer(stored, incoming).container;
    expect([...uuidsOf(merged)].sort()).toEqual(['a', 'b', 'c', 'd', 'x', 'y']);
    expect(sizeOf(merged)).toBeGreaterThan(sizeOf(stored));     // so the re-store is authorised
  });

  test('a strict subset is a no-op — truncation still cannot shrink history', () => {
    const stored = container([rec('a'), rec('b'), rec('c')]);
    const truncated = container([rec('a')]);                    // resume rewrote the file

    const merged = mergeContainer(stored, truncated).container;
    expect([...uuidsOf(merged)].sort()).toEqual(['a', 'b', 'c']);
    // Not larger ⇒ the sync route does not re-store ⇒ the archive is untouched.
    expect(sizeOf(merged)).toBeLessThanOrEqual(sizeOf(stored));
  });

  test('overlapping captures do not duplicate shared records', () => {
    const stored = container([rec('a'), rec('b')]);
    const incoming = container([rec('b'), rec('c')]);

    const merged = mergeContainer(stored, incoming).container;
    expect([...uuidsOf(merged)].sort()).toEqual(['a', 'b', 'c']);
    expect(merged.files[0].text.match(/"uuid":"b"/g)).toHaveLength(1);
  });

  test('subagent sidecars merge per file, not across files', () => {
    const stored = {
      v: 1, tool: 'claude', mtime: 0,
      files: [
        { name: 'sess.jsonl', text: rec('a') + '\n' },
        { name: 'subagents/agent-1.jsonl', text: rec('s1') + '\n' },
      ],
    } as unknown as RawContainer;
    const incoming = {
      v: 1, tool: 'claude', mtime: 0,
      files: [
        { name: 'sess.jsonl', text: rec('b') + '\n' },
        { name: 'subagents/agent-2.jsonl', text: rec('s2') + '\n' },
      ],
    } as unknown as RawContainer;

    const merged = mergeContainer(stored, incoming).container;
    expect(merged.files.map((f) => f.name).sort())
      .toEqual(['sess.jsonl', 'subagents/agent-1.jsonl', 'subagents/agent-2.jsonl']);
    expect([...uuidsOf(merged)].sort()).toEqual(['a', 'b', 's1', 's2']);
  });

  test('merged size is comparable with the stored size, in the same unit', () => {
    // The archive's `size` column is gzipContainer().size — that is what the
    // client sends as raw_size, and what the shrink guard compares against. The
    // merge path must re-store the SAME measure, or the next sync's guard
    // compares two different units. (It is the serialized container, not the
    // sum of file-text lengths — asserting the latter is how this test caught
    // the mismatch in the first place.)
    const stored = container([rec('a'), rec('b')]);
    const incoming = container([rec('z')]);
    const merged = mergeContainer(stored, incoming).container;

    const storedSize = gzipContainer(stored).size;
    const { gz, size: mergedSize } = gzipContainer(merged);

    expect(mergedSize).toBeGreaterThan(storedSize);   // authorises the re-store
    expect(gzipContainer(merged).size).toBe(mergedSize); // stable across calls

    const back = gunzipContainer(gz);
    expect(back).toBeTruthy();
    expect(uuidsOf(back!)).toEqual(uuidsOf(merged));
  });

  test('a truncation does NOT produce a larger size, so nothing is re-stored', () => {
    const stored = container([rec('a'), rec('b'), rec('c')]);
    const truncated = container([rec('a')]);
    const merged = mergeContainer(stored, truncated).container;
    expect(gzipContainer(merged).size).toBeLessThanOrEqual(gzipContainer(stored).size);
  });
});
