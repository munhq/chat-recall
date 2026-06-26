import { describe, test, expect } from 'vitest';
import { buildRecommendations, buildAccountRecommendations, type RecommendationInput } from './recommendations.js';
import type { CodeProjectInput, CodeFindingInput, CodeFindingsSummary } from '../../types/code-intel.js';

function project(over: Partial<CodeProjectInput> = {}): CodeProjectInput {
  return {
    projectId: 'p', rootPath: '/p', fileCount: 100, symbolCount: 1000,
    langs: { typescript: 80, css: 20 },
    health: { score: 50, findings: 0, critical: 0, high: 0, medium: 0, low: 0, hotspots: 0, aiAuthoredPct: 0 },
    map: { nodes: [], edges: [], buckets: { god_modules: [], stable_cores: [], unstable_drivers: [], islands: [], cycles: [] } },
    lastIndexedAt: 1, ...over,
  };
}
const summary = (over: Partial<CodeFindingsSummary> = {}): CodeFindingsSummary => ({
  total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {}, ...over,
});
const base: RecommendationInput = { project: project(), summary: summary(), findings: [], hotspots: [] };
const kinds = (recs: ReturnType<typeof buildRecommendations>) => recs.map((r) => r.id.split('_').slice(0, 1).join('') + ':' + r.kind);

describe('buildRecommendations', () => {
  test('clean project yields no recommendations', () => {
    expect(buildRecommendations(base).length).toBe(0);
  });

  test('critical security finding → high-severity no-hardcoded-secrets rule', () => {
    const findings: CodeFindingInput[] = [{ category: 'security', severity: 'critical', file: 'a.ts', line: 1, rule: 'hardcoded_secret_assignment', title: 'secret' }];
    const recs = buildRecommendations({ ...base, findings, summary: summary({ bySeverity: { critical: 1, high: 0, medium: 0, low: 0, info: 0 } }) });
    const sec = recs.find((r) => r.action.type === 'append_claude_md' && /secret/i.test(r.title));
    expect(sec).toBeTruthy();
    expect(sec!.severity).toBe('high');
    expect(String(sec!.action.payload.text)).toMatch(/never hardcode/i);
  });

  test('duplication ≥3 → reuse rule', () => {
    const recs = buildRecommendations({ ...base, summary: summary({ byCategory: { duplication: 2, clone: 2 } }), findings: [
      { category: 'duplication', severity: 'low', file: 'x', line: null, rule: 'reinvention', title: 'foo ×5' },
    ] });
    expect(recs.some((r) => /reuse/i.test(r.title))).toBe(true);
  });

  test('AI-authored + hotspots → engineering label', () => {
    const recs = buildRecommendations({
      ...base,
      project: project({ health: { ...project().health, aiAuthoredPct: 0.7 } }),
      hotspots: [
        { file: 'a', churn: 10, complexity: 20, score: 200, aiAuthored: true, lines: 100 },
        { file: 'b', churn: 8, complexity: 15, score: 120, aiAuthored: true, lines: 80 },
        { file: 'c', churn: 5, complexity: 12, score: 60, aiAuthored: false, lines: 50 },
      ],
    });
    const lab = recs.find((r) => r.kind === 'label');
    expect(lab?.action.type).toBe('set_label');
    expect(lab?.action.payload.label).toBe('engineering');
  });

  test('POC label → reset-db recommendation', () => {
    const recs = buildRecommendations({ ...base, project: project({ label: 'poc' }) });
    expect(recs.some((r) => r.kind === 'reset' && r.action.type === 'reset_db')).toBe(true);
  });

  test('frontend-heavy → install frontend-design skill', () => {
    const recs = buildRecommendations({ ...base, project: project({ langs: { tsx: 30, css: 10, typescript: 20 } }) });
    const sk = recs.find((r) => r.kind === 'skill');
    expect(sk?.action.payload.skill).toBe('frontend-design');
  });

  test('cycles → review recommendation', () => {
    const recs = buildRecommendations({ ...base, project: project({ map: { nodes: [], edges: [], buckets: { god_modules: [], stable_cores: [], unstable_drivers: [], islands: [], cycles: [['a', 'b', 'c']] } } }) });
    expect(recs.some((r) => r.kind === 'review' && r.action.type === 'open_findings')).toBe(true);
  });

  test('behavioral: high failed/abandoned rate → definition-of-done rule', () => {
    const recs = buildRecommendations({ ...base, behavior: { failedOrAbandoned: 3, totalSessions: 6 } });
    expect(recs.some((r) => /definition of done/i.test(r.title))).toBe(true);
  });

  test('behavioral: recurring correction captured verbatim as a rule', () => {
    const recs = buildRecommendations({ ...base, behavior: { failedOrAbandoned: 0, totalSessions: 2, topCorrections: ['always run the tests before saying done'] } });
    const cap = recs.find((r) => /recurring correction/i.test(r.title));
    expect(cap).toBeTruthy();
    expect(String(cap!.action.payload.text)).toMatch(/run the tests/i);
  });

  test('deterministic ids — same inputs, same ids', () => {
    const a = buildRecommendations({ ...base, project: project({ label: 'poc' }) });
    const b = buildRecommendations({ ...base, project: project({ label: 'poc' }) });
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });
});

describe('buildAccountRecommendations (chat-recall own data)', () => {
  test('no signal → no recommendations', () => {
    expect(buildAccountRecommendations({ leakedSecrets: 0, distinctSecretRules: [] }).length).toBe(0);
  });
  test('leaked secrets → high rotate+rule recommendation (global)', () => {
    const recs = buildAccountRecommendations({ leakedSecrets: 3, distinctSecretRules: ['aws_access_key', 'stripe_live_key'] });
    const r = recs.find((x) => /rotate/i.test(x.title));
    expect(r?.severity).toBe('high');
    expect(r?.action.type).toBe('append_claude_md');
    expect((r?.action.payload as any).global).toBe(true);
    expect(r?.evidence).toContain('aws_access_key');
  });
  test('high unresolved-session rate → global definition-of-done rule', () => {
    const recs = buildAccountRecommendations({ leakedSecrets: 0, distinctSecretRules: [], behavior: { failedOrAbandoned: 4, totalSessions: 8 } });
    expect(recs.some((r) => /definition of done/i.test(r.title) && (r.action.payload as any).global)).toBe(true);
  });
  test('healthy behaviour → no DoD rec', () => {
    const recs = buildAccountRecommendations({ leakedSecrets: 0, distinctSecretRules: [], behavior: { failedOrAbandoned: 1, totalSessions: 20 } });
    expect(recs.length).toBe(0);
  });
});
