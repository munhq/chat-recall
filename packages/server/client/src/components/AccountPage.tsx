import { useEffect, useState } from 'react';
import ConnectMachine from './ConnectMachine';
import SyncRules from './SyncRules';
import FleetHealth from './FleetHealth';
import PlanPicker from './PlanPicker';
import { formatMB } from '../utils/bytes';
import LicenceDeliveryPanel from './LicenceDelivery';
import DataControls from './DataControls';
import {
  getProjectTree,
  getEntitlement, startCheckout, openBillingPortal, getAlertConfig, setAlertConfig,
  testAlertWebhook, getMe, createTeam, getPlan,
  type Entitlement, type PlanInfo,
} from '../services/api';
import { Button } from './primitives';
import { isCloud, logout } from '../services/auth';
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

      {/* Above the subscription card on purpose: someone who has just paid for a
          self-hosted licence is here for the serial and nothing else. It renders
          nothing for a hosted-plan purchase. */}
      {checkoutSession && <LicenceDeliveryPanel sessionId={checkoutSession} />}

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
              <PlanPicker onError={setErr} />
            ) : (
              <div className="acct-actions">
                <Button variant="secondary" onClick={() => setShowPlans(true)} data-testid="see-plans">
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
                <Button variant="secondary" disabled={busy} onClick={manage}>Manage subscription</Button>
              </div>
            )}
            <PlanPicker onError={setErr} />
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
                <Button variant="secondary" disabled={busy} onClick={manage}>Manage subscription</Button>
              </div>
            ) : (
              <PlanPicker onError={setErr} />
            )}
          </>
        )}
      </section>

      <section style={{ marginBottom: 18 }}>
        <ConnectMachine />
      </section>

      <section className="acct-card">
        <h2>Your machines</h2>
        <FleetHealth />
      </section>

      <section className="acct-card">
        <h2>Sync rules</h2>
        <SyncRules />
      </section>

      <AlertsCard onError={setErr} />

      {/* Last on the page: everything above manages the account, this ends it.
          Export sits above the deletes inside the panel for the same reason. */}
      <DataControls projects={dataProjects} />
    </div>
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
  const trialDays = plan?.trialDays ?? 14;

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
            <h1>Start your {trialDays}-day free trial</h1>
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
.acct { max-width: 720px; margin: 0 auto; padding: 32px 24px; color: var(--cr-fg-1,#e8eaed); width:100%; }
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
