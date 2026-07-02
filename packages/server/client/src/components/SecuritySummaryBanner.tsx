import { useEffect, useState } from 'react';
import { getSecretsSummary } from '../services/api';
import { Button, IconButton } from './primitives';

/**
 * First-login value proof. Most trials won't hit a live leak that week, so we
 * surface the security scan result immediately: "scanned N sessions, found M
 * secrets, K verified LIVE → Review". Dismissible, but re-appears whenever the
 * verified-live count rises (a new live leak must not stay hidden).
 */
const DISMISS_KEY = 'cr-secbanner-dismissed-verified';

export default function SecuritySummaryBanner({ onReview }: { onReview: () => void }) {
  const [s, setS] = useState<{ total: number; verified: number; distinct: number; sessions: number } | null>(null);

  useEffect(() => {
    getSecretsSummary()
      .then((r) => setS({ total: r.total, verified: r.verified, distinct: r.distinct, sessions: r.sessionsWithFindings }))
      .catch(() => {});
  }, []);

  if (!s || s.total === 0) return null;
  const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) ?? '-1');
  // Show unless the user already dismissed at this (or a higher) live count.
  if (s.verified <= dismissedAt) return null;

  const live = s.verified > 0;
  const dismiss = () => { localStorage.setItem(DISMISS_KEY, String(s.verified)); setS(null); };

  return (
    <div className={`cr-secbanner ${live ? 'live' : 'info'}`} role="status">
      <style>{CSS}</style>
      <span className="cr-secbanner-dot" />
      <span className="cr-secbanner-text">
        {live ? (
          <><strong>{s.verified} verified-LIVE secret{s.verified > 1 ? 's' : ''}</strong> found in your sessions — rotate now.{' '}
            <span className="muted">({s.distinct} secrets across {s.sessions} sessions scanned)</span></>
        ) : (
          <>Scanned <strong>{s.sessions} sessions</strong> — found <strong>{s.distinct} secret{s.distinct > 1 ? 's' : ''}</strong> to review. None verified live (yet).</>
        )}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onReview}
        // Inherit the banner's live/info accent instead of the neutral token
        // palette so the CTA reads as part of the alert.
        style={{ color: 'inherit', borderColor: 'currentColor', background: 'transparent', whiteSpace: 'nowrap' }}
      >
        Review →
      </Button>
      <IconButton icon="x" size={26} onClick={dismiss} aria-label="Dismiss" title="Dismiss" style={{ color: 'inherit' }} />
    </div>
  );
}

const CSS = `
.cr-secbanner { display:flex; align-items:center; gap:10px; padding:9px 16px; font-size:13.5px; border-bottom:1px solid var(--cr-line-1,#1e232b); }
.cr-secbanner.live { background: var(--cr-err-surf,#2a1416); color: var(--cr-err-500,#f87171); }
.cr-secbanner.info { background: var(--cr-info-surf,#10202e); color: var(--cr-info-500,#5b9ddf); }
.cr-secbanner .muted { opacity:.7; }
.cr-secbanner-dot { width:8px; height:8px; border-radius:50%; background:currentColor; flex:none; box-shadow:0 0 0 3px color-mix(in srgb, currentColor 22%, transparent); }
.cr-secbanner-text { flex:1; min-width:0; }
`;
