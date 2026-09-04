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
 * A LAPSED tenant is switched OFF, not degraded: since 2026-08-25 the server
 * refuses searches and session reads as well as ingest. The banner therefore
 * states what stopped and what survives — the history is intact and export
 * always works — and does not promise a searchable corpus it no longer has.
 * Two earlier versions of this text promised exactly that, each written when
 * the tier below it still existed.
 *
 * Dismissal:
 *  - Trial countdown: per remaining-days value — dismissing at 7 days hides it
 *    until the number changes. The final two days are NOT dismissible; that is
 *    the whole point of a deadline.
 *  - Lapsed: per calendar day. It is a standing offer, not a deadline, so it
 *    must be quietable — but it returns tomorrow, because every session written
 *    while the account is off is one more that never reached the server.
 */
const DISMISS_KEY = 'cr-trialbanner-dismissed-at-days';
const FREE_DISMISS_KEY = 'cr-freebanner-dismissed-day';


export default function TrialBanner({
  onSubscribe,
  windowDays,
}: {
  onSubscribe: () => void;
  /** Was the free plan's applied search window. Accepted and ignored since the
   *  window was removed on 2026-08-22; kept so call sites need no edit. */
  windowDays?: number | null;
}) {
  const [ent, setEnt] = useState<
    { onTrial: boolean; daysLeft: number | null; status: string; entitled: boolean } | null
  >(null);
  const [freeDismissed, setFreeDismissed] = useState(false);

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

  // status 'none' = the tenant has NO entitlement row: their address was never
  // confirmed, so no trial was granted and every sync is refused. Promising
  // "syncing continues" here contradicts what the server actually does — the
  // needed banner is "confirm your email", not the free-plan offer.
  if (onFree && ent.status === 'none') {
    return (
      <div className="cr-trialbanner urgent" role="status" data-testid="confirm-email-nudge">
        <style>{CSS}</style>
        <span className="cr-trialbanner-dot" />
        <span className="cr-trialbanner-text">
          <strong>Confirm your email</strong> — your trial starts (and syncing begins) once you
          click the link we sent. Nothing is counting down until you do.
        </span>
      </div>
    );
  }

  if (onFree) {
    // LOCAL day, not UTC: "it returns tomorrow" must mean the user's tomorrow.
    // en-CA formats as YYYY-MM-DD, which makes a stable storage key.
    const today = new Date().toLocaleDateString('en-CA');
    let hidden = freeDismissed;
    try { hidden = hidden || localStorage.getItem(FREE_DISMISS_KEY) === today; } catch { /* no storage */ }
    if (hidden) return null;
    const dismiss = () => {
      try { localStorage.setItem(FREE_DISMISS_KEY, today); } catch { /* no storage */ }
      setFreeDismissed(true);
    };
    return (
      <div className="cr-trialbanner free" role="status" data-testid="free-plan-banner">
        <style>{CSS}</style>
        <span className="cr-trialbanner-dot" />
        <span className="cr-trialbanner-text">
          <strong>Recall is off</strong> — your trial has ended, so searches are refused and new
          sessions stop arriving.{' '}
          <span className="muted">
            Nothing was deleted: your history is intact and export always works. Subscribe
            and one <code>chat-recall sync --full</code> brings you current.
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
            <strong>Your trial ends today.</strong> After that new sessions stop syncing.
            Everything already synced stays searchable, and nothing is deleted.
          </>
        ) : (
          <>
            <strong>{days} day{days === 1 ? '' : 's'} left</strong> on your trial.{' '}
            <span className="muted">
              When it ends, new sessions stop syncing. Everything already synced stays fully
              searchable, and export always works.
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
  padding: 9px 12px; margin: 0 0 12px; border-radius: var(--cr-radius-md);
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
