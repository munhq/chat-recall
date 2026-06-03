import { describe, test, expect } from 'vitest';
import { SourceRegistry } from './source-registry.js';
import type { MemorySource, MemoryItem, MemoryChunk } from '../types/memory.js';

function fakeSource(sourceType: 'session' | 'plan', items: MemoryItem[], chunks: MemoryChunk[] = []): MemorySource {
  return {
    sourceType,
    async *discover() { for (const i of items) yield i; },
    async parse() { return chunks; },
    async extractLinks() { return []; },
  };
}

describe('SourceRegistry', () => {
  test('register + get returns first source by type', () => {
    const r = new SourceRegistry();
    const s = fakeSource('plan', []);
    r.register(s);
    expect(r.get('plan')).toBe(s);
  });

  test('multiple sources per type are queryable via getAll', () => {
    const r = new SourceRegistry();
    const a = fakeSource('session', []);
    const b = fakeSource('session', []);
    r.register(a);
    r.register(b);
    expect(r.getAll('session')).toEqual([a, b]);
    expect(r.getAll('plan')).toEqual([]);
  });

  test('getRegisteredTypes lists distinct types', () => {
    const r = new SourceRegistry();
    r.register(fakeSource('plan', []));
    r.register(fakeSource('session', []));
    r.register(fakeSource('plan', []));
    expect(new Set(r.getRegisteredTypes())).toEqual(new Set(['plan', 'session']));
  });

  test('discoverAll iterates all registered sources', async () => {
    const r = new SourceRegistry();
    r.register(fakeSource('plan', [{ id: 'p1', sourceType: 'plan', title: 'p', projectPath: '', filePath: '', mtime: 0 }]));
    r.register(fakeSource('session', [{ id: 's1', sourceType: 'session', title: 's', projectPath: '', filePath: '', mtime: 0 }]));
    const out: string[] = [];
    for await (const i of r.discoverAll()) out.push(i.id);
    expect(out.sort()).toEqual(['p1', 's1']);
  });

  test('discoverAll honors sourceTypes filter', async () => {
    const r = new SourceRegistry();
    r.register(fakeSource('plan', [{ id: 'p', sourceType: 'plan', title: '', projectPath: '', filePath: '', mtime: 0 }]));
    r.register(fakeSource('session', [{ id: 's', sourceType: 'session', title: '', projectPath: '', filePath: '', mtime: 0 }]));
    const out: string[] = [];
    for await (const i of r.discoverAll(['plan'])) out.push(i.id);
    expect(out).toEqual(['p']);
  });

  test('parse returns first non-empty result and tolerates throwing sources', async () => {
    const throwing: MemorySource = {
      sourceType: 'plan',
      async *discover() {},
      async parse() { throw new Error('boom'); },
      async extractLinks() { return []; },
    };
    const ok = fakeSource('plan', [], [{
      chunkId: 'c', itemId: 'i', sourceType: 'plan',
      title: '', text: 'x', chunkType: 'plan_section',
      projectPath: '', filePath: '', mtime: 0,
    }]);
    const r = new SourceRegistry();
    r.register(throwing);
    r.register(ok);
    const item = { id: 'i', sourceType: 'plan', title: '', projectPath: '', filePath: '', mtime: 0 } as MemoryItem;
    const chunks = await r.parse(item);
    expect(chunks).toHaveLength(1);
  });

  test('parse returns [] when no source has chunks', async () => {
    const r = new SourceRegistry();
    r.register(fakeSource('plan', [], []));
    const item = { id: 'i', sourceType: 'plan', title: '', projectPath: '', filePath: '', mtime: 0 } as MemoryItem;
    expect(await r.parse(item)).toEqual([]);
  });
});
