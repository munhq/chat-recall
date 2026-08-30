import { useEffect, useState } from 'react';
import ConnectMachine from './ConnectMachine';
import SyncRules from './SyncRules';
import FleetHealth from './FleetHealth';
import PlanPicker from './PlanPicker';
import { formatMB } from '../utils/bytes';
import LicenceDeliveryPanel from './LicenceDelivery';
import DataControls from './DataControls';
import TwoFactorCard from './TwoFactorCard';
import ProfileCard from './ProfileCard';
import {
  getProjectTree,
  getEntitlement, startCheckout, openBillingPortal, getAlertConfig, setAlertConfig,
  testAlertWebhook, getMe, createTeam, getPlan,
  type Entitlement, type PlanInfo,
} from '../services/api';
import { Button } from './primitives';
import { isCloud, logout, resendVerificationEmail, verifyEmailWithOtp } from '../services/auth';
import { completedCheckoutSessionId } from '../utils/checkout';

/** Days remaining at which the plan picker stops waiting to be asked. */
const TRIAL_NUDGE_DAYS = 3;

/**
 * Cloud Account view: subscription status, connected devices (sync-token
 * minting + revocation), and the secret-alert webhook. Distinct from the
 * local Settings dialog (which is filesystem-collector config).
 */
export default function AccountPage({ onClose }: { onClose: () => void }) {
  const [ent, setEnt] = useState<Entitlement | null>(null);
  // Opened by hand, or automatically once the trial is close enough that
  // choosing a plan is the useful thing to show rather than an interruption.
  const [showPlans, setShowPlans] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Stripe substitutes {CHECKOUT_SESSION_ID} into the success URL, so its
  // presence means "someone just finished paying". Read once: the panel below
  // exchanges it for the licence serial a self-host buyer came here for.
  const [checkoutSession] = useState<string | null>(() => completedCheckoutSessionId());
  const [dataProjects, setDataProjects] = useState<string[]>([]);
  useEffect(() => {
    void getProjectTree()
      .then((t) => {
        const out: string[] = [];
        const walk = (ns: Array<{ id: string; count: number; children?: any[] }>) => {
          for (const n of ns) {
            if (n.count > 0) out.push(n.id);
            if (n.children?.length) walk(n.children);
          }
        };
        walk((t as any)?.nodes ?? t ?? []);
        setDataProjects([...new Set(out)].sort());
      })
      .catch(() => { /* no list ⇒ the per-project control stays hidden */ });
  }, []);

  useEffect(() => {
    getEntitlement()
      .then((e) => {
        setEnt(e);
        // Open the picker unasked only when the trial is nearly over, which is
        // when choosing a plan stops being an interruption and becomes the
        // thing the page is for.
        if (e.onTrial && e.trialDaysLeft != null && e.trialDaysLeft <= TRIAL_NUDGE_DAYS) setShowPlans(true);
      })
      .catch((e) => setErr(String(e.message || e)));
  }, []);

  async function manage() {
    setBusy(true); setErr('');
    try { window.location.assign(await openBillingPortal()); }
    catch (e: any) { setErr(String(e.message || e)); setBusy(false); }
  }

  return (
    <div className="acct">
      <style>{ACCT_CSS}</style>
      <div className="acct-head">
        <h1>Account</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Sign-out lives here as well as in the sidebar chip, because this
              view renders WITHOUT the sidebar (App.tsx renders AccountPage in a
              bare app-row). Without this, the page a user opens looking for
              account controls is the one page where leaving is impossible. */}
          {isCloud() && (
            <Button variant="ghost" onClick={() => logout()} data-testid="account-signout">Sign out</Button>
          )}
          <Button variant="ghost" onClick={onClose}>← Back</Button>
        </div>
      </div>
      {err && <div className="acct-err">{err}</div>}

      {/* Above everything on purpose: someone who has just paid for a self-hosted
          licence is here for the serial and nothing else. It renders nothing for
          a hosted-plan purchase. */}
      {checkoutSession && <LicenceDeliveryPanel sessionId={checkoutSession} />}

      <div className="acct-layout">
        <AccountNav />

        <div className="acct-main">
          <AcctSection id="sec-profile" title="Profile" blurb="Who you are signed in as.">
            <ProfileCard onError={setErr} />
          </AcctSection>

          {/* Security is one group, not three cards scattered between billing and
              sync rules. Someone auditing their own account should never have to
              scroll past a plan picker to find the second half of it. */}
          <AcctSection
            id="sec-security"
            title="Security"
            blurb="What stands between a stolen password and everything you have synced."
          >
            <TwoFactorCard />
            <AlertsCard onError={setErr} />
          </AcctSection>

          <AcctSection id="sec-billing" title="Billing" blurb="Your plan, and what changes when it ends.">
            <SubscriptionCard
              ent={ent} busy={busy} showPlans={showPlans}
              onShowPlans={() => setShowPlans(true)} onManage={manage} onError={setErr}
            />
          </AcctSection>

          {/* The two device cards are now adjacent. "Connect a machine" used to sit
              between Subscription and Your machines, so the one pair that belong
              together were the one pair separated. */}
          <AcctSection id="sec-machines" title="Machines" blurb="The devices that sync to this account.">
            <section className="acct-card"><ConnectMachine /></section>
            <section className="acct-card">
              <h2>Your machines</h2>
              <FleetHealth />
            </section>
          </AcctSection>

          <AcctSection
            id="sec-data"
            title="Data"
            blurb="What syncs, what you can take away, and what you can erase."
          >
            <section className="acct-card">
              <h2>Sync rules</h2>
              <SyncRules />
            </section>
            <DataControls projects={dataProjects} />
          </AcctSection>
        </div>
      </div>
    </div>
  );
}

