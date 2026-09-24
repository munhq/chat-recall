/**
 * The toolkit inventory a device sends with its sync.
 *
 * The server deletes a device's presence for every id the inventory does not
 * name, so a list that arrives cut short would read as "the device removed the
 * rest". A malformed entry is therefore dropped whole.
 */
import { describe, test, expect } from 'vitest';

import { parseInventory } from './sync.js';

describe('parseInventory', () => {
  test('a well-formed inventory passes through', () => {
    expect(parseInventory([
      { source_type: 'mcp', ids: ['claude_mcp_a', 'codex_mcp_b'] },
      { source_type: 'skill', ids: [] },
    ])).toEqual([
      { sourceType: 'mcp', ids: ['claude_mcp_a', 'codex_mcp_b'] },
      { sourceType: 'skill', ids: [] },
    ]);
  });

  test('anything but a list is no inventory', () => {
    expect(parseInventory(undefined)).toEqual([]);
    expect(parseInventory({ source_type: 'mcp', ids: [] })).toEqual([]);
  });

  test('a type that is not a toolkit type is ignored', () => {
    expect(parseInventory([{ source_type: 'plan', ids: ['p1'] }, { source_type: 'session', ids: [] }])).toEqual([]);
  });

  test('an entry with one bad id is dropped whole', () => {
    expect(parseInventory([{ source_type: 'mcp', ids: ['claude_mcp_a', 42] }])).toEqual([]);
    expect(parseInventory([{ source_type: 'mcp', ids: ['claude_mcp_a', ''] }])).toEqual([]);
  });

  test('a type named twice keeps only the first entry', () => {
    expect(parseInventory([
      { source_type: 'mcp', ids: ['a'] },
      { source_type: 'mcp', ids: [] },
    ])).toEqual([{ sourceType: 'mcp', ids: ['a'] }]);
  });

  test('a list longer than the cap is refused', () => {
    const ids = Array.from({ length: 20_001 }, (_, i) => `claude_skill_${i}`);
    expect(parseInventory([{ source_type: 'skill', ids }])).toEqual([]);
  });
});
