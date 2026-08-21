import { useEffect, useState } from 'react';
import { getEntitlement } from '../services/api';
import { Button } from './primitives';

/**
 * The trial countdown — and, once the trial is spent, the FREE-PLAN state —
 * in the app rather than in an inbox.
 *
 * This exists before the reminder emails matter, because an active user of a
 * developer tool sees the app far more often than they read mail from it — and
 * this costs nothing to deliver and cannot land in spam. Email covers the user
 * who has drifted away; this covers the one still working.
 *
 * A LAPSED tenant is not read-only and not broken: they landed on the free plan
 * (the floor, not a purchase). Sync continues (metered) and search covers the
 * last few days; everything older is stored and locked, and unlocks instantly
 * on upgrade. The banner states that as an OFFER — the locked history IS the
 * upgrade argument — never as an error, which is what the old "your access is
 * read-only" line was: wrong twice (nothing is read-only; syncs are not paused)
 * at the exact moment someone decides whether to pay.
 *
 * Dismissal:
 *  - Trial countdown: per remaining-days value — dismissing at 7 days hides it
 *    until the number changes. The final two days are NOT dismissible; that is
 *    the whole point of a deadline.
 *  - Free plan: per calendar day. It is a standing offer, not a deadline, so it
 *    must be quietable — but it returns tomorrow, because the locked history
 *    only grows.
 */
const DISMISS_KEY = 'cr-trialbanner-dismissed-at-days';
const FREE_DISMISS_KEY = 'cr-freebanner-dismissed-day';

/** The free plan's default search window. The server is authoritative (search
 *  responses carry `window_days`); this only covers copy rendered before any
 *  search has answered. Matches FREE_SEARCH_WINDOW_DAYS' default. */
const DEFAULT_FREE_WINDOW_DAYS = 7;

export default function TrialBanner({
  onSubscribe,
  windowDays,
}: {
  onSubscribe: () => void;
  /** The window the server actually applied (from the latest search response).
   *  Undefined until a search has answered — the default then stands in. */
  windowDays?: number | null;
}) {
  const [ent, setEnt] = useState<
    { onTrial: boolean; daysLeft: number | null; status: string; entitled: boolean } | null
  >(null);
  const [dismissNonce, setDismissNonce] = useState(0);

  useEffect(() => {
    getEntitlement()
      .then((e) => {
        if (!e.billingEnabled) return;   // self-host: no trials, no banner
        setEnt({
          onTrial: !!e.onTrial,
          daysLeft: e.trialDaysLeft ?? null,
          status: e.status,
          // Read the server's answer; never recompute it here.
          entitled: e.entitled !== false,
        });
      })
      .catch(() => {});
  }, []);

  if (!ent) return null;

  // Not entitled = the server resolves this tenant to the FREE plan, whatever
  // the status string says (an expired trial still reads status='trialing', so
  // deriving this from the status would tell someone already on the free plan
  // that their trial "ends today").
  const onFree = !ent.entitled;
  if (!onFree && !ent.onTrial) return null;   // paying and current: nothing to say

  const days = ent.daysLeft ?? 0;
  const winDays = windowDays ?? DEFAULT_FREE_WINDOW_DAYS;

  if (onFree) {
    const today = new Date().toISOString().slice(0, 10);
    let hidden = false;
    try { hidden = localStorage.getItem(FREE_DISMISS_KEY) === today; } catch { /* no storage */ }
    if (hidden) return null;
    const dismiss = () => {
      try { localStorage.setItem(FREE_DISMISS_KEY, today); } catch { /* no storage */ }
      setDismissNonce((n) => n + 1);
    };
    void dismissNonce; // re-render trigger for the dismiss above
    return (
      <div className="cr-trialbanner free" role="status" data-testid="free-plan-banner">
        <style>{CSS}</style>
        <span className="cr-trialbanner-dot" />
        <span className="cr-trialbanner-text">
          <strong>Free plan</strong> — syncing continues and search covers your last{' '}
          {winDays} day{winDays === 1 ? '' : 's'}.{' '}
          <span className="muted">
            Your older history is stored and locked — it unlocks instantly when you upgrade.
          </span>
        </span>
        <Button variant="primary" size="sm" onClick={onSubscribe}>Upgrade</Button>
        <button className="cr-trialbanner-x" onClick={dismiss} aria-label="Dismiss">×</button>
      </div>
    );
  }

  const urgent = days <= 2;
  if (!urgent) {
    let dismissedAt: string | null = null;
    try { dismissedAt = localStorage.getItem(DISMISS_KEY); } catch { /* no storage */ }
    if (dismissedAt === String(days)) return null;
  }

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(days)); } catch { /* no storage */ }
    setEnt(null);
  };

  return (
    <div className={`cr-trialbanner ${urgent ? 'urgent' : 'info'}`} role="status">
      <style>{CSS}</style>
      <span className="cr-trialbanner-dot" />
      <span className="cr-trialbanner-text">
        {days <= 0 ? (
          <>
            <strong>Your trial ends today.</strong> After that you land on the free plan: sync
            continues and search covers your last {winDays} days. Nothing is deleted.
          </>
        ) : (
          <>
            <strong>{days} day{days === 1 ? '' : 's'} left</strong> on your trial.{' '}
            <span className="muted">
              When it ends you land on the free plan: sync continues and search covers your last{' '}
              {winDays} days. Older history stays stored and unlocks on upgrade.
            </span>
          </>
        )}
      </span>
      <Button variant="primary" size="sm" onClick={onSubscribe}>Subscribe</Button>
      {!urgent && (
        <button className="cr-trialbanner-x" onClick={dismiss} aria-label="Dismiss">×</button>
      )}
    </div>
  );
}

/* Tokens only (--cr-*): the previous --border/--panel/--muted names existed in
 * no stylesheet, so every colour fell through to its hardcoded dark fallback and
 * ignored the theme — the exact bug the tasks board had (see cf4f5dc). */
const CSS = `
.cr-trialbanner {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; margin: 0 0 12px; border-radius: var(--cr-radius-md, 8px);
  border: 1px solid var(--cr-line-2);
  background: var(--cr-ink-1);
  color: var(--cr-fg-1);
  font-size: 13px; line-height: 1.4;
}
.cr-trialbanner.urgent { border-color: var(--cr-warn-line); background: var(--cr-warn-surf); }
.cr-trialbanner.free { border-color: var(--cr-brand-line); background: var(--cr-brand-surf); }
.cr-trialbanner-dot {
  width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
  background: var(--cr-fg-3);
}
.cr-trialbanner.urgent .cr-trialbanner-dot { background: var(--cr-warn-500); }
.cr-trialbanner.free .cr-trialbanner-dot { background: var(--cr-brand-500); }
.cr-trialbanner-text { flex: 1 1 auto; }
.cr-trialbanner-text .muted { color: var(--cr-fg-2); }
.cr-trialbanner-x {
  flex: 0 0 auto; background: none; border: 0; cursor: pointer;
  color: var(--cr-fg-3); font-size: 17px; line-height: 1; padding: 0 2px;
}
.cr-trialbanner-x:hover { color: var(--cr-fg-1); }
`;