/**
 * One titled group of cards.
 *
 * The page was eight cards in a flat column with no grouping, so "where do I
 * change my password" and "where do I turn on 2FA" had the same answer: scroll
 * and read every heading. A group label costs one line and turns a list into a
 * structure.
 */
function AcctSection(
  { id, title, blurb, children }: { id: string; title: string; blurb: string; children: React.ReactNode },
) {
  return (
    <section className="acct-sec" id={id} aria-labelledby={`${id}-h`}>
      <div className="acct-sec-head">
        <h2 id={`${id}-h`}>{title}</h2>
        <p className="acct-sec-blurb">{blurb}</p>
      </div>
      {children}
    </section>
  );
}

const ACCT_NAV = [
  ['sec-profile', 'Profile'],
  ['sec-security', 'Security'],
  ['sec-billing', 'Billing'],
  ['sec-machines', 'Machines'],
  ['sec-data', 'Data'],
] as const;

/**
 * The section rail.
 *
 * A rail rather than tabs: every section here is short, and tabs would hide four
 * fifths of an account page behind a click for no gain. This keeps one scroll —
 * so ctrl-F still finds everything — and adds a map of it.
 *
 * The highlight follows the scroll through an IntersectionObserver rather than
 * the URL hash, because a hash only changes when something is clicked and would
 * sit on "Profile" the whole way down the page.
 */
