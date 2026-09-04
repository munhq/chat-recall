import React, { useEffect, useMemo, useState } from 'react';
import { Chip, Icon, Input, Button, Plate } from './primitives';
import { getCodeFindings, type CodeFinding } from '../services/api';

/**
 * Cross-project findings worklist. Aggregates /api/code/findings across every
 * indexed repo into a severity-ranked, roll-up-by-rule list where each group is
 * actionable (copy a ready fix prompt, jump into the project). This is the real
 * destination the Command Center "critical findings" metric points at — a
 * triage queue, not a read-only dump.
 */

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEV_CHIP = (s: string): 'err' | 'warn' | 'neutral' =>
  s === 'critical' ? 'err' : s === 'high' ? 'warn' : 'neutral';

interface Group {
  key: string;
  severity: string;
  projectId: string;
  rule: string;
  category: string;
  why: string;
  items: CodeFinding[];
}

/** One prompt covering every occurrence in a group, so a repeated rule is one
 *  paste-and-go fix instead of N single-file ones. */
function groupPrompt(g: Group, projectName: string): string {
  if (g.items.length === 1) return g.items[0].agentPrompt;
  const locs = g.items.map((f) => `${f.file}${f.line != null ? `:${f.line}` : ''}`).join(', ');
  return `In ${projectName}, fix all ${g.items.length} "${g.rule}" findings (${g.category}). ${g.why} Locations: ${locs}. Show the diff for each.`;
}

