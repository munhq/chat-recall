import { useEffect, useMemo, useState } from 'react';
import { getPlans, startCheckout, getMe, createTeam, type CataloguePlan } from '../services/api';
import { Button } from './primitives';

/**
 * Choose what to buy.
 *
 * This exists because the app previously had no way to pick a plan at all. The
 * subscribe button posted to /checkout with no body, and the server falls back to
 * the first self-serve entry in the catalogue — so every click bought Solo
 * monthly, while the pricing page advertised Team and a yearly option that were
 * unreachable from inside the product.
 *
 * Amounts are never written here. They come from GET /api/billing/plans, which
 * reads them back from Stripe, so a price change in the dashboard needs no
 * deploy and our copy can never disagree with the charge.
 *
 * Seats: the server validates the count against the tenant's real member count
 * and rejects anything short of it, so the number chosen here is a request, not a
 * fact. We default to the plan's minimum and let the server refuse.
 */
export default function PlanPicker({ onError }: { onError: (s: string) => void }) {
  const [plans, setPlans] = useState<CataloguePlan[] | null>(null);
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [seats, setSeats] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    getPlans()
      .then((c) => setPlans(c.configured ? c.plans : []))
      .catch(() => setPlans([]));
  }, []);

  // Contact-only plans (Enterprise) carry no interval, so they must show in both
  // tabs rather than vanishing when the toggle flips to yearly.
  const shown = useMemo(() => {
    if (!plans) return [];
    return plans.filter((p) => !p.selfServe || p.interval === interval);
  }, [plans, interval]);

  const hasYearly = !!plans?.some((p) => p.selfServe && p.interval === 'year');

  if (!plans) return <p className="muted">Loading plans…</p>;
  if (!plans.length) return <p className="muted">No plans are configured on this deployment.</p>;

  async function buy(p: CataloguePlan) {
    setBusy(p.key); onError('');
    try {
      const wanted = p.seats === 'per_seat' ? (seats ?? Math.max(1, p.minSeats ?? 1)) : undefined;
      let url: string;
      try {
        url = await startCheckout({ plan: p.key, seats: wanted });
      } catch (e: any) {
        // First-run: the user may have no workspace yet. Create one, then retry —
        // the same recovery the trial button does.
        if (/no team/i.test(String(e?.message || e))) {
          const me = await getMe().catch(() => null);
          await createTeam(
            me?.user.email?.split('@')[0]?.replace(/[^a-z0-9]/gi, '') || 'workspace',
          );
          url = await startCheckout({ plan: p.key, seats: wanted });
        } else throw e;
      }
      window.location.assign(url);
    } catch (e: any) {
      onError(String(e?.message || e));
      setBusy(null);
    }
  }

  return (
    <div className="cr-planpicker">
      <style>{CSS}</style>

      {hasYearly && (
        <div className="cr-planpicker-toggle" role="tablist" aria-label="Billing interval">
          {(['month', 'year'] as const).map((iv) => (
            <button
              key={iv}
              role="tab"
              aria-selected={interval === iv}
              className={interval === iv ? 'active' : ''}
              onClick={() => setInterval(iv)}
            >
              {iv === 'month' ? 'Monthly' : 'Yearly'}
              {iv === 'year' && <span className="cr-planpicker-save">2 months free</span>}
            </button>
          ))}
        </div>
      )}

      <div className="cr-planpicker-grid">
        {shown.map((p) => (
          <div className="cr-planpicker-card" key={p.key}>
            <div className="cr-planpicker-name">{displayName(p.label)}</div>

            {p.selfServe ? (
              <>
                <div className="cr-planpicker-price">
                  {formatAmount(p.amount, p.currency)}
                  <span className="cr-planpicker-per">
                    {p.seats === 'per_seat' ? ' / seat' : ''} / {p.interval === 'year' ? 'year' : 'month'}
                  </span>
                </div>

                {p.seats === 'per_seat' && (
                  <label className="cr-planpicker-seats">
                    Seats
                    <input
                      type="number"
                      min={Math.max(1, p.minSeats ?? 1)}
                      max={p.maxSeats ?? undefined}
                      value={seats ?? Math.max(1, p.minSeats ?? 1)}
                      onChange={(e) => setSeats(Math.max(1, Number(e.target.value) || 1))}
                    />
                  </label>
                )}

                <Button variant="primary" disabled={busy !== null} onClick={() => buy(p)}>
                  {busy === p.key ? 'Starting…' : `Choose ${displayName(p.label)}`}
                </Button>
              </>
            ) : (
              <>
                <div className="cr-planpicker-price" style={{ fontSize: 20 }}>Let's talk</div>
                <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
                  Negotiated terms, self-hosted or run by us.
                </p>
                {p.contact && (
                  <a className="cr-planpicker-contact" href={`mailto:${p.contact}`}>{p.contact}</a>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
        Your current trial is not extended by subscribing — the free period you are already on
        runs to its original end, then billing begins.
      </p>
    </div>
  );
}

/** The catalogue labels yearly entries "Solo (yearly)" so they stay unambiguous in
 *  an operator's config and in a Stripe dashboard. Inside the picker the interval
 *  toggle already says Yearly, so the suffix reads as a stutter — strip it for
 *  display only, never in the key we send to checkout. */
function displayName(label: string): string {
  return label.replace(/\s*\((yearly|annual|monthly)\)\s*$/i, '').trim() || label;
}

/** Stripe gives minor units; render them in the price's own currency. */
function formatAmount(amount: number | null | undefined, currency?: string): string {
  if (amount == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: (currency || 'usd').toUpperCase(),
      maximumFractionDigits: amount % 100 === 0 ? 0 : 2,
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${(currency || '').toUpperCase()}`;
  }
}

const CSS = `
.cr-planpicker-toggle { display: inline-flex; gap: 2px; padding: 2px; margin-bottom: 14px;
  border: 1px solid var(--cr-line-1, #2a2a2a); border-radius: 8px; }
.cr-planpicker-toggle button { background: none; border: 0; cursor: pointer; padding: 6px 14px;
  border-radius: 6px; font-size: 13px; color: var(--cr-fg-3, #999); display: inline-flex;
  align-items: center; gap: 7px; }
.cr-planpicker-toggle button.active { background: var(--cr-ink-2, #1e1e1e); color: var(--cr-fg-1, #eee); }
.cr-planpicker-save { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 1px 5px; border-radius: 3px; background: var(--cr-brand-surf, #2a1f16);
  color: var(--cr-fg-2, #bbb); }
.cr-planpicker-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
.cr-planpicker-card { border: 1px solid var(--cr-line-1, #2a2a2a); border-radius: 10px;
  padding: 14px; display: flex; flex-direction: column; gap: 8px; }
.cr-planpicker-name { font-size: 13px; font-weight: 600; color: var(--cr-fg-2, #bbb); }
.cr-planpicker-price { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
.cr-planpicker-per { font-size: 12px; font-weight: 400; color: var(--cr-fg-3, #999); }
.cr-planpicker-seats { display: flex; align-items: center; justify-content: space-between;
  gap: 8px; font-size: 12px; color: var(--cr-fg-3, #999); }
.cr-planpicker-seats input { width: 68px; padding: 4px 6px; font-size: 13px;
  background: var(--cr-ink-2, #1e1e1e); color: var(--cr-fg-1, #eee);
  border: 1px solid var(--cr-line-1, #2a2a2a); border-radius: 6px; }
.cr-planpicker-contact { font-size: 12px; color: var(--cr-fg-2, #bbb); }
`;