function AccountNav() {
  const [active, setActive] = useState<string>(ACCT_NAV[0][0]);
  useEffect(() => {
    const seen = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.intersectionRatio);
        let best = ''; let ratio = -1;
        for (const [id, r] of seen) if (r > ratio) { best = id; ratio = r; }
        if (best && ratio > 0) setActive(best);
      },
      // A band across the upper middle of the viewport: the section a reader is
      // actually looking at, not whichever one happens to touch the top edge.
      { rootMargin: '-12% 0px -55% 0px', threshold: [0, 0.25, 0.5, 1] },
    );
    for (const [id] of ACCT_NAV) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);

  return (
    <nav className="acct-nav" aria-label="Account sections">
      <ul>
        {ACCT_NAV.map(([id, label]) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className={active === id ? 'is-active' : undefined}
              aria-current={active === id ? 'true' : undefined}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                setActive(id);
              }}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The subscription card, lifted out of the page body.
 *
 * It was ~100 lines of branching JSX inline in AccountPage's return, which is a
 * large part of why the page read as a wall: the one card with four states
 * (trialing, dormant, subscribed, billing-disabled) sat in the middle of seven
 * simple ones. The branches are unchanged — only their address is.
 */
function SubscriptionCard(
  { ent, busy, showPlans, onShowPlans, onManage, onError }: {
    ent: Entitlement | null;
    busy: boolean;
    showPlans: boolean;
    onShowPlans: () => void;
    onManage: () => void;
    onError: (s: string) => void;
  },
) {
  return (
    <section className="acct-card">
      <h2>Subscription</h2>
      {!ent ? <p className="muted">Loading…</p> : ent.onTrial && ent.entitled !== false ? (
        <>
          <div className="acct-row">
            <span>Trial</span>
            <span>
              {(ent.trialDaysLeft ?? 0) <= 0
                ? 'ends today'
                : `${ent.trialDaysLeft} day${ent.trialDaysLeft === 1 ? '' : 's'} left`}
            </span>
          </div>
          {/* The actual date. "13 days left" is a number to do arithmetic on;
              a date is something to plan around, and this branch never showed
              one even though the other branch does. */}
          {ent.currentPeriodEnd && (
            <div className="acct-row">
              <span>Ends</span>
              <span>{new Date(ent.currentPeriodEnd).toLocaleDateString()}</span>
            </div>
          )}
          <p className="muted">
            No card needed for the trial. When it ends, recall switches off — searches and session
            reads stop, and new sessions stop syncing. Nothing is deleted: your history stays on
            the server, export keeps working, and subscribing turns it all back on.
          </p>
          {/* The picker is not open by default while the trial is healthy.
              Three priced cards with seat spinners under "14 days left" asks
              for a purchase decision on day one, which is the one thing a
              trial exists to postpone. It opens on request, and opens itself
              once the end is near enough to be the point. */}
          {showPlans ? (
            <PlanPicker onError={onError} />
          ) : (
            <div className="acct-actions">
              <Button variant="secondary" onClick={onShowPlans} data-testid="see-plans">
                See plans
              </Button>
            </div>
          )}
        </>
      ) : !ent.billingEnabled ? (
        <p className="muted">Billing isn't enabled on this deployment — all features are available.</p>
      ) : ent.entitled === false ? (
        <>
          {/* DORMANT — the floor a lapsed tenant lands on, never bought. Stated
              as the one thing that changed, not as an expired-status badge,
              which read as "broken" to the person deciding whether to pay. */}
          <div className="acct-row">
            <span>Plan</span>
            <span className="badge badge-free" data-testid="free-plan-badge">Dormant</span>
          </div>
          <p className="muted">
            Recall is switched off: searches and session reads are refused, and new sessions are
            not syncing. Nothing was deleted — your history is intact and export keeps working.
            Subscribe and one <code>chat-recall sync --full</code> brings the server current.
          </p>
          {/* The meters, from the same payload the server enforces with — the
              page must never show a fuller or emptier meter than the gate acts
              on. Rendered only when the server sent usage (metered tenants). */}
          {ent.usage && ent.limits && (
            <div className="acct-row" data-testid="free-usage-meter">
              <span>Sync this month</span>
              <span>
                {formatMB(ent.usage.monthBytes)}
                {ent.limits.syncBytesPerMonth != null && ` of ${formatMB(ent.limits.syncBytesPerMonth)}`}
                {ent.limits.syncStorageBytes != null &&
                  ` · stored ${formatMB(ent.usage.storedBytes)} of ${formatMB(ent.limits.syncStorageBytes)}`}
              </span>
            </div>
          )}
          {ent.hasSubscription && (
            <div className="acct-actions">
              <Button variant="secondary" disabled={busy} onClick={onManage}>Manage subscription</Button>
            </div>
          )}
          <PlanPicker onError={onError} />
        </>
      ) : (
        <>
          <div className="acct-row">
            <span>Status</span>
            <span className={`badge badge-${ent.status}`}>{labelFor(ent.status)}</span>
          </div>
          {ent.currentPeriodEnd && (
            <div className="acct-row"><span>{ent.status === 'trialing' ? 'Trial ends' : 'Renews'}</span>
              <span>{new Date(ent.currentPeriodEnd).toLocaleDateString()}</span></div>
          )}
          {ent.hasSubscription ? (
            <div className="acct-actions">
              <Button variant="secondary" disabled={busy} onClick={onManage}>Manage subscription</Button>
            </div>
          ) : (
            <PlanPicker onError={onError} />
          )}
        </>
      )}
    </section>
  );
}

function StartTrialButton({ onError, size = 'md' }: { onError: (s: string) => void; size?: 'md' | 'lg' }) {
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true); onError('');
    try {
      let url: string;
      try { url = await startCheckout(); }
      catch (e: any) {
        if (/no team/i.test(String(e.message || e))) {
          const me = await getMe().catch(() => null);
          await createTeam(me?.user.email?.split('@')[0]?.replace(/[^a-z0-9]/gi, '') || 'workspace');
          url = await startCheckout();
        } else throw e;
      }
      window.location.assign(url);
    } catch (e: any) { onError(String(e.message || e)); setBusy(false); }
  }
  return (
    <Button variant="primary" size={size} disabled={busy} onClick={start} style={size === 'lg' ? { marginTop: 20 } : undefined}>
      {busy ? 'Starting…' : 'Start free trial'}
    </Button>
  );
}

