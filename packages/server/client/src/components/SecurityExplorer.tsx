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
import { Card, Chip, SegmentedControl, Button, Icon, Schedule, Note, Plate } from './primitives';
import { stripToolPrefix } from '../services/tools';
import {
  getSecretsSummary, getFlaggedSessions, getSecretsByRule, getDistinctSecrets,
  dismissSecret, undismissSecret, writeSecurityTasks,
  getCustomSecretRules, saveCustomSecretRule, deleteCustomSecretRule, testCustomSecretRule,
  getAccountRecommendations, applyAccountRecommendation,
  type SecretsSummary, type FlaggedSession, type SecretRuleRollup, type CodeRecommendation,
  type ServedRulePack,
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

      {/* Each recommendation is a plate that names itself. The "Recommendations"
          label that used to sit above this stack was an eyebrow: it said
          nothing the plate titles do not. */}
      {recs.map((r) => (
        <Plate
          key={r.id}
          // NO BALLOON. A balloon number refers to something — a schedule row,
          // a detail, a part on a figure. Nothing on this screen cites
          // "recommendation 02", so a number here would be a card wearing one.
          title={r.title}
          tools={<Chip kind={r.severity === 'high' ? 'err' : r.severity === 'medium' ? 'warn' : 'neutral'} size="sm">{r.severity}</Chip>}
        >
          <div style={{ fontSize: 13, color: 'var(--cr-fg-2)', marginBottom: 12, lineHeight: 1.5 }}>{r.rationale}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={() => apply(r)} disabled={busy === r.id}>{busy === r.id ? 'Applying…' : 'Apply to global CLAUDE.md'}</Button>
            {(r.action.payload as any)?.text && <Button variant="secondary" onClick={() => navigator.clipboard.writeText(String((r.action.payload as any).text))}>Copy rule</Button>}
            {msg[r.id] && <span style={{ fontSize: 12.5, color: 'var(--cr-fg-2)' }}>{msg[r.id]}</span>}
          </div>
        </Plate>
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

/**
 * A drawn icon per secret kind.
 *
 * The engine's classifier carries an EMOJI for each kind, and that is right for
 * the CLI — a terminal has no icon set. On this surface it was wrong: an emoji
 * is a glyph the design system does not own, it renders in whatever font the
 * platform picked, and at 22px next to a 14px label it was the loudest mark on
 * the security screen. Keyword matching, so a new kind in the engine still
 * lands on a sensible icon rather than nothing.
 */
function kindIcon(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('private key') || l.includes('basic auth')) return 'key';
  if (l.includes('aws') || l.includes('gcp') || l.includes('azure')) return 'cloud';
  if (l.includes('database') || l.includes('connection string')) return 'database';
  if (l.includes('url') || l.includes('rpc')) return 'link';
  if (l.includes('github') || l.includes('gitlab')) return 'code';
  if (l.includes('slack') || l.includes('telegram')) return 'message';
  if (l.includes('environment')) return 'terminal';
  if (l.includes('exchange') || l.includes('stripe')) return 'chart';
  if (l.includes('jwt') || l.includes('token')) return 'tag';
  if (l.includes('nvidia')) return 'zap';
  if (l.includes('context-flagged')) return 'search';
  if (l.includes('api key') || l.includes('service account')) return 'document';
  return 'shield';
}

// `fg` is the Coded Leader colour: the hue rides the VALUE — the word
// "critical" itself — never a bar on the edge of the box that holds it.
const SEVERITY_TONE: Record<Severity, { chip: 'err' | 'warn' | 'info' | 'neutral'; bg: string; border: string; fg: string }> = {
  critical: { chip: 'err',     bg: 'rgba(255, 80, 80, 0.05)', border: 'var(--cr-err-500)',  fg: 'var(--cr-err-500)' },
  high:     { chip: 'warn',    bg: 'rgba(255, 180, 0, 0.04)', border: 'var(--cr-warn-500)', fg: 'var(--cr-warn-500)' },
  medium:   { chip: 'info',    bg: 'transparent',             border: 'var(--cr-line-1)',   fg: 'var(--cr-fg-2)' },
  noise:    { chip: 'neutral', bg: 'transparent',             border: 'var(--cr-line-1)',   fg: 'var(--cr-fg-3)' },
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
  // Clicking a severity tile filters the action list to just that severity —
  // the counts become a burn-down control, not decoration.
  const [sevFilter, setSevFilter] = useState<'critical' | 'high' | null>(null);
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

  // The one number that matters: unresolved critical/high secrets. The banner's
  // "857 secrets / 720 sessions" and the per-severity tiles are context; THIS is
  // the to-do count. `live` = confirmed still-working keys → rotate first.
  const needRotation = actionRequired.filter(s => !s.dismissal).length;
  const liveCount = actionRequired.filter(s => s.verified === true && !s.dismissal).length;

  return (
    <div className="cr-page-pad" style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
      <AccountRecsStrip />
      {/* ── Hero ────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Security</h2>
        {!loading && needRotation > 0 ? (
          <div style={{ fontSize: 13.5, marginTop: 5, color: 'var(--cr-err-500)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
            {/* An emoji is not an icon. This read "🔴 1 secret need rotation
                now" — a coloured glyph the icon system does not own, and a
                verb that did not agree with its subject. */}
            <Icon name="shield" size={15} />
            {needRotation === 1 ? '1 secret needs rotation now' : `${needRotation} secrets need rotation now`}
            {liveCount > 0 && <span style={{ color: 'var(--cr-fg-3)', fontWeight: 400 }}>· {liveCount} confirmed live</span>}
          </div>
        ) : !loading ? (
          <div style={{ fontSize: 13.5, marginTop: 5, color: 'var(--cr-ok-500)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
            <Icon name="check" size={15} /> Nothing needs rotation right now
          </div>
        ) : null}
        <div style={{ fontSize: 12.5, color: 'var(--cr-fg-3)', marginTop: 4 }}>
          Per-secret analysis. Raw values never leave the database.
        </div>
      </div>

      {/* Severity, as one schedule.
          This was five stat tiles, each with a 3px coloured left border — the
          hero-metric template AND a coloured bar on a box edge, which is the
          card mark the Coded Leader Rule forbids. Here the hue rides the
          VALUE, the rows rank against each other, and a filtered row lights up
          the way a selected schedule row does. */}
      {!loading && (
        <Schedule
          
          caption="Exposure"
          cols={[
            { key: 'sev', kind: 'pn', head: 'Severity' },
            { key: 'what', head: 'What it counts' },
            { key: 'n', kind: 'val', head: 'Count' },
          ]}
          rows={[
            {
              id: 'critical',
              current: sevFilter === 'critical',
              onSelect: () => { setLens('action'); setSevFilter(f => f === 'critical' ? null : 'critical'); },
              cells: {
                sev: 'Critical',
                what: 'distinct keys, rotate these first',
                n: <span style={{ color: 'var(--cr-err-500)', fontSize: 15 }}>{headline.counts.critical}</span>,
              },
            },
            {
              id: 'high',
              current: sevFilter === 'high',
              onSelect: () => { setLens('action'); setSevFilter(f => f === 'high' ? null : 'high'); },
              cells: {
                sev: 'High',
                what: 'distinct keys, rotate after the critical ones',
                n: <span style={{ color: 'var(--cr-warn-500)', fontSize: 15 }}>{headline.counts.high}</span>,
              },
            },
            {
              id: 'medium',
              onSelect: headline.counts.medium > 0
                ? () => { setLens('action'); setSevFilter(null); requestAnimationFrame(() => document.getElementById('sec-review-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }
                : undefined,
              cells: {
                sev: 'Medium',
                what: 'distinct keys in the review queue',
                n: <span style={{ fontSize: 15 }}>{headline.counts.medium}</span>,
              },
            },
            {
              id: 'noise',
              onSelect: headline.counts.noise > 0
                ? () => { setLens('action'); setSevFilter(null); setShowNoise(true); requestAnimationFrame(() => document.getElementById('sec-review-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }
                : undefined,
              cells: {
                sev: 'Noise',
                what: 'fuzzy matches, likely false positives',
                n: <span className="val-q">{headline.counts.noise}</span>,
              },
            },
            {
              id: 'sessions',
              cells: {
                sev: 'Sessions exposed',
                what: 'transcripts containing a critical or high key',
                n: <span style={{ fontSize: 15 }}>{headline.sessionsHit}</span>,
              },
            },
          ]}
        />
      )}

      {/* Prevention hint — the findings below tell you what leaked and how to
          rotate; this one line teaches how to stop it happening again. Same
          guidance chat-recall injects into CLAUDE.md, surfaced where it's
          most relevant. */}
      <Note
        style={{ marginBottom: 16 }}
        title="Prevent leaks"
        footer={
          <>
            Reference the environment variable name in prompts, for example{' '}
            <code style={{ fontFamily: 'var(--cr-font-annot)', fontSize: 12.5, color: 'var(--cr-fg-1)' }}>$OPENAI_API_KEY</code>,
            never the value. A pasted secret can stay in a transcript after you delete the chat.
            If one slips through, rotate it.
          </>
        }
      />

      {error && (
        <Card style={{ padding: 14, marginBottom: 12, borderColor: 'var(--cr-err-500)' }}>
          <span style={{ color: 'var(--cr-err-500)' }}>Error: {error}</span>
        </Card>
      )}

      {/* The five-lens strip is 465px wide and a phone is 390px. The STRIP
          pans, which is what a tab strip does; the page must not, because a
          panning page moves the content you are reading. */}
      <Card style={{ padding: 12, marginBottom: 14, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
        <div className="cr-segmented-scroll" style={{ marginBottom: 0, minWidth: 0, maxWidth: '100%' }}>
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
        </div>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px', borderRadius: 0, background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-2)', fontSize: 13, color: 'var(--cr-fg-2)' }}>
          <span>Scoped to <b style={{ color: 'var(--cr-fg-1)' }}>one conversation</b>'s secrets.</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => setSessionScope(null)}
            style={{ background: 'transparent', border: '1px solid var(--cr-line-2)', color: 'var(--cr-fg-2)', borderRadius: 0, padding: '3px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
            Show all secrets
          </button>
        </div>
      )}

      {/* ── ACTION REQUIRED ─────────────────────────────────────── */}
      {!loading && lens === 'action' && (() => {
        const shownAction = sevFilter ? actionRequired.filter(s => s.type.severity === sevFilter) : actionRequired;
        return (
        <>
          {sevFilter && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, fontSize: 12, color: 'var(--cr-fg-3)' }}>
              <span>Filtered to <b style={{ color: 'var(--cr-fg-1)' }}>{sevFilter}</b> · {shownAction.length} secret{shownAction.length === 1 ? '' : 's'}</span>
              <button
                onClick={() => setSevFilter(null)}
                style={{ background: 'transparent', border: '1px solid var(--cr-line-2)', color: 'var(--cr-fg-2)', borderRadius: 0, padding: '2px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Clear filter
              </button>
            </div>
          )}
          {shownAction.length === 0 && (
            <Card style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>
              <div style={{ fontSize: 14, marginBottom: 6, color: 'var(--cr-ok-500)' }}>
                No critical or high-severity secrets detected
              </div>
              <div style={{ fontSize: 12 }}>
                Findings populate from the collector. Run <code>chat-recall sync</code> on the
                machine where your sessions live — secrets are scanned and masked client-side,
                then shipped here.
              </div>
            </Card>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {shownAction.map(s => {
              const tone = SEVERITY_TONE[s.type.severity];
              const isOpen = expanded.has(s.preview);
              return (
                <Card
                  key={s.preview}
                  style={{ padding: 14 }}
                >
                  {/* Header row: glyph + label + preview + chips */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <Icon name={kindIcon(s.type.label)} size={18} style={{ color: 'var(--cr-fg-2)' }} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--cr-fg-1)' }}>
                        {s.type.label}
                      </span>
                      <span style={{ fontSize: 12, fontFamily: 'var(--cr-font-annot)', color: 'var(--cr-fg-3)', wordBreak: 'break-all', overflowWrap: 'anywhere', maxWidth: '100%' }}>
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
                      <Chip kind="err" size="sm" icon="shield">live, verified</Chip>
                    )}
                    <Chip kind={s.detectors.length >= 2 ? 'err' : 'warn'} size="sm">
                      {s.detectors.length === 1 ? '1 detector' : `${s.detectors.length} agree`}
                    </Chip>
                    <Chip kind="neutral" size="sm">
                      {s.sessionCount} session{s.sessionCount === 1 ? '' : 's'}
                    </Chip>
                    {s.dismissal && (
                      <Chip kind="ok" size="sm">
                        {s.dismissal.status === 'rotated' ? 'Rotated' :
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
                  <div style={{ marginTop: 10, display: 'flex', gap: 14, fontSize: 12, color: 'var(--cr-fg-3)', flexWrap: 'wrap' }}>
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
                        Rotate
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
                        Mark rotated
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
                    <div style={{ marginTop: 12, padding: 10, background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-2)', borderRadius: 0 }}>
                      <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
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
                                fontFamily: 'var(--cr-font-annot)', fontSize: 12,
                                textDecoration: 'underline', minWidth: 90, textAlign: 'left',
                              }}
                            >
                              {shortId(sess.sessionId)}
                            </button>
                            <span style={{ color: 'var(--cr-fg-3)', flex: 1, fontFamily: 'var(--cr-font-annot)', wordBreak: 'break-all' }}>
                              {projectShort(sess.project)}
                            </span>
                            <span style={{ color: 'var(--cr-fg-3)', fontFamily: 'var(--cr-font-annot)', fontSize: 12 }}>
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
          {!sevFilter && reviewQueue.length > 0 && (
            <div id="sec-review-queue" style={{ marginTop: 24, scrollMarginTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--cr-fg-2)' }}>Review queue</span>
                <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
                  {reviewQueue.length} item{reviewQueue.length === 1 ? '' : 's'} — verify whether each is a real credential
                </span>
              </div>
              {/* Thirty bordered boxes in a gapped column, every one carrying
                  the same five fields — the card list a schedule replaces. As
                  rows the severities and counts line up in columns you can
                  compare down, and the trailing "+N more" becomes the caption,
                  which is where a stated limit belongs. */}
              <Schedule
                scroll
                caption={reviewQueue.length > 30
                  ? `The first 30 of ${reviewQueue.length} medium-severity items.`
                  : undefined}
                cols={[
                  { key: 'kind', kind: 'pn', head: 'Detector' },
                  { key: 'preview', head: 'Preview' },
                  { key: 'sev', kind: 'val', head: 'Severity' },
                  { key: 'seen', kind: 'val', head: 'Seen', optional: true },
                  { key: 'go', kind: 'rt', optional: true },
                ]}
                rows={reviewQueue.slice(0, 30).map(s => ({
                  id: s.preview,
                  cells: {
                    kind: (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <Icon name={kindIcon(s.type.label)} size={15} style={{ color: 'var(--cr-fg-3)' }} />
                        {s.type.label}
                      </span>
                    ),
                    preview: (
                      <span style={{ fontFamily: 'var(--cr-font-annot)', color: 'var(--cr-fg-3)' }}>{s.preview}</span>
                    ),
                    // The hue rides the VALUE, not a bar on the row's edge.
                    sev: (
                      <span style={{ color: SEVERITY_TONE[s.type.severity].fg }}>{s.type.severity}</span>
                    ),
                    seen: `${s.sessionCount} sess · ${s.occurrences} occ`,
                    go: s.sessions[0] ? (
                      <button
                        onClick={() => onSessionClick?.(s.sessions[0].sessionId)}
                        style={{ background: 'transparent', border: 0, padding: 0, color: 'var(--cr-brand-500)', cursor: 'pointer', fontFamily: 'var(--cr-font-annot)', fontSize: 12 }}
                      >
                        {shortId(s.sessions[0].sessionId)} →
                      </button>
                    ) : null,
                  },
                }))}
              />
            </div>
          )}

          {!sevFilter && noiseCount > 0 && (
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
        );
      })()}

      {/* ── BY RULE ─────────────────────────────────────────────── */}
      {!loading && lens === 'rules' && (
        <Card style={{ padding: 0 }}>
          <div className="cr-tablescroll">
          <table className="cr-schedule" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--cr-ink-2)' }}>
                <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Rule</th>
                <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Detector</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Distinct</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Total</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Sessions</th>
              </tr>
            </thead>
            <tbody>
              {rules.slice(0, 40).map((r, i) => {
                const t = classify(r.detector, r.rule);
                return (
                  <tr key={`${r.detector}:${r.rule}`} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--cr-line-1)' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'var(--cr-font-annot)', color: 'var(--cr-fg-2)' }}>
                      <Icon name={kindIcon(t.label)} size={14} style={{ color: 'var(--cr-fg-3)', marginRight: 6, verticalAlign: '-2px' }} />
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
          </div>
        </Card>
      )}

      {/* ── BY PROJECT ──────────────────────────────────────────── */}
      {!loading && lens === 'projects' && (
        <Card style={{ padding: 0 }}>
          <div className="cr-tablescroll">
          <table className="cr-schedule" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--cr-ink-2)' }}>
                <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Project</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Critical keys</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>High keys</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Medium keys</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Sessions</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Rotation checklist</th>
              </tr>
            </thead>
            <tbody>
              {byProject.map((p, i) => {
                const realPath = p.project && p.project !== '(unknown)';
                return (
                <tr key={p.project} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--cr-line-1)' }}>
                  <td style={{ padding: '8px 12px', fontFamily: 'var(--cr-font-annot)', color: 'var(--cr-fg-2)', wordBreak: 'break-all' }}>{projectShort(p.project)}</td>
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
                          style={{ background: 'transparent', border: '1px solid var(--cr-line-2)', color: 'var(--cr-brand-500)', borderRadius: 0, padding: '3px 10px', fontSize: 12, cursor: taskBusy === p.project ? 'default' : 'pointer', fontFamily: 'inherit', fontWeight: 600, whiteSpace: 'nowrap' }}
                        >
                          {taskBusy === p.project ? 'queuing…' : 'Write SECURITY_TASKS.md →'}
                        </button>
                        {taskMsg[p.project] && (
                          <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginTop: 4, maxWidth: 320, marginLeft: 'auto', textAlign: 'right', lineHeight: 1.4 }}>
                            {taskMsg[p.project]}
                          </div>
                        )}
                      </>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>—</span>
                    )}
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
          </div>
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
                style={{ padding: 12, cursor: onSessionClick ? 'pointer' : 'default' }}
                onClick={() => onSessionClick?.(s.sessionId)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <Chip kind={tone} size="sm">{s.agreement === 1 ? '1 detector' : `${s.agreement} agree`}</Chip>
                  <span style={{ fontFamily: 'var(--cr-font-annot)', fontSize: 12, color: 'var(--cr-brand-500)' }}>{shortId(s.sessionId)}</span>
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

/**
 * What chat-recall already protects, before the customer configures anything.
 *
 * Without this the panel opened on an empty table reading "No custom rules
 * yet", which for a SaaS user is indistinguishable from "nothing is protecting
 * you" — while in fact a curated pack is installed into their redactor on every
 * sync. These rules are ours: served, versioned and not editable here, so the
 * card states that plainly instead of offering buttons that would not work.
 */
function ManagedPackCard({ pack }: { pack?: ServedRulePack }) {
  const [open, setOpen] = useState(false);
  const managed = (pack?.rules || []).filter((r) => r.source === 'pack');
  if (!managed.length) return null;
  return (
    <Card style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Chip kind="ok" size="sm">{managed.length} managed rules active</Chip>
        <span style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>
          Maintained by chat-recall and installed into every device's redactor at sync time — nothing to configure.
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginTop: 8, fontFamily: 'var(--cr-font-annot)' }}>
        pack {pack?.version}{pack?.revision ? ` · rev ${pack.revision}` : ''}{pack?.source ? ` · ${pack.source}` : ''}
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ background: 'transparent', border: 0, color: 'var(--cr-brand-500)', cursor: 'pointer', fontWeight: 600, fontSize: 12, padding: '8px 0 0' }}
      >
        {open ? 'Hide' : 'Show'} the {managed.length} rules
      </button>
      {open && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {managed.map((r) => (
            <Chip key={r.name} kind="neutral" size="sm">{r.name}</Chip>
          ))}
        </div>
      )}
    </Card>
  );
}

function CustomRulesPanel({ onChanged }: { onChanged: () => void }) {
  const [rules, setRules] = useState<TenantRule[]>([]);
  const [pack, setPack] = useState<ServedRulePack | undefined>(undefined);
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
      setPack(j.pack);
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

  // GAP 0. Three framed boxes 14px apart is a card stack. Flush, the pack, the
  // note and the rule list read as one drawn object, because `.cr-note +
  // .cr-plate` and its siblings drop the doubled edge.
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <ManagedPackCard pack={pack} />

      <Note>
        Patterns added here run alongside the managed rules above. Each rule is a regex
        matched against the raw session text. Use this for internal API key shapes,
        custom token prefixes, or hostnames you don't want pasted into AI sessions.
        Rules are stored here and executed on each device at sync time — the server never
        receives unredacted text, so matching has to happen where the text still is.
      </Note>

      {/* List */}
      <Card style={{ padding: 0 }}>
        <div className="cr-tablescroll">
        <table className="cr-schedule" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--cr-ink-2)' }}>
              <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Name</th>
              <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Regex</th>
              <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Severity</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {!loading && rules.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 18, textAlign: 'center', color: 'var(--cr-fg-3)' }}>No rules of your own yet — the managed pack above is already running.</td></tr>
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
                  {!!r.redact && <Chip kind="ok" size="sm" style={{ marginLeft: 6 }}>redacts</Chip>}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                  <button onClick={() => setEditing(r)} style={{ background: 'transparent', border: 0, color: 'var(--cr-brand-500)', cursor: 'pointer', marginRight: 8, fontWeight: 600 }}>Edit</button>
                  <button onClick={() => remove(r.id)} style={{ background: 'transparent', border: 0, color: 'var(--cr-err-500)', cursor: 'pointer', fontWeight: 600 }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Card>

      {!editing && (
        <Card style={{ padding: 14 }}>
          <button
            onClick={() => setEditing({ name: '', regex: '', severity: 'high', enabled: 1 })}
            style={{ background: 'var(--cr-brand-500)', color: 'var(--cr-on-brand)', border: 0, padding: '8px 14px', borderRadius: 0, cursor: 'pointer', fontWeight: 600 }}
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
                style={{ display: 'block', marginTop: 4, width: '100%', padding: '8px 10px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 0, color: 'var(--cr-fg-1)', fontFamily: 'var(--cr-font-mono)' }}
              />
            </label>
            <label style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
              Regex
              <input
                value={editing.regex || ''}
                onChange={(e) => setEditing({ ...editing, regex: e.target.value })}
                placeholder="acme_(?:live|test)_[a-zA-Z0-9]{32}"
                style={{ display: 'block', marginTop: 4, width: '100%', padding: '8px 10px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 0, color: 'var(--cr-fg-1)', fontFamily: 'var(--cr-font-mono)' }}
              />
            </label>
            <label style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
              Severity
              <select
                value={editing.severity || 'high'}
                onChange={(e) => setEditing({ ...editing, severity: e.target.value as TenantRule['severity'] })}
                style={{ display: 'block', marginTop: 4, padding: '6px 10px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 0, color: 'var(--cr-fg-1)' }}
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
                style={{ display: 'block', marginTop: 4, width: '100%', padding: '8px 10px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 0, color: 'var(--cr-fg-1)' }}
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
            <label style={{ fontSize: 12, color: 'var(--cr-fg-3)', display: 'inline-flex', gap: 6, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={!!editing.redact}
                onChange={(e) => setEditing({ ...editing, redact: e.target.checked ? 1 : 0 })}
              />
              <span>
                Also redact matches (not just report them)
                <span style={{ display: 'block', color: 'var(--cr-fg-3)', marginTop: 2 }}>
                  Every device applies this pattern when redacting, from its next sync on — no CLI
                  upgrade needed. Over-broad patterns are rejected on save, because a rule that
                  matches ordinary text would replace real content with [REDACTED] everywhere.
                </span>
              </span>
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={save} style={{ background: 'var(--cr-brand-500)', color: 'var(--cr-on-brand)', border: 0, padding: '8px 14px', borderRadius: 0, cursor: 'pointer', fontWeight: 600 }}>Save</button>
              <button onClick={() => { setEditing(null); setError(null); }} style={{ background: 'transparent', color: 'var(--cr-fg-2)', border: '1px solid var(--cr-line-1)', padding: '8px 14px', borderRadius: 0, cursor: 'pointer' }}>Cancel</button>
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
          style={{ width: '100%', padding: '8px 10px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 0, color: 'var(--cr-fg-1)', fontFamily: 'var(--cr-font-mono)', fontSize: 12, marginBottom: 8 }}
        />
        <input
          value={testRegex}
          onChange={(e) => setTestRegex(e.target.value)}
          placeholder="acme_(?:live|test)_[a-zA-Z0-9]{32}"
          style={{ width: '100%', padding: '8px 10px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 0, color: 'var(--cr-fg-1)', fontFamily: 'var(--cr-font-mono)', fontSize: 12, marginBottom: 8 }}
        />
        <button onClick={runTest} style={{ background: 'var(--cr-fg-2)', color: 'var(--cr-ink-1)', border: 0, padding: '6px 12px', borderRadius: 0, cursor: 'pointer', fontWeight: 600 }}>Test</button>
        {testError && <div style={{ color: 'var(--cr-err-500)', marginTop: 8, fontSize: 12 }}>{testError}</div>}
        {testResult && (
          <div style={{ marginTop: 10, padding: 10, background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-2)', borderRadius: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginBottom: 6 }}>
              {testResult.count} match{testResult.count === 1 ? '' : 'es'}
            </div>
            {testResult.matches.map((m, i) => (
              <div key={i} style={{ fontSize: 12, fontFamily: 'var(--cr-font-annot)', color: 'var(--cr-fg-2)' }}>
                @{m.index}: <span style={{ background: 'var(--cr-warn-500)', color: 'var(--cr-on-warn)', padding: '0 4px' }}>{m.match}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
