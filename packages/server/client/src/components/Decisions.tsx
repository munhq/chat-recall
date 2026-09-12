/**
 * Decisions — what this codebase has settled, and what it has not.
 *
 * ── Why gaps lead ───────────────────────────────────────────────────────────
 *
 * The failure mode of a decision register is that it is empty, and an empty one
 * is worse than none: every agent picks for itself, none of them agree, and
 * nobody notices because the page looks calm. So the undecided areas sit at the
 * top, in warning colour, with the action attached — and the settled rows,
 * which are the ones people think a register is for, sit quiet underneath.
 *
 * ── The three states a row can be in ────────────────────────────────────────
 *
 *   inherited   this project has no opinion; the account decided
 *   override    this project deliberately disagrees with the account
 *   advisory    a personal preference; fills a gap, binds nobody
 *
 * Each is drawn differently because confusing them is expensive. An override is
 * the loudest thing in the settled band: "acme uses Keycloak even though we
 * standardised on BetterAuth" is precisely the fact someone needs to see before
 * they start work, and precisely the one a flat list hides.
 *
 * The cascade itself is resolved server-side (routes/decisions.ts). This file
 * renders an answer; it never works out which scope wins.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Chip, Icon, Button } from './primitives';
import {
  getDecisions, recordDecision,
  type Decision, type DecisionsResponse,
} from '../services/api';

function fmtDate(v: string | null): string {
  if (!v) return '';
  const n = Date.parse(v);
  if (!Number.isFinite(n)) return v;
  return new Date(n).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' });
}

export default function Decisions({ project, embedded }: { project?: string | null; embedded?: boolean }) {
  const [data, setData] = useState<DecisionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Decision | null>(null);
  const [recording, setRecording] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    getDecisions({ project: project ?? undefined, includeCandidates: true })
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [project]);
  useEffect(load, [load]);

  if (loading && !data) {
    return <div style={{ padding: embedded ? '12px 0' : 24, color: 'var(--cr-fg-2)' }}>Reading the register…</div>;
  }

  const decisions = data?.decisions ?? [];
  const gaps = data?.gaps ?? [];
  const candidates = data?.candidates ?? [];

  return (
    <div
      className={embedded ? undefined : 'cr-pad-mobile'}
      style={{ flex: 1, overflow: 'auto', padding: embedded ? '4px 0 40px' : '24px 28px 56px' }}
    >
      {!embedded && (
        <div style={{ marginBottom: 18 }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="brain" size={20} /> Decisions
          </h2>
          <div style={{ color: 'var(--cr-fg-2)', fontSize: 13, marginTop: 4 }}>
            What this codebase has settled, what it hasn&apos;t, and what replaced what.
          </div>
        </div>
      )}

      {/* ── Needs a decision ─────────────────────────────────────────── */}
      {gaps.length > 0 && (
        <section style={{ marginBottom: 26 }}>
          <BandHead
            title="Needs a decision"
            count={`${gaps.length} area${gaps.length === 1 ? '' : 's'}`}
            note="Nothing is recorded, so every agent picks for itself and none of them agree."
          />
          <div>
            {gaps.map((g) => (
              <div
                key={g.area}
                style={{
                  display: 'grid', gridTemplateColumns: '150px 1fr auto', gap: '4px 16px',
                  alignItems: 'center', padding: '12px 12px',
                  background: 'var(--cr-warn-surf)', borderBottom: '1px solid var(--cr-warn-line)',
                }}
              >
                <span className="cr-annot" style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{g.area}</span>
                <span style={{ color: 'var(--cr-warn-500)', fontWeight: 600, fontSize: 14.5 }}>Not decided</span>
                <Button
                  size="sm"
                  onClick={() => setRecording(g.area)}
                  disabled={recording === g.area}
                >
                  Record
                </Button>
              </div>
            ))}
          </div>
          {recording && (
            <RecordForm
              area={recording}
              project={project ?? null}
              onDone={() => { setRecording(null); load(); }}
              onCancel={() => setRecording(null)}
            />
          )}
        </section>
      )}

      {/* ── Found in your history ────────────────────────────────────── */}
      {candidates.length > 0 && (
        <section style={{ marginBottom: 26 }}>
          <BandHead
            title="Found in your history"
            count={`${candidates.length} to review`}
            note="These look like decisions from past sessions. They are guesses the indexer made, and bind nothing until you confirm one."
          />
          {candidates.slice(0, 8).map((c) => (
            <div
              key={c.value}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12, padding: '11px 12px', borderBottom: '1px solid var(--cr-line-1)',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14.5, overflowWrap: 'anywhere' }}>{c.value}</div>
                <div className="cr-annot" style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 2 }}>
                  seen {c.mentions}×{c.last_seen ? ` · latest ${fmtDate(c.last_seen)}` : ''}
                </div>
              </div>
              <Chip size="sm">unconfirmed</Chip>
            </div>
          ))}
        </section>
      )}

      {/* ── Settled ──────────────────────────────────────────────────── */}
      <section>
        <BandHead
          title="Settled"
          count={`${decisions.length} area${decisions.length === 1 ? '' : 's'}`}
          note="Recorded and current. Your agents read these before they write code."
        />
        {decisions.length === 0 ? (
          <div style={{ padding: '16px 12px', color: 'var(--cr-fg-2)', fontSize: 14 }}>
            Nothing recorded yet. Decide one of the areas above, or ask an agent to record the next
            decision you make together.
          </div>
        ) : decisions.map((d) => (
          <button
            key={`${d.scope}:${d.area}`}
            onClick={() => setOpen(d)}
            style={{
              display: 'grid', gridTemplateColumns: '150px 1fr auto', gap: '4px 16px',
              alignItems: 'baseline', width: '100%', textAlign: 'left', font: 'inherit',
              color: 'inherit', background: 'none', border: 0,
              borderBottom: '1px solid var(--cr-line-1)', padding: '12px', cursor: 'pointer',
            }}
          >
            <span className="cr-annot" style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{d.area}</span>
            <span style={{
              fontWeight: d.inherited ? 500 : 600,
              fontSize: 15,
              color: d.inherited ? 'var(--cr-fg-3)' : 'var(--cr-fg-1)',
              overflowWrap: 'anywhere',
            }}>
              {d.value}
              {d.inherited && <span className="cr-annot" style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginLeft: 8 }}>· inherited</span>}
              {d.override && <Chip kind="brand" size="sm" style={{ marginLeft: 8 }}>override</Chip>}
              {d.advisory && <Chip size="sm" style={{ marginLeft: 8 }}>advisory</Chip>}
            </span>
            <span className="cr-annot" style={{ fontSize: 11, color: 'var(--cr-fg-3)', fontVariantNumeric: 'tabular-nums' }}>
              {fmtDate(d.since)}
            </span>
          </button>
        ))}
      </section>

      {open && <DecisionDetail d={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function BandHead({ title, count, note }: { title: string; count: string; note: string }) {
  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
        borderBottom: '1px solid var(--cr-line-2)', paddingBottom: 7,
      }}>
        <span style={{ fontWeight: 700, fontSize: 16 }}>{title}</span>
        <span className="cr-annot" style={{ fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          {count}
        </span>
      </div>
      <p style={{ color: 'var(--cr-fg-2)', fontSize: 13, margin: '7px 0 10px', maxWidth: '62ch' }}>{note}</p>
    </>
  );
}

/** The record: scope, rationale, what it replaced, and the conversation behind it. */
function DecisionDetail({ d, onClose }: { d: Decision; onClose: () => void }) {
  const replaced = d.history.filter((h) => !h.current);
  const scopeLine = d.inherited ? 'Inherited from the account'
    : d.override ? 'Overrides the account decision for this project'
    : d.advisory ? 'Yours only — never overrides a team decision'
    : d.scope === 'account' ? 'Account-wide' : 'This project only';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${d.area} decision`}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(12,40,67,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-2)',
          maxWidth: 560, width: '100%', maxHeight: '85vh', overflow: 'auto',
        }}
      >
        <div style={{ padding: '16px 20px 13px', borderBottom: '1px solid var(--cr-line-1)' }}>
          <div className="cr-annot" style={{ fontSize: 11, color: 'var(--cr-brand-500)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
            {d.area}
          </div>
          <div style={{ fontWeight: 700, fontSize: 20, marginTop: 4, overflowWrap: 'anywhere' }}>{d.value}</div>
        </div>
        <div style={{ padding: '14px 20px 18px', display: 'flex', flexDirection: 'column', gap: 13 }}>
          <Field label="Scope" value={scopeLine} />
          {d.why && <Field label="Why" value={d.why} />}
          <div>
            <div className="cr-annot" style={{ fontSize: 10.5, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
              History
            </div>
            <div style={{ borderLeft: '2px solid var(--cr-line-2)', paddingLeft: 12, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13.5 }}>
                <b>{d.value}</b><br />
                <span style={{ color: 'var(--cr-fg-3)' }}>since {fmtDate(d.since) || 'unknown'}</span>
              </div>
              {replaced.map((h, i) => (
                <div key={i} style={{ fontSize: 13.5, color: 'var(--cr-fg-2)' }}>
                  <b style={{ textDecoration: 'line-through', textDecorationColor: 'var(--cr-line-3)' }}>{h.value}</b><br />
                  <span style={{ color: 'var(--cr-fg-3)' }}>ended {fmtDate(h.to)}</span>
                </div>
              ))}
              {replaced.length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--cr-fg-3)' }}>Nothing was replaced.</div>
              )}
            </div>
          </div>
          {d.source_session && <Field label="Recorded from" value={`session ${d.source_session}`} />}
        </div>
        <div style={{ padding: '11px 20px', borderTop: '1px solid var(--cr-line-1)', display: 'flex', justifyContent: 'flex-end' }}>
          <Button size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="cr-annot" style={{ fontSize: 10.5, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
        {label}
      </div>
      <div style={{ fontSize: 14, marginTop: 3, overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}

/** Recording from the gap row: the area is already known, so it asks for the
 *  two things it cannot infer and nothing else. */
function RecordForm({ area, project, onDone, onCancel }: {
  area: string; project: string | null; onDone: () => void; onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    const ok = await recordDecision({ area, value: value.trim(), reason: reason.trim() || undefined, project: project ?? undefined });
    setSaving(false);
    if (ok) onDone();
    else setError('That did not save. Check you are signed in, then try again.');
  };

  return (
    <div style={{ border: '1px solid var(--cr-line-2)', padding: 14, marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="cr-annot" style={{ fontSize: 11, color: 'var(--cr-brand-500)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
        Decide {area}
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: 'var(--cr-fg-2)' }}>
        What did you choose?
        <input
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') onCancel(); }}
          placeholder="BetterAuth"
          style={{ font: 'inherit', fontSize: 14, padding: '8px 10px', background: 'var(--cr-ink-0)', color: 'var(--cr-fg-1)', border: '1px solid var(--cr-line-2)' }}
        />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: 'var(--cr-fg-2)' }}>
        Why? <span style={{ color: 'var(--cr-fg-3)' }}>(optional, but it is the part people need later)</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') onCancel(); }}
          placeholder="Keycloak needed a server we did not want to run"
          style={{ font: 'inherit', fontSize: 14, padding: '8px 10px', background: 'var(--cr-ink-0)', color: 'var(--cr-fg-1)', border: '1px solid var(--cr-line-2)' }}
        />
      </label>
      {error && <div style={{ color: 'var(--cr-warn-500)', fontSize: 13 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" variant="primary" onClick={submit} disabled={saving || !value.trim()}>
          {saving ? 'Recording…' : 'Record'}
        </Button>
      </div>
    </div>
  );
}