function AlertsCard({ onError }: { onError: (s: string) => void }) {
  const [url, setUrl] = useState('');
  const [saved, setSaved] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { getAlertConfig().then((c) => { setUrl(c.webhookUrl); setSaved(c.webhookUrl); }).catch(() => {}); }, []);

  async function save() {
    onError(''); setMsg('');
    try { const r = await setAlertConfig(url.trim()); setSaved(r.webhookUrl); setMsg('Saved.'); }
    catch (e: any) { onError(String(e.message || e)); }
  }
  async function test() {
    onError(''); setMsg('Sending…');
    try { const r = await testAlertWebhook(url.trim()); setMsg(r.ok ? 'Test sent ✓' : `Failed (${r.status || r.error})`); }
    catch (e: any) { onError(String(e.message || e)); setMsg(''); }
  }

  return (
    <section className="acct-card">
      <h2>Secret-leak alerts</h2>
      <p className="muted">When a <strong>live</strong> secret is detected in your sessions, we POST an alert to this webhook
        (Discord or Slack incoming-webhook URL). We never send the raw secret — only a masked preview.</p>
      <input className="acct-input" type="url" placeholder="https://discord.com/api/webhooks/…  or  https://hooks.slack.com/…"
        value={url} onChange={(e) => setUrl(e.target.value)} />
      <div className="acct-actions">
        <Button variant="primary" disabled={url.trim() === saved.trim()} onClick={save}>Save</Button>
        <Button variant="secondary" disabled={!url.trim()} onClick={test}>Send test</Button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </section>
  );
}

/** Full-screen gate shown when the tenant isn't entitled. It serves two very
 *  different visitors and must not confuse them:
 *
 *    - BRAND NEW, no workspace  → create one; that provisions the no-card trial.
 *    - LAPSED, workspace exists → their trial is spent, so the only way forward is
 *      to subscribe. Showing them "create your workspace" was a dead end: the
 *      bootstrap no-ops when a team already exists, reloads, and lands back here
 *      with no route to payment — precisely the person most likely to pay. */
/**
 * Why this screen is in front of you, in its own words.
 *
 * `ent` is null while the lookup is in flight or if it failed; the wording then
 * stays neutral rather than inventing a reason.
 */
function gateReason(ent: { status?: string; hasSubscription?: boolean } | null): {
  title: string; detail: string;
} {
  // This sentence has been wrong twice, each time because the tier moved and the
  // copy did not: it promised a metered free sync after sync left the free tier,
  // and a recent-history window months after the window was removed. Say only
  // what a lapsed account actually keeps — the history on the server, and export.
  const kept = `Recall is switched off until you subscribe: searches and session reads are refused, and new sessions are not syncing. Nothing is deleted — your full history is intact on the server, export keeps working, and subscribing turns it all back on.`;
  if (ent?.status === 'trialing') return { title: 'Your trial has ended', detail: kept };
  if (ent?.status === 'past_due') return {
    title: 'Your last payment did not go through',
    detail: 'Your history is kept and nothing is deleted. Update your payment method to turn recall back on.',
  };
  if (ent?.status === 'canceled' || ent?.hasSubscription) return {
    title: 'Your subscription has ended', detail: kept,
  };
  return { title: 'Choose a plan', detail: kept };
}

