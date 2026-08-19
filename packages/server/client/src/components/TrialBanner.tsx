import { useEffect, useState } from 'react';
import { getEntitlement } from '../services/api';
import { Button } from './primitives';

/**
 * The trial countdown, in the app rather than in an inbox.
 *
 * This exists before the reminder emails matter, because an active user of a
 * developer tool sees the app far more often than they read mail from it — and
 * this costs nothing to deliver and cannot land in spam. Email covers the user
 * who has drifted away; this covers the one still working.
 *
 * Dismissal is per remaining-days value, not permanent: dismissing at 7 days left
 * hides it until the number changes, so the notice returns as the deadline
 * approaches without ever being naggable away for good. The final two days and
 * the ended state are NOT dismissible, since that is the whole point of a
 * deadline.
 */
const DISMISS_KEY = 'cr-trialbanner-dismissed-at-days';

export default function TrialBanner({ onSubscribe }: { onSubscribe: () => void }) {
  const [ent, setEnt] = useState<
    { onTrial: boolean; daysLeft: number | null; status: string; entitled: boolean } | null
  >(null);

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

  // Lapsed is "the server will not let this tenant write", whatever the status
  // string says. An expired trial still reads status='trialing', so deriving this
  // from the status would tell someone already read-only that their trial "ends
  // today".
  const lapsed = !ent.entitled;
  if (!lapsed && !ent.onTrial) return null;   // paying and current: nothing to say

  const days = ent.daysLeft ?? 0;
  const urgent = lapsed || days <= 2;

  if (!urgent) {
    const dismissedAt = localStorage.getItem(DISMISS_KEY);
    if (dismissedAt === String(days)) return null;
  }

  const dismiss = () => { localStorage.setItem(DISMISS_KEY, String(days)); setEnt(null); };

  return (
    <div className={`cr-trialbanner ${urgent ? 'urgent' : 'info'}`} role="status">
      <style>{CSS}</style>
      <span className="cr-trialbanner-dot" />
      <span className="cr-trialbanner-text">
        {lapsed ? (
          <>
            <strong>Your access is read-only.</strong> Search and export still work; new syncs are
            paused. <span className="muted">Your history is kept — nothing was deleted.</span>
          </>
        ) : days <= 0 ? (
          <>
            <strong>Your trial ends today.</strong> After that, search and export keep working and
            new syncs pause.
          </>
        ) : (
          <>
            <strong>{days} day{days === 1 ? '' : 's'} left</strong> on your trial.{' '}
            <span className="muted">
              When it ends, search and export keep working and new syncs pause. Nothing is deleted.
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

const CSS = `
.cr-trialbanner {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; margin: 0 0 12px; border-radius: 8px;
  border: 1px solid var(--border, #2a2a2a);
  background: var(--panel, #141414);
  font-size: 13px; line-height: 1.4;
}
.cr-trialbanner.urgent { border-color: #a4551e; background: rgba(164, 85, 30, 0.10); }
.cr-trialbanner-dot {
  width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
  background: var(--muted, #888);
}
.cr-trialbanner.urgent .cr-trialbanner-dot { background: #e0803a; }
.cr-trialbanner-text { flex: 1 1 auto; }
.cr-trialbanner-x {
  flex: 0 0 auto; background: none; border: 0; cursor: pointer;
  color: var(--muted, #888); font-size: 17px; line-height: 1; padding: 0 2px;
}
.cr-trialbanner-x:hover { color: var(--fg, #eee); }
`;
