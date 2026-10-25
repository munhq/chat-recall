import { describe, expect, test } from 'vitest';
import { embedPolicy, embeddableChunkSql } from './embed-policy.js';

describe('embedPolicy', () => {
  test('defaults to four turns and 2000 output tokens', () => {
    expect(embedPolicy({})).toEqual({ minTurns: 4, maxTrivialOut: 2000, includeAll: false });
  });

  test('EMBED_* wins over SUMMARY_*', () => {
    const p = embedPolicy({ EMBED_MIN_TURNS: '7', SUMMARY_MIN_TURNS: '2', SUMMARY_TRIVIAL_MAX_OUTPUT_TOKENS: '50' });
    expect(p.minTurns).toBe(7);
    expect(p.maxTrivialOut).toBe(50);
  });

  test('EMBED_INCLUDE_ALL_CHUNKS turns the include-all mode on', () => {
    expect(embedPolicy({ EMBED_INCLUDE_ALL_CHUNKS: '1' }).includeAll).toBe(true);
  });
});

describe('embeddableChunkSql', () => {
  const base = { minTurns: 4, maxTrivialOut: 2000, includeAll: false };

  test('skips assistant, harness and subagent chunks and trivial sessions', () => {
    const sql = embeddableChunkSql('c', base, '$3', '$4');
    expect(sql).toContain("c.chunk_type = 'assistant'");
    expect(sql).toContain("c.chunk_type = 'harness'");
    expect(sql).toContain("c.chunk_type LIKE 'subagent%'");
    expect(sql).toContain("<= $3");
    expect(sql).toContain("< $4");
  });

  test('include-all mode keeps the chunk types and still skips trivial sessions', () => {
    const sql = embeddableChunkSql('c', { ...base, includeAll: true }, '$3', '$4');
    expect(sql).not.toContain("'assistant'");
    expect(sql).toContain("m.source_type = 'session'");
  });

  test('uses the alias and the placeholders it is given', () => {
    const sql = embeddableChunkSql('ch', base, '$7', '$8');
    expect(sql).toContain('ch.chunk_type');
    expect(sql).toContain('<= $7');
    expect(sql).toContain('< $8');
  });
});