/**
 * What a brand-new account sees until it confirms its address.
 *
 * EVERY signup lands here, for as long as it takes to reach an inbox. Before
 * this it landed on the dashboard instead — and since an unentitled account has
 * its reads refused, that dashboard rendered empty behind a 12px warning strip.
 * The report was "a blank page with nothing", which is exactly right.
 *
 * There is one action available and it is not on this page, so this page says
 * that and offers the only two things it usefully can: send the mail again, and
 * a way out that is not closing the tab.
 */
export function ConfirmEmailScreen() {
  const [email, setEmail] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { getMe().then((me) => setEmail(me.user.email ?? null)).catch(() => {}); }, []);

  async function resend() {
    if (!email) return;
    setBusy(true); setErr(''); setSent(false);
    const r = await resendVerificationEmail(email);
    setBusy(false);
    if (r.ok) setSent(true); else setErr(r.error || 'could not resend');
  }

  async function submit() {
    if (!email || code.trim().length < 4) return;
    setBusy(true); setErr('');
    const r = await verifyEmailWithOtp(email, code.trim());
    setBusy(false);
    // Reload rather than route: the trial is granted server-side on the next
    // authenticated request, so the whole app needs to re-resolve its gate.
    if (r.ok) window.location.reload();
    else setErr(r.error || 'that code did not work');
  }

  return (
    <div className="sub-screen">
      <style>{ACCT_CSS}</style>
      <div className="sub-box" data-testid="confirm-email-screen">
        <div className="sub-logo">◆ chat-recall</div>
        <h1>Check your inbox</h1>
        <p className="muted">
          We sent a six-digit code to <strong>{email ?? 'your address'}</strong>. Enter it below and your
          free trial starts — nothing is counting down until you do, and there is nothing to pay.
        </p>
        <div style={{ marginTop: 20, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            placeholder="123456"
            inputMode="numeric"
            // Lets iOS and Android offer the code from the mail as a one-tap
            // autofill, which is most of the reason a code is not worse than a
            // link on a phone.
            autoComplete="one-time-code"
            autoFocus
            aria-label="Confirmation code"
            data-testid="otp-input"
            style={{
              flex: 1, padding: '10px 12px', fontSize: 18, letterSpacing: '0.18em',
              fontFamily: 'var(--cr-font-mono)', borderRadius: 'var(--cr-radius-md)',
              border: '1px solid var(--cr-line-1)', background: 'var(--cr-ink-1)',
              color: 'var(--cr-fg-1)',
            }}
          />
          <Button variant="primary" disabled={busy || code.trim().length < 4} onClick={submit} data-testid="verify-otp">
            {busy ? 'Checking…' : 'Confirm'}
          </Button>
        </div>
        {err && <div className="acct-err">{err}</div>}
        {sent && <p className="muted" data-testid="resent">Sent again — check your inbox.</p>}
        <p className="muted" style={{ marginTop: 14 }}>
          Not there? It can take a minute, and it is worth checking spam.
        </p>
        <div className="acct-actions" style={{ marginTop: 12 }}>
          <Button variant="ghost" disabled={busy || !email} onClick={resend} data-testid="resend-verification">
            Send a new code
          </Button>
        </div>
        <div style={{ marginTop: 18 }}>
          <Button variant="ghost" onClick={() => logout()} data-testid="confirm-signout">Sign out</Button>
        </div>
      </div>
    </div>
  );
}

export function SubscribeScreen() {
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // null = still deciding which of the two visitors this is.
  const [hasWorkspace, setHasWorkspace] = useState<boolean | null>(null);
  // Drives the heading, so the screen states the real reason instead of one.
  const [ent, setEnt] = useState<{ status?: string; hasSubscription?: boolean } | null>(null);
  useEffect(() => { getEntitlement().then(setEnt).catch(() => setEnt(null)); }, []);
  useEffect(() => { getPlan().then(setPlan).catch(() => {}); }, []);
  useEffect(() => {
    getMe().then((me) => setHasWorkspace(me.teams.length > 0)).catch(() => setHasWorkspace(false));
  }, []);
  // NO NUMERIC FALLBACK. This was `?? 14`, so the headline rendered
  // "Start your 14-day free trial" for the moment before /api/billing/plans
  // arrived, then snapped to 7 — the first thing a new signup saw was the
  // product changing its own offer in front of them. 14 was also simply wrong:
  // the server has said 7 since the card-trial length was cut, and the site says
  // 7 in eight places.
  //
  // Rendering nothing until the real number lands is the honest version: a
  // heading that appears a beat late beats a heading that lies and corrects
  // itself.
  const trialDays = plan?.trialDays ?? null;

  // First-run bootstrap: the same workspace creation StartTrialButton does, minus
  // Stripe. Creating the team is what provisions the no-card trial server-side.
  async function createWorkspace() {
    setBusy(true); setErr('');
    try {
      const me = await getMe();
      if (me.teams.length === 0) {
        await createTeam(me.user.email?.split('@')[0]?.replace(/[^a-z0-9]/gi, '') || 'workspace');
      }
      window.location.reload();
    } catch (e: any) { setErr(String(e.message || e)); setBusy(false); }
  }

  return (
    <div className="sub-screen">
      <style>{ACCT_CSS}</style>
      <div className="sub-box">
        <div className="sub-logo">◆ chat-recall</div>
        {hasWorkspace === null ? (
          <p className="muted">Loading…</p>
        ) : hasWorkspace ? (
          <>
            {/* Say what actually happened. This was hardcoded to "Your trial has
                ended" for every visitor with a workspace, so a lapsed subscriber
                was told about a trial, and — while a feature-level 402 could
                still reach this screen — so was someone whose trial had a
                fortnight left. A gate that misreports why it is there is one
                nobody can act on. */}
            <h1>{gateReason(ent).title}</h1>
            <p className="muted">{gateReason(ent).detail}</p>
            {err && <div className="acct-err">{err}</div>}
            <PlanPicker onError={setErr} />
            {/* Never a dead end. Without this the only exits were paying or
                closing the tab — no way to sign out, or into another account. */}
            <div style={{ marginTop: 18 }}>
              <Button variant="ghost" onClick={() => logout()} data-testid="gate-signout">Sign out</Button>
            </div>
          </>
        ) : plan && plan.freeTrialDays ? (
          <>
            <h1>Start your {plan.freeTrialDays}-day trial</h1>
            <p className="muted">No card needed. Create your workspace, connect your machine, and your
              AI-session history becomes searchable. When the trial ends, recall switches off until
              you subscribe — nothing is deleted, and export always works.</p>
            {err && <div className="acct-err">{err}</div>}
            <Button variant="primary" disabled={busy} onClick={createWorkspace}>
              {busy ? 'Setting up…' : 'Create your workspace →'}
            </Button>
          </>
        ) : (
          <>
            <h1>{trialDays ? `Start your ${trialDays}-day free trial` : 'Start your free trial'}</h1>
            <p className="muted">Your subscription is required to access your sessions, search, analytics and live secret-leak
              alerts. Card required, cancel anytime — no charge until the trial ends.</p>
            {err && <div className="acct-err">{err}</div>}
            <StartTrialButton onError={setErr} size="lg" />
          </>
        )}
      </div>

    </div>
  );
}

function labelFor(s: Entitlement['status']): string {
  return { active: 'Active', trialing: 'Trialing', past_due: 'Past due', canceled: 'Canceled', none: 'Not subscribed' }[s];
}

const ACCT_CSS = `
.acct { max-width: 1020px; margin: 0 auto; padding: 32px 24px 96px; color: var(--cr-fg-1,#e8eaed); width:100%; }

/* Rail + content. The rail is a map of one scroll, not a tab bar: every section
   here is short, so hiding four fifths of the page behind a click would cost
   ctrl-F and buy nothing. */
.acct-layout { display: grid; grid-template-columns: 180px minmax(0,1fr); gap: 40px; align-items: start; }
.acct-nav { position: sticky; top: 32px; }
.acct-nav ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px; }
.acct-nav a {
  display:block; padding:8px 12px; border-radius:9px; font-size:14px; font-weight:500;
  color: var(--cr-fg-2,#909caf); text-decoration:none; border-left:2px solid transparent;
  transition: color .12s ease, background-color .12s ease, border-color .12s ease;
}
.acct-nav a:hover { color: var(--cr-fg-1,#e8eaed); background: var(--cr-ink-2,#171b21); }
.acct-nav a.is-active {
  color: var(--cr-brand-500,#f5a97f); background: var(--cr-brand-surf); border-left-color: var(--cr-brand-500,#f5a97f);
}
.acct-main { min-width: 0; }

/* A group of cards under one label. */
.acct-sec { margin-bottom: 44px; scroll-margin-top: 24px; }
.acct-sec:last-child { margin-bottom: 0; }
.acct-sec-head { margin-bottom: 14px; }
.acct-sec-head h2 {
  font-size: 12px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase;
  color: var(--cr-fg-2,#909caf); margin: 0 0 4px;
}
.acct-sec-blurb { margin: 0; font-size: 14px; line-height: 1.5; color: var(--cr-fg-3,#6b7280); }

/* Profile card */
.pf-id { display:flex; align-items:center; gap:14px; padding-bottom:18px;
  border-bottom:1px solid var(--cr-line-1,#1e232b); }
.pf-avatar {
  flex:0 0 auto; width:52px; height:52px; border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  font-family: var(--cr-font-display, ui-monospace, monospace);
  font-size:17px; font-weight:700; letter-spacing:-0.02em;
  color: var(--cr-brand-500,#f5a97f);
  background: var(--cr-brand-surf); border:1px solid var(--cr-brand-line);
}
.pf-idtext { min-width:0; }
.pf-name { font-size:17px; font-weight:600; letter-spacing:-0.01em; margin-bottom:3px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pf-mail { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  font-size:13px; color: var(--cr-fg-3,#6b7280); }
.pf-chip { padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; letter-spacing:.02em; }
.pf-chip-ok { background: var(--cr-ok-surf,#10241a); color: var(--cr-ok-500,#3fb950); }
.pf-chip-warn { background: var(--cr-warn-surf,#241d10); color: var(--cr-warn-500,#d29922); }
.pf-warn { display:flex; align-items:center; gap:14px; flex-wrap:wrap;
  margin:16px 0 4px; padding:14px 16px; border-radius:11px;
  background: var(--cr-warn-surf,#241d10); border:1px solid var(--cr-warn-line,#3a2f14); }
.pf-warn > p { flex:1 1 240px; }
.pf-ok { margin:16px 0 4px; padding:10px 14px; border-radius:9px; font-size:13px;
  background: var(--cr-ok-surf,#10241a); border:1px solid var(--cr-ok-line,#1c3a24); color: var(--cr-ok-500,#3fb950); }
.pf-field { margin-top:18px; }
.pf-field > label { display:block; font-size:13px; font-weight:600; margin-bottom:8px; color: var(--cr-fg-2,#909caf); }
.pf-inline { display:flex; gap:10px; align-items:center; }
.pf-inline > *:first-child { flex:1 1 auto; min-width:0; }
.pf-pw { display:flex; flex-direction:column; gap:10px; margin-top:8px;
  padding:16px; border-radius:11px; background: var(--cr-ink-0,#0b0d10); border:1px solid var(--cr-line-1,#1e232b); }

@media (max-width: 860px) {
  /* The rail becomes a scrollable chip row above the content. Sticky, because on
     a phone the sections are far apart and a nav that scrolls away is a nav that
     only works before you need it. */
  .acct-layout { grid-template-columns: minmax(0,1fr); gap: 20px; }
  .acct-nav { position: sticky; top: 0; z-index: 5; margin: 0 -24px; padding: 10px 24px;
    background: var(--cr-ink-0,#0b0d10); border-bottom:1px solid var(--cr-line-1,#1e232b); }
  .acct-nav ul { flex-direction: row; gap:6px; overflow-x:auto; scrollbar-width:none; }
  .acct-nav ul::-webkit-scrollbar { display:none; }
  .acct-nav a { white-space:nowrap; border-left:none; border-bottom:2px solid transparent; border-radius:8px; }
  .acct-nav a.is-active { border-left-color: transparent; border-bottom-color: var(--cr-brand-500,#f5a97f); }
  .acct-sec { margin-bottom: 34px; scroll-margin-top: 64px; }
  .pf-inline { flex-direction: column; align-items: stretch; }
  /* space-between on a narrow row squeezes the value into a two-word column
     against the label. Stack them instead — the label reads as a label either
     way, and the value gets the full width. */
  .acct-row { flex-direction: column; align-items: flex-start; gap: 3px; }
}
.acct-head { display:flex; align-items:center; justify-content:space-between; margin-bottom: 24px; }
.acct-head h1 { font-size: clamp(20px, 5vw, 26px); margin: 0; letter-spacing:-0.02em; }
.acct-card { background: var(--cr-ink-1,#12151a); border:1px solid var(--cr-line-1,#1e232b); border-radius: 14px; padding: 22px; margin-bottom: 18px; }
.acct-card h2 { font-size: 16px; margin: 0 0 14px; }
.acct-row { display:flex; justify-content:space-between; padding: 8px 0; border-bottom:1px solid var(--cr-line-1,#1e232b); font-size:14px; }
.acct-row:last-of-type { border-bottom:none; }
.muted { color: var(--cr-fg-3,#6b7280); font-size: 14px; line-height:1.55; }
.acct-actions { display:flex; gap: 10px; align-items:center; margin-top: 16px; flex-wrap:wrap; }
.acct-input { width:100%; box-sizing:border-box; font: inherit; font-size:14px; padding: 10px 12px; border-radius:9px; border:1px solid var(--cr-line-2,#2a2f37); background: var(--cr-ink-0,#0b0d10); color: var(--cr-fg-1,#e8eaed); margin-top: 8px; }
.acct-err { background: var(--cr-err-surf,#2a1416); border:1px solid var(--cr-err-line,#5a2329); color: var(--cr-err-500,#f87171); padding: 10px 14px; border-radius:9px; margin-bottom:16px; font-size:13px; }
.badge { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight:600; }
.badge-active, .badge-trialing { background: var(--cr-ok-surf,#10241a); color: var(--cr-ok-500,#4ade80); }
.badge-past_due { background: var(--cr-err-surf,#2a1416); color: var(--cr-err-500,#f87171); }
.badge-canceled, .badge-none { background: var(--cr-ink-2,#171b21); color: var(--cr-fg-3,#6b7280); }
.badge-free { background: var(--cr-brand-surf); border:1px solid var(--cr-brand-line); color: var(--cr-brand-500); }
/* Scrolls, and starts from the top once it no longer fits.
   align-items:center on a fixed, non-scrolling box centres overflow OUT of the
   viewport in both directions: below ~900px of height the heading was cut off
   above the top edge and the sign-out button sat past the bottom with no
   scrollbar (body carries overflow:hidden), so the one exit this screen
   deliberately provides became unreachable. */
.sub-screen { position:fixed; inset:0; display:flex; align-items:flex-start; justify-content:center;
  overflow-y:auto; overscroll-behavior:contain;
  background: var(--cr-ink-0,#0b0d10); padding:24px; z-index: 1000; }
/* Wide enough for a three-tier catalogue on one row. At 460px the third tier
   wrapped to its own line, and the bottom-aligned CTAs then left a 150px void
   inside the short cards. */
.sub-box { width:100%; max-width: 900px; margin:auto; text-align:center; }
/* The picker's own grid handles the columns; this just stops a single yearly
   card from stretching to the full width and making the layout jump between
   the Monthly and Yearly tabs. */
/* A capped track, not 1fr. A 1fr track fills the row whatever the count, which
   stretched two yearly cards to 444px and made the width jump on a tab switch;
   it also made justify-content inert, so a wrapped card sat left of a centred
   row. 4 x 210 + 3 x 12 gap = 876, so four tiers fit inside 900 and a single
   card stays card-sized. */
/* Flex, not grid. Grid tracks cannot centre a PARTIAL last row: justify-content
   centres the track group while a lone fourth card still occupies track 1, so it
   sat 222px left of centre under a centred row. */
.sub-box .cr-planpicker-grid { display: flex; flex-wrap: wrap; justify-content: center; }
.sub-box .cr-planpicker-card { flex: 0 1 210px; }
/* Centred only on this host, whose box is centred; on the Account card the same
   block stays flush with the grid above it. */
.sub-box .cr-planpicker-seathint { margin-inline: auto; }
.sub-logo { color: var(--cr-brand-500,#5b8def); font-weight:700; margin-bottom: 20px; }
.sub-box h1 { font-size: 28px; letter-spacing:-0.02em; margin: 0 0 14px; }
`;
