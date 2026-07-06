/**
 * Security view — designed around the question a security engineer
 * actually asks when they open this page:
 *
 *   "Which specific keys leaked, where do they appear, what can an
 *    attacker do with them, and how do I rotate them?"
 *
 * The page leads with an "Action Required" hero containing only
 * critical+high-severity findings, grouped per UNIQUE secret (not per
 * rule). Each card shows: redacted preview, secret type, plain-
 * English impact, blast radius (every session+line where this exact
 * key appears), detector agreement (trust signal), and a direct
 * rotation link.
 *
 * Noise-tier findings (Box matching base64, generic-api-key matching
 * UUID-like strings, JDBC matching example connection strings) are
 * collapsed by default — surfacing them on the first screen would
 * train the user to ignore the page.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Card, Chip, SegmentedControl, Button } from './primitives';
import { stripToolPrefix } from '../services/tools';
import {
  getSecretsSummary, getFlaggedSessions, getSecretsByRule, getDistinctSecrets,
  dismissSecret, undismissSecret, writeSecurityTasks,
  getCustomSecretRules, saveCustomSecretRule, deleteCustomSecretRule, testCustomSecretRule,
  getAccountRecommendations, applyAccountRecommendation,
  type SecretsSummary, type FlaggedSession, type SecretRuleRollup, type CodeRecommendation,
} from '../services/api';
// Single source of truth for secret classification — shared with the server
// (which renders SECURITY_TASKS.md from the same module).
import {
  classifySecret as classify, secretSeverityRank as severityRank,
  type SecretSeverity as Severity, type SecretType,
} from '@chat-recall/engine/core/secret-classify.js';

/** Account-level recommendations (security + behaviour) — the same actionable
 *  approach as the Code view, surfaced over chat-recall's own data. */
function AccountRecsStrip() {
  const [recs, setRecs] = useState<CodeRecommendation[]>([]);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { let on = true; getAccountRecommendations().then((r) => { if (on) setRecs(r.recommendations); }); return () => { on = false; }; }, []);
  if (!recs.length) return null;
  const apply = async (r: CodeRecommendation) => {
    setBusy(r.id);
    const res = await applyAccountRecommendation(r.id);
    setMsg((m) => ({ ...m, [r.id]: res.message || (res.ok ? 'queued' : 'failed') }));
    setBusy(null);
  };
  return (
    <div data-testid="account-recs" style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--cr-fg-2)', marginBottom: 6 }}>Recommendations</div>
      {recs.map((r) => (
        <Card key={r.id} style={{ padding: 12, marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Chip kind={r.severity === 'high' ? 'err' : r.severity === 'medium' ? 'warn' : 'neutral'} size="sm">{r.severity}</Chip>
            <strong style={{ fontSize: 13 }}>{r.title}</strong>
          </div>
          <div style={{ fontSize: 12, color: 'var(--cr-fg-2)', marginBottom: 8 }}>{r.rationale}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button variant="primary" onClick={() => apply(r)} disabled={busy === r.id}>{busy === r.id ? 'applying…' : 'Apply to global CLAUDE.md'}</Button>
            {(r.action.payload as any)?.text && <Button variant="secondary" onClick={() => navigator.clipboard.writeText(String((r.action.payload as any).text))}>Copy rule</Button>}
            {msg[r.id] && <span style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{msg[r.id]}</span>}
          </div>
        </Card>
      ))}
    </div>
  );
}

interface DistinctSecret {
  preview: string;
  rules: Array<{ detector: string; rule: string }>;
  detectors: string[];
  sessions: Array<{ sessionId: string; project: string; lines: number[] }>;
  sessionCount: number;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
  /** true = trufflehog confirmed the key is live by calling the
   *  issuing service. false = checked but unverifiable. null = no
   *  verification attempted (default). */
  verified?: boolean | null;
  dismissal?: { status: string; reason: string | null; dismissed_at: number } | null;
}

interface Props {
  onSessionClick?: (sessionId: string) => void;
  /** Scope the board to one conversation's secrets (set when arriving from a
   *  conversation's "Rotate & manage →" button). */
  focusSession?: string | null;
}

type Lens = 'action' | 'rules' | 'projects' | 'sessions' | 'config';

