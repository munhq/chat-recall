import { useEffect, useMemo, useState } from 'react';
import { formatMoney, seatTotal, yearlySaving } from '../utils/money';
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
 *
 * The count is held PER PLAN KEY. A single shared number made the two per-seat
 * cards (Team, Self-hosted team) move together, so choosing seats on one silently
 * changed the other, and buy() could send a count below the clicked card's own
 * minimum.
 */
export default function PlanPicker({ onError }: { onError: (s: string) => void }) {
  const [plans, setPlans] = useState<CataloguePlan[] | null>(null);
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  // Keyed by tier FAMILY, not by plan key: Team monthly and Team yearly are two
  // keys for one decision, so keying on the key threw the seat count away every
  // time the interval toggled. Still per-tier, so Team and Self-hosted team stay
  // independent — the bug this replaced had one shared counter for both.
  const seatFamily = (p: CataloguePlan) =>
    p.key.toLowerCase().replace(/[-_](month|monthly|year|yearly|annual)$/, '');
  const [seatsByFamily, setSeatsByFamily] = useState<Record<string, number>>({});
  const seatsFor = (p: CataloguePlan) => seatsByFamily[seatFamily(p)] ?? Math.max(1, p.minSeats ?? 1);
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

  // "2 months free" was hardcoded, so a price change in Stripe would have made
  // the badge lie.
  //
  // The saving must compare a tier with ITSELF. Taking the cheapest monthly plan
  // and the cheapest yearly plan pairs different products — self-hosted monthly
  // ($10) against Team yearly ($250) — which yields a negative number, so the
  // badge silently never appeared. Group by tier family (the plan key up to the
  // interval suffix) and report the largest genuine saving.
  const { yearSaving, savingCurrency } = useMemo(() => {
    const family = (key: string) => key.toLowerCase().replace(/[-_](month|monthly|year|yearly|annual)$/, '');
    const byFamily = new Map<string, { month?: number; year?: number; currency?: string }>();
    for (const p of plans ?? []) {
      if (!p.selfServe || p.amount == null || !p.interval) continue;
      const f = family(p.key);
      const e = byFamily.get(f) ?? {};
      if (p.interval === 'month') e.month = p.amount; else e.year = p.amount;
      e.currency = e.currency || p.currency;
      byFamily.set(f, e);
    }
    let best: number | null = null;
    let currency = 'usd';
    for (const e of byFamily.values()) {
      const s = yearlySaving(e.month, e.year);
      if (s != null && (best == null || s > best)) { best = s; currency = e.currency || 'usd'; }
    }
    return { yearSaving: best, savingCurrency: currency };
  }, [plans]);

  if (!plans) return <p className="muted">Loading plans…</p>;
  if (!plans.length) return <p className="muted">No plans are configured on this deployment.</p>;

  async function buy(p: CataloguePlan) {
    setBusy(p.key); onError('');
    try {
      const wanted = p.seats === 'per_seat' ? seatsFor(p) : undefined;
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
              {iv === 'year' && yearSaving != null && (
                <span className="cr-planpicker-save">save {formatMoney(yearSaving, savingCurrency)}</span>
              )}
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
                  {formatMoney(p.amount, p.currency)}
                  <span className="cr-planpicker-per">
                    {p.seats === 'per_seat' ? ' / seat' : ''} / {p.interval === 'year' ? 'year' : 'month'}
                  </span>
                </div>

                {p.seats === 'per_seat' && (() => {
                  const floor = Math.max(1, p.minSeats ?? 1);
                  const ceil = p.maxSeats ?? Infinity;
                  const n = seatsFor(p);
                  const set = (v: number) => setSeatsByFamily((prev) => ({
                    ...prev, [seatFamily(p)]: Math.min(ceil, Math.max(floor, v)),
                  }));
                  return (
                    <div className="cr-planpicker-seatblock">
                      <div className="cr-planpicker-seats">
                        <label htmlFor={`seats-${p.key}`}>Seats</label>
                        {/* A stepper, not a number input: the native spinners are
                            2px tall on desktop and absent on mobile, so the
                            commonest action had no affordance. */}
                        <div className="cr-planpicker-stepper">
                          <button
                            type="button"
                            onClick={() => set(n - 1)}
                            disabled={n <= floor}
                            aria-label="Remove a seat"
                            title={n <= floor ? `${floor} seats is the minimum` : 'Remove a seat'}
                          >−</button>
                          <input
                            id={`seats-${p.key}`}
                            type="number"
                            inputMode="numeric"
                            min={floor}
                            max={p.maxSeats ?? undefined}
                            value={n}
                            onChange={(e) => set(Number(e.target.value) || floor)}
                          />
                          <button type="button" onClick={() => set(n + 1)}
                                  disabled={n >= ceil} aria-label="Add a seat">+</button>
                        </div>
                      </div>

                      {/* The total, done for them. Nobody multiplies a unit price
                          in their head, and "why am I buying two of these?" was
                          the actual reaction to a bare seat count. */}
                      <div className="cr-planpicker-total" aria-live="polite">
                        <span>{n} × {formatMoney(p.amount, p.currency)}</span>
                        <strong>
                          {formatMoney(seatTotal(p.amount, n), p.currency)}
                          <span className="cr-planpicker-per"> / {p.interval === 'year' ? 'year' : 'month'}</span>
                        </strong>
                      </div>

                    </div>
                  );
                })()}

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
      {shown.some((p) => p.seats === 'per_seat') && (
        <p className="cr-planpicker-seathint">
          One seat is you; each person you invite fills another. Add seats later as
          the team grows.
        </p>
      )}

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


const CSS = `
.cr-planpicker-toggle { display: inline-flex; gap: 2px; padding: 2px; margin-bottom: 14px;
  border: 1px solid var(--cr-line-1, #2a2a2a); border-radius: 8px; }
.cr-planpicker-toggle button { background: none; border: 0; cursor: pointer; padding: 6px 14px;
  border-radius: 6px; font-size: 13px; color: var(--cr-fg-3, #999); display: inline-flex;
  align-items: center; gap: 7px; }
.cr-planpicker-toggle button.active { background: var(--cr-ink-2, #1e1e1e); color: var(--cr-fg-1, #eee); }
.cr-planpicker-save { font-size: 10px; letter-spacing: 0.03em;
  padding: 1px 5px; border-radius: var(--cr-radius-xs); background: var(--cr-brand-surf);
  color: var(--cr-brand-500); font-variant-numeric: tabular-nums; }
.cr-planpicker-toggle button:focus-visible,
.cr-planpicker-stepper button:focus-visible { outline: 2px solid var(--cr-brand-500);
  outline-offset: 1px; }
.cr-planpicker-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
.cr-planpicker-card { border: 1px solid var(--cr-line-1, #2a2a2a);
  border-radius: var(--cr-radius-lg); padding: 16px; display: flex; flex-direction: column;
  gap: 8px; transition: border-color var(--cr-dur-fast), transform var(--cr-dur-fast); }
.cr-planpicker-card:hover { border-color: var(--cr-line-2); }
/* Every card's action sits on one line regardless of the content above it, so a
   tier with a seat stepper does not push its button below its neighbours'. */
.cr-planpicker-card > button:last-child,
.cr-planpicker-card > .cr-planpicker-contact { margin-top: auto; }
@media (prefers-reduced-motion: reduce) {
  .cr-planpicker-card, .cr-planpicker-stepper button { transition: none; }
}
.cr-planpicker-name { font-size: 13px; font-weight: 600; color: var(--cr-fg-2, #bbb); }
.cr-planpicker-price { font-size: 26px; font-weight: 600; letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums; color: var(--cr-fg-1); }
.cr-planpicker-per { font-size: 12px; font-weight: 400; color: var(--cr-fg-3, #999); }
.cr-planpicker-seats { display: flex; align-items: center; justify-content: space-between;
  gap: 8px; font-size: 12px; color: var(--cr-fg-3, #999); }
/* Inherits alignment: this renders both on the left-aligned Account card and on
   the centred paywall, and a hardcoded left value stranded it against 500px of empty
   space on the latter. */
.cr-planpicker-seathint { margin: 14px 0 0; font-size: 11.5px; line-height: 1.5;
  color: var(--cr-fg-3); text-align: inherit; max-width: 62ch; }
.cr-planpicker-seatblock { display: flex; flex-direction: column; gap: 8px; }
.cr-planpicker-stepper { display: inline-flex; align-items: stretch;
  border: 1px solid var(--cr-line-2); border-radius: var(--cr-radius-sm);
  overflow: hidden; background: var(--cr-ink-2); }
.cr-planpicker-stepper button { width: 28px; border: 0; background: transparent; cursor: pointer;
  color: var(--cr-fg-2); font-size: 15px; line-height: 1;
  transition: background var(--cr-dur-fast), color var(--cr-dur-fast); }
.cr-planpicker-stepper button:hover:not(:disabled) { background: var(--cr-ink-3); color: var(--cr-fg-1); }
.cr-planpicker-stepper button:active:not(:disabled) { transform: translateY(1px); }
.cr-planpicker-stepper button:disabled { opacity: 0.35; cursor: default; }
.cr-planpicker-stepper input { width: 44px; padding: 5px 0; text-align: center; font-size: 13px;
  background: transparent; color: var(--cr-fg-1); border: 0;
  border-left: 1px solid var(--cr-line-1); border-right: 1px solid var(--cr-line-1);
  font-variant-numeric: tabular-nums; }
.cr-planpicker-stepper input::-webkit-outer-spin-button,
.cr-planpicker-stepper input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.cr-planpicker-stepper input[type=number] { -moz-appearance: textfield; appearance: textfield; }
.cr-planpicker-total { display: flex; align-items: baseline; justify-content: space-between;
  gap: 10px; padding: 7px 9px; border-radius: var(--cr-radius-sm);
  background: var(--cr-ink-2); font-size: 12px; color: var(--cr-fg-3);
  font-variant-numeric: tabular-nums; }
.cr-planpicker-total strong { font-size: 14px; font-weight: 600; color: var(--cr-fg-1); }
.cr-planpicker-contact { font-size: 12px; color: var(--cr-fg-2, #bbb); }
`;
