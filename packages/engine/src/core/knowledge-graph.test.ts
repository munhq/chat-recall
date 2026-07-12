import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { KnowledgeGraph } from './knowledge-graph.js';

let kg: KnowledgeGraph;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kg-'));
  kg = new KnowledgeGraph(join(tmp, 'kg.db'));
});
afterEach(() => {
  kg.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('KnowledgeGraph', () => {
  test('addTriple inserts a fact and queryEntity returns it', () => {
    kg.addTriple('chat-recall', 'uses', 'sqlite');
    const facts = kg.queryEntity('chat-recall');
    expect(facts.find(f => f.predicate === 'uses' && f.object === 'sqlite')).toBeDefined();
  });

  test('addTriple with validFrom records temporal start', () => {
    kg.addTriple('chat-recall', 'uses', 'sqlite', { validFrom: '2026-01-01' });
    const facts = kg.queryEntity('chat-recall');
    const f = facts.find(x => x.predicate === 'uses' && x.object === 'sqlite');
    // The KG returns valid_from snake_case in KGQueryResult.
    expect(f?.valid_from?.slice(0, 10)).toBe('2026-01-01');
  });

  test('invalidate marks a fact ended on a given date', () => {
    kg.addTriple('chat-recall', 'uses', 'lance');
    kg.invalidate('chat-recall', 'uses', 'lance', '2026-04-01');
    // queryEntity at a date AFTER end should not return the fact.
    const after = kg.queryEntity('chat-recall', '2026-05-01');
    expect(after.find(f => f.predicate === 'uses' && f.object === 'lance')).toBeUndefined();
  });

  test('queryEntity asOf returns facts valid at that date', () => {
    kg.addTriple('alice', 'works_on', 'project-a', { validFrom: '2026-01-01' });
    kg.invalidate('alice', 'works_on', 'project-a', '2026-03-01');
    kg.addTriple('alice', 'works_on', 'project-b', { validFrom: '2026-03-15' });

    const feb = kg.queryEntity('alice', '2026-02-15');
    expect(feb.find(f => f.object === 'project-a')).toBeDefined();
    expect(feb.find(f => f.object === 'project-b')).toBeUndefined();

    const apr = kg.queryEntity('alice', '2026-04-15');
    expect(apr.find(f => f.object === 'project-a')).toBeUndefined();
    expect(apr.find(f => f.object === 'project-b')).toBeDefined();
  });

  test('KG2: stamped valid_from makes as_of time-travel exclude future facts', () => {
    kg.addTriple('proj', 'uses', 'redis', { validFrom: '2026-03-01' });
    // Before the fact was true → not returned (previously auto-facts had NULL
    // valid_from and matched every date).
    expect(kg.queryEntity('proj', '2026-01-01').find(f => f.object === 'redis')).toBeUndefined();
    // At/after → returned.
    expect(kg.queryEntity('proj', '2026-04-01').find(f => f.object === 'redis')).toBeDefined();
  });

  test('KG5: a full ISO timestamp validFrom is normalized to date-only', () => {
    kg.addTriple('proj2', 'uses', 'kafka', { validFrom: '2026-06-15T10:30:00Z' });
    const f = kg.queryEntity('proj2').find(x => x.object === 'kafka');
    expect(f?.valid_from).toBe('2026-06-15');
  });

  test('KG3: origin distinguishes asserted from extracted facts', () => {
    kg.addTriple('me', 'prefers', 'tabs', { origin: 'asserted' });
    kg.addTriple('me', 'prefers', 'spaces'); // default extracted
    const tl = kg.timeline('me');
    expect(tl.find(f => f.object === 'tabs')?.origin).toBe('asserted');
    expect(tl.find(f => f.object === 'spaces')?.origin).toBe('extracted');
  });

  test('supersede invalidates a contradictory current fact', () => {
    kg.addTriple('svc', 'defaults_to', 'lancedb');
    // New value for the same (subject, predicate) with supersede → old one ends.
    kg.addTriple('svc', 'defaults_to', 'postgres', { supersede: true, validFrom: '2026-05-01' });
    const current = kg.queryEntity('svc');
    const active = current.filter(f => f.predicate === 'defaults_to' && !f.valid_to);
    expect(active).toHaveLength(1);
    expect(active[0].object).toBe('postgres');
  });

  test('without supersede, both values stay current (multi-valued facts)', () => {
    kg.addTriple('proj', 'uses', 'redis');
    kg.addTriple('proj', 'uses', 'postgres');
    const active = kg.queryEntity('proj').filter(f => f.predicate === 'uses' && !f.valid_to);
    expect(active).toHaveLength(2);
  });

  test('stats reports entity + triple counts', () => {
    kg.addTriple('a', 'uses', 'b');
    kg.addTriple('a', 'uses', 'c');
    const s = kg.stats();
    expect(s.entities).toBeGreaterThanOrEqual(3); // a, b, c
    expect(s.triples).toBeGreaterThanOrEqual(2);
    expect(s.current_facts).toBeGreaterThanOrEqual(2);
  });

  test('listEntities returns entities up to limit', () => {
    for (const n of ['x', 'y', 'z']) kg.addEntity(n, 'tool');
    const entities = kg.listEntities(2);
    expect(entities.length).toBe(2);
  });

  test('timeline returns chronological entries', () => {
    kg.addTriple('a', 'uses', 'b', { validFrom: '2026-01-01' });
    kg.addTriple('a', 'uses', 'c', { validFrom: '2026-02-01' });
    const t = kg.timeline('a');
    expect(t.length).toBeGreaterThanOrEqual(2);
  });

  test('queryRelationship filters by predicate', () => {
    kg.addTriple('a', 'uses', 'b');
    kg.addTriple('a', 'works_on', 'c');
    const usesOnly = kg.queryRelationship('uses');
    expect(usesOnly.every(r => r.predicate === 'uses')).toBe(true);
  });
});
