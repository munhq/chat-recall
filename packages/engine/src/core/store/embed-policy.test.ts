import { describe, expect, test } from 'vitest';
import { embedPolicy, embeddableChunkFlagSql, trivialSessionPredicateSql } from './embed-policy.js';

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

describe('embeddableChunkFlagSql', () => {
  const base = { minTurns: 4, maxTrivialOut: 2000, includeAll: false };

  test('skips assistant, harness and subagent chunks and flagged trivial chunks', () => {
    const sql = embeddableChunkFlagSql('c', base);
    expect(sql).toContain("c.chunk_type = 'assistant'");
    expect(sql).toContain("c.chunk_type = 'harness'");
    expect(sql).toContain("c.chunk_type LIKE 'subagent%'");
    // The trivial decision is the row's own flag, not a per-chunk EXISTS.
    expect(sql).toContain('NOT c.trivial');
    expect(sql).not.toContain('memory_metadata');
  });

  test('include-all mode keeps the chunk types and still skips trivial chunks', () => {
    const sql = embeddableChunkFlagSql('c', { ...base, includeAll: true });
    expect(sql).not.toContain("'assistant'");
    expect(sql).toContain('NOT c.trivial');
  });

  test('uses the alias it is given', () => {
    const sql = embeddableChunkFlagSql('ch', base);
    expect(sql).toContain('ch.chunk_type');
    expect(sql).toContain('NOT ch.trivial');
  });
});

describe('trivialSessionPredicateSql', () => {
  test('reads messageCount/outputTokens from extra_json with the given placeholders', () => {
    const sql = trivialSessionPredicateSql('m', '$3', '$4');
    expect(sql).toContain("m.extra_json LIKE '{%'");
    expect(sql).toContain("m.extra_json::jsonb ->> 'messageCount'");
    expect(sql).toContain("m.extra_json::jsonb ->> 'outputTokens'");
    expect(sql).toContain('<= $3');
    expect(sql).toContain('< $4');
  });

  test('uses the alias and the placeholders it is given', () => {
    const sql = trivialSessionPredicateSql('meta', '$7', '$8');
    expect(sql).toContain('meta.extra_json');
    expect(sql).toContain('<= $7');
    expect(sql).toContain('< $8');
  });
});
