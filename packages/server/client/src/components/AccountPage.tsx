import { useEffect, useState } from 'react';
import {
  getEntitlement, startCheckout, openBillingPortal, getAlertConfig, setAlertConfig,
  testAlertWebhook, getMe, createTeam, getPlan,
  type Entitlement, type PlanInfo,
} from '../services/api';
import { Button } from './primitives';

/**
 * Cloud Account view: subscription status + the secret-alert webhook. Distinct
 * from the local Settings dialog (which is filesystem-collector config). Device
 * sync tokens are managed via the CLI for now.
 */
export default function AccountPage({ onClose }: { onClose: () => void }) {
  const [ent, setEnt] = useState<Entitlement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { getEntitlement().then(setEnt).catch((e) => setErr(String(e.message || e))); }, []);

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
        <Button variant="ghost" onClick={onClose}>← Back</Button>
      </div>
      {err && <div className="acct-err">{err}</div>}

      <section className="acct-card">
        <h2>Subscription</h2>
        {!ent ? <p className="muted">Loading…</p> : !ent.billingEnabled ? (
          <p className="muted">Billing isn't enabled on this deployment — all features are available.</p>
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
            <div className="acct-actions">
              {ent.hasSubscription
                ? <Button variant="secondary" disabled={busy} onClick={manage}>Manage subscription</Button>
                : <StartTrialButton onError={setErr} />}
            </div>
          </>
        )}
      </section>

      <AlertsCard onError={setErr} />
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

/** Full-screen gate shown when the tenant isn't entitled (lapsed/never subscribed
 *  or brand-new with no workspace). The only way past it is to start the trial. */
export function SubscribeScreen() {
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { getPlan().then(setPlan).catch(() => {}); }, []);
  const trialDays = plan?.trialDays ?? 14;
  return (
    <div className="sub-screen">
      <style>{ACCT_CSS}</style>
      <div className="sub-box">
        <div className="sub-logo">◆ chat-recall</div>
        <h1>Start your {trialDays}-day free trial</h1>
        <p className="muted">Your subscription is required to access your sessions, search, analytics and live secret-leak
          alerts. Card required, cancel anytime — no charge until the trial ends.</p>
        {err && <div className="acct-err">{err}</div>}
        <StartTrialButton onError={setErr} size="lg" />
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
.acct-head h1 { font-size: 26px; margin: 0; letter-spacing:-0.02em; }
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
.sub-screen { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background: var(--cr-ink-0,#0b0d10); padding:24px; z-index: 1000; }
.sub-box { max-width: 460px; text-align:center; }
.sub-logo { color: var(--cr-brand-500,#5b8def); font-weight:700; margin-bottom: 20px; }
.sub-box h1 { font-size: 28px; letter-spacing:-0.02em; margin: 0 0 14px; }
`;