const SEVERITY_TONE: Record<Severity, { chip: 'err' | 'warn' | 'info' | 'neutral'; bg: string; border: string }> = {
  critical: { chip: 'err',     bg: 'rgba(255, 80, 80, 0.05)', border: 'var(--cr-err-500)' },
  high:     { chip: 'warn',    bg: 'rgba(255, 180, 0, 0.04)', border: 'var(--cr-warn-500)' },
  medium:   { chip: 'info',    bg: 'transparent',             border: 'var(--cr-line-1)' },
  noise:    { chip: 'neutral', bg: 'transparent',             border: 'var(--cr-line-1)' },
};

/* ── Utilities ──────────────────────────────────────────────────── */

function shortId(id: string): string {
  return stripToolPrefix(id).slice(0, 8);
}
function projectShort(p: string): string {
  if (!p) return '';
  const home = '/home/';
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf('/');
    if (slash > 0) return '~' + rest.slice(slash);
  }
  return p;
}
function shortRule(_d: string, rule: string): string {
  return rule.replace(/^@secretlint\/secretlint-rule-/, '');
}
function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/* ── Component ──────────────────────────────────────────────────── */

export default function SecurityExplorer({ onSessionClick, focusSession }: Props) {
  const [summary, setSummary] = useState<SecretsSummary | null>(null);
  const [rules, setRules] = useState<SecretRuleRollup[]>([]);
  const [secrets, setSecrets] = useState<DistinctSecret[]>([]);
  const [sessions, setSessions] = useState<FlaggedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>('action');
  const [showNoise, setShowNoise] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Re-fetch trigger when a dismiss/undismiss mutation happens.
  const [refreshTick, setRefreshTick] = useState(0);
  // "Write SECURITY_TASKS.md" per-project state (By project lens).
  const [taskBusy, setTaskBusy] = useState<string | null>(null);
  const [taskMsg, setTaskMsg] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    Promise.all([
      getSecretsSummary(),
      getSecretsByRule(),
      getDistinctSecrets(showDismissed),
      getFlaggedSessions(1),
    ])
      .then(([s, r, dist, f]) => {
        if (cancelled) return;
        setSummary(s);
        setRules(r.rules);
        setSecrets(dist.secrets || []);
        setSessions(f.sessions);
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [showDismissed, refreshTick]);

  // Arriving from a conversation's "Rotate & manage →": scope the board to that
  // conversation's secrets. Local state so the user can clear it ("Show all").
  const [sessionScope, setSessionScope] = useState<string | null>(null);
  useEffect(() => { if (focusSession) { setSessionScope(focusSession); setLens('action'); } }, [focusSession]);
  const inScope = (s: DistinctSecret) => !sessionScope || (s.sessions || []).some(x => x.sessionId === sessionScope);

  // Fire-and-forget dismissal: optimistic — locally tag the secret as
  // dismissed, then re-fetch on success. On failure, surface error
  // and reload to undo.
  async function handleDismiss(preview: string, status: 'rotated' | 'false_positive' | 'dismissed', reason?: string) {
    setSecrets(prev => prev.map(s => s.preview === preview ? { ...s, dismissal: { status, reason: reason || null, dismissed_at: Date.now() } } : s));
    try {
      await dismissSecret(preview, status, reason);
      setRefreshTick(t => t + 1);
    } catch (e) {
      setError((e as Error).message);
      setRefreshTick(t => t + 1);
    }
  }
  async function handleUndismiss(preview: string) {
    try {
      await undismissSecret(preview);
      setRefreshTick(t => t + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Queue SECURITY_TASKS.md for one repo — the local agent writes it into the
  // repo on next drain (same mechanism as CODE_TASKS.md).
  async function handleWriteTasks(project: string) {
    setTaskBusy(project);
    setTaskMsg(m => ({ ...m, [project]: '' }));
    try {
      const r = await writeSecurityTasks(project);
      setTaskMsg(m => ({ ...m, [project]: r.message }));
    } catch (e) {
      setTaskMsg(m => ({ ...m, [project]: (e as Error).message }));
    } finally {
      setTaskBusy(null);
    }
  }

  // For each distinct secret, classify by max-severity across its rules.
  const classifiedSecrets = useMemo(() => {
    return secrets.map(s => {
      let topType: SecretType | null = null;
      for (const r of s.rules) {
        const t = classify(r.detector, r.rule);
        if (!topType || severityRank(t.severity) < severityRank(topType.severity)) topType = t;
      }
      const type = topType || classify('', s.rules[0]?.rule || '');
      // Merge labels when multiple distinct rules but same severity.
      const allLabels = new Set(s.rules.map(r => classify(r.detector, r.rule).label));
      return { ...s, type, allLabels: [...allLabels] };
    });
  }, [secrets]);

  // Action Required = critical or high severity, sorted by:
  //   1. verified-live first (the API call confirmed it works)
  //   2. detector agreement (trust)
  //   3. blast radius (sessions count)
  const actionRequired = useMemo(() => {
    return classifiedSecrets
      .filter(s => (s.type.severity === 'critical' || s.type.severity === 'high') && inScope(s))
      .sort((a, b) =>
        Number(b.verified === true) - Number(a.verified === true) ||
        b.detectors.length - a.detectors.length ||
        b.sessionCount - a.sessionCount ||
        b.occurrences - a.occurrences,
      );
  }, [classifiedSecrets, sessionScope]);

  const reviewQueue = useMemo(() => {
    return classifiedSecrets
      .filter(s => (s.type.severity === 'medium' || (showNoise && s.type.severity === 'noise')) && inScope(s))
      .sort((a, b) => b.sessionCount - a.sessionCount || b.occurrences - a.occurrences);
  }, [classifiedSecrets, showNoise, sessionScope]);

  const noiseCount = classifiedSecrets.filter(s => s.type.severity === 'noise').length;

  // Headline metrics — count distinct secrets, broken down by severity.
  const headline = useMemo(() => {
    const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, noise: 0 };
    let sessionsHit = new Set<string>();
    for (const s of classifiedSecrets) {
      counts[s.type.severity]++;
      if (s.type.severity === 'critical' || s.type.severity === 'high') {
        for (const sess of s.sessions) sessionsHit.add(sess.sessionId);
      }
    }
    return { counts, sessionsHit: sessionsHit.size };
  }, [classifiedSecrets]);

  // Project rollup for the "By project" lens.
  const byProject = useMemo(() => {
    const out: Record<string, { sessions: Set<string>; criticalKeys: number; highKeys: number; mediumKeys: number }> = {};
    for (const s of classifiedSecrets) {
      for (const sess of s.sessions) {
        const proj = sess.project || '(unknown)';
        if (!out[proj]) out[proj] = { sessions: new Set(), criticalKeys: 0, highKeys: 0, mediumKeys: 0 };
        out[proj].sessions.add(sess.sessionId);
      }
      // Tally per-key (not per-occurrence) per project of first appearance.
      const projects = new Set(s.sessions.map(x => x.project || '(unknown)'));
      for (const p of projects) {
        if (!out[p]) out[p] = { sessions: new Set(), criticalKeys: 0, highKeys: 0, mediumKeys: 0 };
        if (s.type.severity === 'critical') out[p].criticalKeys++;
        else if (s.type.severity === 'high') out[p].highKeys++;
        else if (s.type.severity === 'medium') out[p].mediumKeys++;
      }
    }
    return Object.entries(out)
      .map(([project, v]) => ({
        project,
        sessions: v.sessions.size,
        critical: v.criticalKeys,
        high: v.highKeys,
        medium: v.mediumKeys,
        score: v.criticalKeys * 10 + v.highKeys * 3 + v.mediumKeys,
      }))
      .sort((a, b) => b.score - a.score);
  }, [classifiedSecrets]);

  function toggleExpand(preview: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(preview)) next.delete(preview);
      else next.add(preview);
      return next;
    });
  }

  return (
    <div className="cr-page-pad" style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
      <AccountRecsStrip />
      {/* ── Hero ────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--cr-fg-1)' }}>Security</h2>
          <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginTop: 2 }}>
            Per-secret analysis · raw values never leave the database
          </div>
        </div>
        <span style={{ flex: 1 }} />
        {!loading && (
          <>
            <Card style={{ padding: '10px 14px', minWidth: 130, borderLeft: '3px solid var(--cr-err-500)' }}>
              <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Critical</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--cr-err-500)' }}>{headline.counts.critical}</div>
              <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>distinct keys</div>
            </Card>
            <Card style={{ padding: '10px 14px', minWidth: 130, borderLeft: '3px solid var(--cr-warn-500)' }}>
              <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>High</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--cr-warn-500)' }}>{headline.counts.high}</div>
              <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>distinct keys</div>
            </Card>
            <Card style={{ padding: '10px 14px', minWidth: 130 }}>
              <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Sessions exposed</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--cr-fg-1)' }}>{headline.sessionsHit}</div>
              <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>contain critical or high</div>
            </Card>
            <Card style={{ padding: '10px 14px', minWidth: 110 }}>
              <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Medium</div>
              <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--cr-fg-2)' }}>{headline.counts.medium}</div>
            </Card>
            <Card style={{ padding: '10px 14px', minWidth: 110, opacity: 0.6 }}>
              <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Noise</div>
              <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--cr-fg-3)' }}>{headline.counts.noise}</div>
            </Card>
          </>
        )}
      </div>

      {error && (
        <Card style={{ padding: 14, marginBottom: 12, borderColor: 'var(--cr-err-500)' }}>
          <span style={{ color: 'var(--cr-err-500)' }}>Error: {error}</span>
        </Card>
      )}

      <Card style={{ padding: 12, marginBottom: 14, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <SegmentedControl
          options={[
            { value: 'action', label: 'Action required' },
            { value: 'rules', label: 'By rule' },
            { value: 'projects', label: 'By project' },
            { value: 'sessions', label: 'By session' },
            { value: 'config', label: 'Custom rules' },
          ]}
          value={lens}
          onChange={(v) => setLens(v as Lens)}
          size="sm"
        />
        <span style={{ flex: 1 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--cr-fg-3)' }}>
          <input
            type="checkbox"
            checked={showDismissed}
            onChange={(e) => setShowDismissed(e.target.checked)}
          />
          Show resolved
        </label>
      </Card>

      {loading && <div style={{ color: 'var(--cr-fg-3)', fontSize: 13, padding: 16 }}>Loading…</div>}

      {/* Scope banner — arrived from a conversation's "Rotate & manage →". */}
      {sessionScope && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px', borderRadius: 'var(--cr-radius-md)', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-2)', fontSize: 13, color: 'var(--cr-fg-2)' }}>
          <span>Scoped to <b style={{ color: 'var(--cr-fg-1)' }}>one conversation</b>'s secrets.</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => setSessionScope(null)}
            style={{ background: 'transparent', border: '1px solid var(--cr-line-2)', color: 'var(--cr-fg-2)', borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
            Show all secrets
          </button>
        </div>
      )}

      {/* ── ACTION REQUIRED ─────────────────────────────────────── */}
      {!loading && lens === 'action' && (
        <>
          {actionRequired.length === 0 && (
            <Card style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>
              <div style={{ fontSize: 14, marginBottom: 6, color: 'var(--cr-ok-500)' }}>
                ✓ No critical or high-severity secrets detected
              </div>
              <div style={{ fontSize: 12 }}>
                Findings populate from the collector. Run <code>chat-recall sync</code> on the
                machine where your sessions live — secrets are scanned and masked client-side,
                then shipped here.
              </div>
            </Card>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {actionRequired.map(s => {
              const tone = SEVERITY_TONE[s.type.severity];
              const isOpen = expanded.has(s.preview);
              return (
                <Card
                  key={s.preview}
                  style={{
                    padding: 14,
                    background: tone.bg,
                    borderLeft: `4px solid ${tone.border}`,
                  }}
                >
                  {/* Header row: glyph + label + preview + chips */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 22 }} aria-hidden>{s.type.glyph}</span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--cr-fg-1)' }}>
                        {s.type.label}
                      </span>
                      <span style={{ fontSize: 11, fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-3)', wordBreak: 'break-all', overflowWrap: 'anywhere', maxWidth: '100%' }}>
                        {s.preview}
                      </span>
                    </div>
                    <span style={{ flex: 1 }} />
                    <Chip kind={tone.chip} size="sm">
                      {s.type.severity.toUpperCase()}
                    </Chip>
                    {s.verified === true && (
                      // Trufflehog confirmed this key is currently live
                      // by calling the issuing service. The strongest
                      // possible signal: rotate this NOW.
                      <Chip kind="err" size="sm">🔴 LIVE — verified</Chip>
                    )}
                    <Chip kind={s.detectors.length >= 2 ? 'err' : 'warn'} size="sm">
                      {s.detectors.length === 1 ? '1 detector' : `${s.detectors.length} agree`}
                    </Chip>
                    <Chip kind="neutral" size="sm">
                      {s.sessionCount} session{s.sessionCount === 1 ? '' : 's'}
                    </Chip>
                    {s.dismissal && (
                      <Chip kind="ok" size="sm">
                        {s.dismissal.status === 'rotated' ? '✓ Rotated' :
                         s.dismissal.status === 'false_positive' ? 'Not a secret' :
                         'Dismissed'}
                      </Chip>
                    )}
                  </div>

                  {/* Impact line */}
                  <div style={{ marginTop: 10, fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.45 }}>
                    {s.type.impact}
                  </div>

                  {/* Meta row */}
                  <div style={{ marginTop: 10, display: 'flex', gap: 14, fontSize: 11, color: 'var(--cr-fg-3)', flexWrap: 'wrap' }}>
                    <span>First seen <strong style={{ color: 'var(--cr-fg-2)' }}>{timeAgo(s.firstSeen)}</strong></span>
                    <span>Last seen <strong style={{ color: 'var(--cr-fg-2)' }}>{timeAgo(s.lastSeen)}</strong></span>
                    <span>{s.occurrences} occurrence{s.occurrences === 1 ? '' : 's'}</span>
                    <span>Detectors: {s.detectors.join(' · ')}</span>
                    <span style={{ flex: 1 }} />
                    {s.type.rotateUrl && (
                      <a
                        href={s.type.rotateUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--cr-brand-500)', fontWeight: 600, textDecoration: 'none' }}
                      >
                        Rotate ↗
                      </a>
                    )}
                    {/* Mark-rotated: closes out the finding once the user
                        has cycled the key on the issuer side. The leak
                        in our index is now a record of a past secret,
                        not a live threat. */}
                    {!s.dismissal && (
                      <button
                        onClick={() => handleDismiss(s.preview, 'rotated', 'rotated by user')}
                        style={{ background: 'transparent', border: 0, padding: 0, color: 'var(--cr-ok-500)', fontWeight: 600, cursor: 'pointer' }}
                        title="I've rotated this key on the issuer side"
                      >
                        ✓ Mark rotated
                      </button>
                    )}
                    {!s.dismissal && (
                      <button
                        onClick={() => handleDismiss(s.preview, 'false_positive', 'flagged as FP by user')}
                        style={{ background: 'transparent', border: 0, padding: 0, color: 'var(--cr-fg-3)', fontWeight: 600, cursor: 'pointer' }}
                        title="This isn't a real secret"
                      >
                        Not a secret
                      </button>
                    )}
                    {s.dismissal && (
                      <button
                        onClick={() => handleUndismiss(s.preview)}
                        style={{ background: 'transparent', border: 0, padding: 0, color: 'var(--cr-warn-500)', fontWeight: 600, cursor: 'pointer' }}
                      >
                        ↶ Undo {s.dismissal.status}
                      </button>
                    )}
                    <button
                      onClick={() => toggleExpand(s.preview)}
                      style={{ background: 'transparent', border: 0, padding: 0, color: 'var(--cr-brand-500)', fontWeight: 600, cursor: 'pointer' }}
                    >
                      {isOpen ? 'Hide locations' : `Show ${s.sessionCount} location${s.sessionCount === 1 ? '' : 's'}`}
                    </button>
                  </div>

                  {/* Blast radius — sessions+lines */}
                  {isOpen && (
                    <div style={{ marginTop: 12, padding: 10, background: 'var(--cr-ink-2)', borderRadius: 4 }}>
                      <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                        Blast radius
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {s.sessions.map(sess => (
                          <div key={sess.sessionId} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12 }}>
                            <button
                              onClick={() => onSessionClick?.(sess.sessionId)}
                              style={{
                                background: 'transparent', border: 0, padding: 0,
                                color: 'var(--cr-brand-500)', cursor: 'pointer',
                                fontFamily: 'var(--cr-font-mono)', fontSize: 12,
                                textDecoration: 'underline', minWidth: 90, textAlign: 'left',
                              }}
                            >
                              {shortId(sess.sessionId)}
                            </button>
                            <span style={{ color: 'var(--cr-fg-3)', flex: 1, fontFamily: 'var(--cr-font-mono)', wordBreak: 'break-all' }}>
                              {projectShort(sess.project)}
                            </span>
                            <span style={{ color: 'var(--cr-fg-3)', fontFamily: 'var(--cr-font-mono)', fontSize: 11 }}>
                              {sess.lines.length === 1 ? `L${sess.lines[0]}` : `${sess.lines.length} lines`}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          {/* Review queue — medium severity */}
          {reviewQueue.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--cr-fg-2)' }}>Review queue</span>
                <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
                  {reviewQueue.length} item{reviewQueue.length === 1 ? '' : 's'} — verify whether each is a real credential
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {reviewQueue.slice(0, 30).map(s => (
                  <Card key={s.preview} style={{ padding: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 16 }}>{s.type.glyph}</span>
                      <span style={{ fontWeight: 600, color: 'var(--cr-fg-1)' }}>{s.type.label}</span>
                      <span style={{ fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-3)' }}>{s.preview}</span>
                      <Chip kind={SEVERITY_TONE[s.type.severity].chip} size="sm">{s.type.severity}</Chip>
                      <span style={{ flex: 1 }} />
                      <span style={{ color: 'var(--cr-fg-3)' }}>{s.sessionCount} sess · {s.occurrences} occ</span>
                      {s.sessions[0] && (
                        <button
                          onClick={() => onSessionClick?.(s.sessions[0].sessionId)}
                          style={{ background: 'transparent', border: 0, padding: 0, color: 'var(--cr-brand-500)', cursor: 'pointer', fontFamily: 'var(--cr-font-mono)', fontSize: 11 }}
                        >
                          {shortId(s.sessions[0].sessionId)} →
                        </button>
                      )}
                    </div>
                  </Card>
                ))}
                {reviewQueue.length > 30 && (
                  <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', textAlign: 'center', padding: 8 }}>
                    +{reviewQueue.length - 30} more medium-severity items
                  </div>
                )}
              </div>
            </div>
          )}

          {noiseCount > 0 && (
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--cr-fg-3)' }}>
              <button
                onClick={() => setShowNoise(v => !v)}
                style={{ background: 'transparent', border: 0, padding: 0, color: 'var(--cr-brand-500)', cursor: 'pointer', fontWeight: 600 }}
              >
                {showNoise ? 'Hide' : 'Show'} {noiseCount} noise-tier finding{noiseCount === 1 ? '' : 's'}
              </button>
              <span style={{ marginLeft: 8 }}>
                ({noiseCount} fuzzy-detector matches likely false positives — UUIDs, base64 blobs, hashes)
              </span>
            </div>
          )}
        </>
      )}

      {/* ── BY RULE ─────────────────────────────────────────────── */}
      {!loading && lens === 'rules' && (
        <Card style={{ padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--cr-ink-2)' }}>
                <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Rule</th>
                <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Detector</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Distinct</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Total</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Sessions</th>
              </tr>
            </thead>
            <tbody>
              {rules.slice(0, 40).map((r, i) => {
                const t = classify(r.detector, r.rule);
                return (
                  <tr key={`${r.detector}:${r.rule}`} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--cr-line-1)' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-2)' }}>
                      <span style={{ marginRight: 6 }}>{t.glyph}</span>
                      {shortRule(r.detector, r.rule)}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <Chip kind="neutral" size="sm">{r.detector}</Chip>
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--cr-err-500)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{r.distinctSecrets.toLocaleString()}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--cr-fg-2)', fontVariantNumeric: 'tabular-nums' }}>{r.occurrences.toLocaleString()}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--cr-fg-3)', fontVariantNumeric: 'tabular-nums' }}>{r.sessions}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* ── BY PROJECT ──────────────────────────────────────────── */}
      {!loading && lens === 'projects' && (
        <Card style={{ padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--cr-ink-2)' }}>
                <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Project</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Critical keys</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>High keys</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Medium keys</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Sessions</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Rotation checklist</th>
              </tr>
            </thead>
            <tbody>
              {byProject.map((p, i) => {
                const realPath = p.project && p.project !== '(unknown)';
                return (
                <tr key={p.project} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--cr-line-1)' }}>
                  <td style={{ padding: '8px 12px', fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-2)', wordBreak: 'break-all' }}>{projectShort(p.project)}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', color: p.critical > 0 ? 'var(--cr-err-500)' : 'var(--cr-fg-3)', fontVariantNumeric: 'tabular-nums', fontWeight: p.critical > 0 ? 700 : 400 }}>{p.critical}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', color: p.high > 0 ? 'var(--cr-warn-500)' : 'var(--cr-fg-3)', fontVariantNumeric: 'tabular-nums', fontWeight: p.high > 0 ? 600 : 400 }}>{p.high}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--cr-fg-2)', fontVariantNumeric: 'tabular-nums' }}>{p.medium}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--cr-fg-3)', fontVariantNumeric: 'tabular-nums' }}>{p.sessions}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                    {realPath ? (
                      <>
                        <button
                          onClick={() => handleWriteTasks(p.project)}
                          disabled={taskBusy === p.project}
                          title="Write SECURITY_TASKS.md into this repo — a per-secret rotation checklist your AI can act on and tick off"
                          style={{ background: 'transparent', border: '1px solid var(--cr-line-2)', color: 'var(--cr-brand-500)', borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: taskBusy === p.project ? 'default' : 'pointer', fontFamily: 'inherit', fontWeight: 600, whiteSpace: 'nowrap' }}
                        >
                          {taskBusy === p.project ? 'queuing…' : 'Write SECURITY_TASKS.md →'}
                        </button>
                        {taskMsg[p.project] && (
                          <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 4, maxWidth: 320, marginLeft: 'auto', textAlign: 'right', lineHeight: 1.4 }}>
                            {taskMsg[p.project]}
                          </div>
                        )}
                      </>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--cr-fg-4, var(--cr-fg-3))' }}>—</span>
                    )}
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* ── CUSTOM RULES (CRUD) ─────────────────────────────────── */}
      {!loading && lens === 'config' && (
        <CustomRulesPanel onChanged={() => setRefreshTick(t => t + 1)} />
      )}

      {/* ── BY SESSION ──────────────────────────────────────────── */}
      {!loading && lens === 'sessions' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sessions.map(s => {
            const tone: 'err' | 'warn' = s.agreement >= 2 ? 'err' : 'warn';
            return (
              <Card
                key={s.sessionId}
                style={{ padding: 12, borderLeft: `3px solid var(--cr-${tone}-500)`, cursor: onSessionClick ? 'pointer' : 'default' }}
                onClick={() => onSessionClick?.(s.sessionId)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <Chip kind={tone} size="sm">{s.agreement === 1 ? '1 detector' : `${s.agreement} agree`}</Chip>
                  <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 12, color: 'var(--cr-brand-500)' }}>{shortId(s.sessionId)}</span>
                  <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>{projectShort(s.project)}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{s.total.toLocaleString()} findings</span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  {Object.entries(s.detectors).map(([d, n]) => (
                    <Chip key={d} kind="neutral" size="sm">{d} {n}</Chip>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Custom-rules CRUD panel ──────────────────────────────────── */

type TenantRule = import('../services/api').CustomSecretRule;

function CustomRulesPanel({ onChanged }: { onChanged: () => void }) {
  const [rules, setRules] = useState<TenantRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<TenantRule> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testSample, setTestSample] = useState('');
  const [testRegex, setTestRegex] = useState('');
  const [testResult, setTestResult] = useState<{ count: number; matches: Array<{ match: string; index: number }> } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const j = await getCustomSecretRules();
      setRules(j.rules || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  async function save() {
    if (!editing?.name || !editing?.regex || !editing?.severity) {
      setError('name, regex, severity are required');
      return;
    }
    try {
      const res = await saveCustomSecretRule(editing);
      if (!res.ok) { setError(res.error || 'save failed'); return; }
      setEditing(null);
      setError(null);
      await reload();
      onChanged();
    } catch (e) { setError((e as Error).message); }
  }
  async function remove(id: number) {
    if (!confirm('Delete this rule? Existing findings stay; future scans will not match this pattern.')) return;
    await deleteCustomSecretRule(id);
    await reload();
    onChanged();
  }
  async function runTest() {
    if (!testRegex || !testSample) return;
    setTestError(null);
    try {
      const res = await testCustomSecretRule(testSample, testRegex);
      if (!res.ok) { setTestError(res.error); setTestResult(null); return; }
      setTestResult({ count: res.count, matches: res.matches });
    } catch (e) { setTestError((e as Error).message); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card style={{ padding: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.5 }}>
          Patterns added here run alongside the built-in detectors. Each rule is a regex
          matched against the raw session text. Use this for internal API key shapes,
          custom token prefixes, or hostnames you don't want pasted into AI sessions.
        </div>
      </Card>

      {/* List */}
      <Card style={{ padding: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--cr-ink-2)' }}>
              <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Name</th>
              <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Regex</th>
              <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Severity</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {!loading && rules.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 18, textAlign: 'center', color: 'var(--cr-fg-3)' }}>No custom rules yet.</td></tr>
            )}
            {rules.map((r, i) => (
              <tr key={r.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--cr-line-1)' }}>
                <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--cr-fg-1)' }}>{r.name}</td>
                <td style={{ padding: '8px 12px', fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-2)', wordBreak: 'break-all', maxWidth: 320 }}>{r.regex}</td>
                <td style={{ padding: '8px 12px' }}>
                  <Chip kind={r.severity === 'critical' ? 'err' : r.severity === 'high' ? 'warn' : 'info'} size="sm">
                    {r.severity}
                  </Chip>
                  {!r.enabled && <Chip kind="neutral" size="sm" style={{ marginLeft: 6 }}>disabled</Chip>}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                  <button onClick={() => setEditing(r)} style={{ background: 'transparent', border: 0, color: 'var(--cr-brand-500)', cursor: 'pointer', marginRight: 8, fontWeight: 600 }}>Edit</button>
                  <button onClick={() => remove(r.id)} style={{ background: 'transparent', border: 0, color: 'var(--cr-err-500)', cursor: 'pointer', fontWeight: 600 }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {!editing && (
        <Card style={{ padding: 14 }}>
          <button
            onClick={() => setEditing({ name: '', regex: '', severity: 'high', enabled: 1 })}
            style={{ background: 'var(--cr-brand-500)', color: '#fff', border: 0, padding: '8px 14px', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}
          >
            + Add rule
          </button>
        </Card>
      )}

      {/* Edit form */}
      {editing && (
        <Card style={{ padding: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, color: 'var(--cr-fg-1)' }}>
            {editing.id ? 'Edit rule' : 'New rule'}
          </div>
          {error && <div style={{ color: 'var(--cr-err-500)', fontSize: 12, marginBottom: 8 }}>{error}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
              Name
              <input
                value={editing.name || ''}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="acme-internal"
                style={{ display: 'block', marginTop: 4, width: '100%', padding: '8px 10px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 4, color: 'var(--cr-fg-1)', fontFamily: 'var(--cr-font-mono)' }}
              />
            </label>
            <label style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
              Regex
              <input
                value={editing.regex || ''}
                onChange={(e) => setEditing({ ...editing, regex: e.target.value })}
                placeholder="acme_(?:live|test)_[a-zA-Z0-9]{32}"
                style={{ display: 'block', marginTop: 4, width: '100%', padding: '8px 10px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 4, color: 'var(--cr-fg-1)', fontFamily: 'var(--cr-font-mono)' }}
              />
            </label>
            <label style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
              Severity
              <select
                value={editing.severity || 'high'}
                onChange={(e) => setEditing({ ...editing, severity: e.target.value as TenantRule['severity'] })}
                style={{ display: 'block', marginTop: 4, padding: '6px 10px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 4, color: 'var(--cr-fg-1)' }}
              >
                <option value="critical">critical</option>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
              Description (optional)
              <input
                value={editing.description || ''}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                placeholder="What this matches and why it matters"
                style={{ display: 'block', marginTop: 4, width: '100%', padding: '8px 10px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 4, color: 'var(--cr-fg-1)' }}
              />
            </label>
            <label style={{ fontSize: 12, color: 'var(--cr-fg-3)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={!!editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked ? 1 : 0 })}
              />
              Enabled
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={save} style={{ background: 'var(--cr-brand-500)', color: '#fff', border: 0, padding: '8px 14px', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}>Save</button>
              <button onClick={() => { setEditing(null); setError(null); }} style={{ background: 'transparent', color: 'var(--cr-fg-2)', border: '1px solid var(--cr-line-1)', padding: '8px 14px', borderRadius: 4, cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        </Card>
      )}

      {/* Test sandbox — paste sample text + regex, see what matches without saving */}
      <Card style={{ padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--cr-fg-1)' }}>Test sandbox</div>
        <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginBottom: 10 }}>
          Paste a sample and a regex to see what would match — useful for catching backwards regexes before saving.
        </div>
        <textarea
          value={testSample}
          onChange={(e) => setTestSample(e.target.value)}
          placeholder="Sample text to search…"
          rows={3}
          style={{ width: '100%', padding: '8px 10px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 4, color: 'var(--cr-fg-1)', fontFamily: 'var(--cr-font-mono)', fontSize: 12, marginBottom: 8 }}
        />
        <input
          value={testRegex}
          onChange={(e) => setTestRegex(e.target.value)}
          placeholder="acme_(?:live|test)_[a-zA-Z0-9]{32}"
          style={{ width: '100%', padding: '8px 10px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 4, color: 'var(--cr-fg-1)', fontFamily: 'var(--cr-font-mono)', fontSize: 12, marginBottom: 8 }}
        />
        <button onClick={runTest} style={{ background: 'var(--cr-fg-2)', color: 'var(--cr-ink-1)', border: 0, padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}>Test</button>
        {testError && <div style={{ color: 'var(--cr-err-500)', marginTop: 8, fontSize: 12 }}>{testError}</div>}
        {testResult && (
          <div style={{ marginTop: 10, padding: 10, background: 'var(--cr-ink-2)', borderRadius: 4 }}>
            <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginBottom: 6 }}>
              {testResult.count} match{testResult.count === 1 ? '' : 'es'}
            </div>
            {testResult.matches.map((m, i) => (
              <div key={i} style={{ fontSize: 11, fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-2)' }}>
                @{m.index}: <span style={{ background: 'var(--cr-warn-500)', color: '#000', padding: '0 4px' }}>{m.match}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