export default function FindingsPanel({
  onOpenProject,
  projectNameOf,
  initialSeverity = null,
}: {
  onOpenProject: (projectId: string) => void;
  projectNameOf: (projectId: string) => string;
  initialSeverity?: string | null;
}) {
  const [findings, setFindings] = useState<CodeFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sev, setSev] = useState<string>(initialSeverity || 'critical');
  const [category, setCategory] = useState<string>('all');
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => { setSev(initialSeverity || 'critical'); }, [initialSeverity]);

  useEffect(() => {
    let on = true;
    setLoading(true); setError(null);
    getCodeFindings(undefined, { limit: 1000 })
      .then((f) => { if (on) setFindings(f); })
      .catch((e) => { if (on) setError(e instanceof Error ? e.message : 'Failed to load findings'); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, []);

  const categories = useMemo(
    () => ['all', ...Array.from(new Set(findings.map((f) => f.category))).sort()],
    [findings],
  );

  const sevCounts = useMemo(() => {
    const c: Record<string, number> = { critical: 0, high: 0, medium: 0 };
    for (const f of findings) if (f.severity in c) c[f.severity]++;
    return c;
  }, [findings]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = findings.filter((f) => {
      if (sev !== 'all' && f.severity !== sev) return false;
      if (category !== 'all' && f.category !== category) return false;
      if (q) {
        const hay = `${f.rule} ${f.file} ${f.title} ${projectNameOf(f.projectId)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const byKey = new Map<string, Group>();
    for (const f of rows) {
      const key = `${f.severity}|${f.projectId}|${f.rule}`;
      let g = byKey.get(key);
      if (!g) { g = { key, severity: f.severity, projectId: f.projectId, rule: f.rule, category: f.category, why: f.why, items: [] }; byKey.set(key, g); }
      g.items.push(f);
    }
    return Array.from(byKey.values()).sort(
      (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) || b.items.length - a.items.length,
    );
  }, [findings, sev, category, filter, projectNameOf]);

  const copyFix = (g: Group) => {
    navigator.clipboard.writeText(groupPrompt(g, projectNameOf(g.projectId)));
    setCopied(g.key);
    setTimeout(() => setCopied((c) => (c === g.key ? null : c)), 1400);
  };
  const toggle = (key: string) => setExpanded((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const sevTab = (id: string, label: string, n?: number) => (
    <button
      onClick={() => setSev(id)}
      style={{
        background: sev === id ? 'var(--cr-ink-3)' : 'transparent',
        border: '1px solid ' + (sev === id ? 'var(--cr-line-2)' : 'transparent'),
        color: sev === id ? 'var(--cr-fg-1)' : 'var(--cr-fg-2)',
        borderRadius: 0, cursor: 'pointer', padding: '5px 11px', fontSize: 12.5, fontWeight: 600,
      }}
    >
      {label}{n != null ? ` · ${n}` : ''}
    </button>
  );

  return (
    <div className="cr-pad-mobile" style={{ padding: '20px 28px 40px' }}>
      {/* Controls */}
      <div className="cr-wrap-mobile" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {sevTab('critical', 'Critical', sevCounts.critical)}
          {sevTab('high', 'High', sevCounts.high)}
          {sevTab('medium', 'Medium', sevCounts.medium)}
          {sevTab('all', 'All')}
        </div>
        <span style={{ flex: 1 }} />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={{ background: 'var(--cr-ink-2)', color: 'var(--cr-fg-1)', border: '1px solid var(--cr-line-1)', borderRadius: 0, padding: '6px 10px', fontSize: 12.5, fontFamily: 'inherit' }}
        >
          {categories.map((c) => <option key={c} value={c}>{c === 'all' ? 'All categories' : c}</option>)}
        </select>
        <Input icon="search"
          placeholder="Filter by repo, rule, file…" value={filter} onChange={(e) => setFilter(e.target.value)} onClear={filter ? () => setFilter('') : undefined} inputSize="md" style={{ minWidth: 220 }} />
      </div>

      {error && (
        <div role="alert" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', marginBottom: 14, fontSize: 13, color: 'var(--cr-err-500)', background: 'var(--cr-err-surf)', border: '1px solid var(--cr-err-line)', borderRadius: 0 }}>
          <Icon name="shield" size={14} /><span>Couldn’t load findings: {error}</span>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--cr-fg-3)', padding: '20px 0' }}>Loading findings…</div>
      ) : groups.length === 0 ? (
        <div style={{ color: 'var(--cr-fg-3)', padding: '20px 0', fontSize: 14 }}>
          {findings.length === 0 ? 'No findings — your indexed repos are clean.' : 'No findings match these filters.'}
        </div>
      ) : (
        // GAP 0 AND PLATES, NOT CARDS. Ten pixels between framed boxes is the
        // card list, and a Card carries its frame inline, so the flush rule
        // that fuses a stack cannot reach it. As plates the findings share
        // edges and read as one drawn list.
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {groups.map((g) => {
            const isOpen = expanded.has(g.key);
            const multi = g.items.length > 1;
            const first = g.items[0];
            const loc = `${first.file}${first.line != null ? `:${first.line}` : ''}`;
            return (
              <Plate key={g.key} flush style={{ overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', flexWrap: 'wrap' }}>
                  <Chip kind={SEV_CHIP(g.severity)} size="sm">{g.severity}</Chip>
                  <button onClick={() => onOpenProject(g.projectId)} title="Open this project" style={{ background: 'none', border: 'none', color: 'var(--cr-brand-500)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--cr-font-annot)', padding: 0 }}>
                    {projectNameOf(g.projectId)}
                  </button>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--cr-fg-1)' }}>{g.rule}</span>
                  <Chip kind="mono" size="sm">{g.category}</Chip>
                  {multi
                    ? <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>{g.items.length} occurrences</span>
                    : <span style={{ fontSize: 12, color: 'var(--cr-fg-3)', fontFamily: 'var(--cr-font-annot)' }}>{loc}</span>}
                  <span style={{ flex: 1 }} />
                  <Button variant="ghost" size="sm" onClick={() => copyFix(g)}>{copied === g.key ? 'copied ✓' : 'Copy fix prompt'}</Button>
                  {multi && (
                    <button onClick={() => toggle(g.key)} title="Show occurrences" style={{ background: 'none', border: '1px solid var(--cr-line-1)', borderRadius: 0, color: 'var(--cr-fg-2)', cursor: 'pointer', padding: '2px 8px', fontSize: 12 }}>{isOpen ? '−' : `⌄`}</button>
                  )}
                </div>
                <div style={{ padding: '0 14px 12px', fontSize: 12.5, color: 'var(--cr-fg-2)' }}>{g.why}</div>
                {multi && isOpen && (
                  <div style={{ borderTop: '1px solid var(--cr-line-1)', background: 'var(--cr-ink-0)', padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {g.items.map((f) => (
                      <div key={f.id} style={{ fontSize: 12, color: 'var(--cr-fg-3)', fontFamily: 'var(--cr-font-mono)' }}>
                        {f.file}{f.line != null ? `:${f.line}` : ''}{f.snippet ? <span style={{ color: 'var(--cr-fg-2)', fontFamily: 'var(--cr-font-sans)' }}> — {f.snippet}</span> : null}
                      </div>
                    ))}
                  </div>
                )}
              </Plate>
            );
          })}
        </div>
      )}
    </div>
  );
}
