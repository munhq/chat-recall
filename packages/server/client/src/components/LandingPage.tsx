import { useEffect, useState } from 'react';
import { getPlan, type PlanInfo } from '../services/api';

/**
 * Public marketing + pricing page — the front door, shown to logged-out cloud
 * visitors before any auth bounce (see main.tsx). Lead with the painkiller:
 * we catch LIVE leaked secrets in your AI sessions. Pricing is Stripe-driven
 * (GET /api/billing/plan), never hardcoded.
 */
export default function LandingPage({ onGetStarted }: { onGetStarted: () => void }) {
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  useEffect(() => { getPlan().then(setPlan).catch(() => setPlan({ configured: false, trialDays: 14 })); }, []);

  const price = formatPrice(plan);
  const trialDays = plan?.trialDays ?? 14;

  return (
    <div className="cr-landing">
      <style>{LANDING_CSS}</style>

      <header className="ln-nav">
        <div className="ln-brand"><span className="ln-logo">◆</span> chat-recall</div>
        <button className="ln-btn ln-btn-ghost" onClick={onGetStarted}>Sign in</button>
      </header>

      <section className="ln-hero">
        <div className="ln-badge">🔴 Live secret-leak detection for AI coding sessions</div>
        <h1>You pasted a secret into Claude.<br/><span className="ln-accent">We tell you before it's exploited.</span></h1>
        <p className="ln-sub">
          chat-recall indexes every Claude Code, Gemini, OpenCode &amp; Codex session you run,
          scans them for credentials, and <strong>verifies which leaked keys are still live</strong> —
          then alerts you to rotate them. Plus full-text search and cost analytics across your entire AI history.
        </p>
        <div className="ln-cta-row">
          <button className="ln-btn ln-btn-primary" onClick={onGetStarted}>Start your {trialDays}-day free trial →</button>
          <span className="ln-cta-note">Card required · cancel anytime · no forever-free abuse</span>
        </div>
      </section>

      <section className="ln-features">
        {FEATURES.map((f) => (
          <div className="ln-card" key={f.title}>
            <div className="ln-card-icon">{f.icon}</div>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
        ))}
      </section>

      <section className="ln-pricing">
        <h2>Simple pricing</h2>
        <div className="ln-price-card">
          <div className="ln-plan-name">{plan?.productName || 'chat-recall Pro'}</div>
          <div className="ln-price">{price}</div>
          <ul className="ln-plan-list">
            <li>✓ Live verified secret-leak alerts (Discord / Slack)</li>
            <li>✓ Search across every AI session, plan &amp; task</li>
            <li>✓ Token &amp; cost analytics dashboard</li>
            <li>✓ Cross-device sync &amp; knowledge graph</li>
            <li>✓ Tenant-isolated, secrets never stored in cleartext</li>
          </ul>
          <button className="ln-btn ln-btn-primary ln-btn-block" onClick={onGetStarted}>
            Start {trialDays}-day free trial
          </button>
          <div className="ln-cta-note ln-center">
            {plan && !plan.configured ? 'Pricing finalizing — start a trial to get in early.' : `Then ${price}. Cancel anytime.`}
          </div>
        </div>
      </section>

      <footer className="ln-footer">
        <span>chat-recall</span>
        <span>·</span>
        <button className="ln-link" onClick={onGetStarted}>Sign in</button>
      </footer>
    </div>
  );
}

function formatPrice(plan: PlanInfo | null): string {
  if (!plan || !plan.configured || plan.amount == null) return '—';
  const amount = (plan.amount / 100).toLocaleString(undefined, { style: 'currency', currency: (plan.currency || 'usd').toUpperCase() });
  return plan.interval ? `${amount}/${plan.interval}` : amount;
}

const FEATURES = [
  { icon: '🔑', title: 'Catch live leaks', body: 'Trufflehog-verified detection confirms which keys still work by calling the issuing service. Dead keys are hygiene; live ones page you.' },
  { icon: '🔎', title: 'Search everything', body: 'Full-text + recency-aware search across sessions, plans, tasks, CLAUDE.md and command history — across Claude, Gemini, OpenCode & Codex.' },
  { icon: '📊', title: 'Know your spend', body: 'Token and cost analytics per model and per project. See exactly where your AI budget goes.' },
  { icon: '🔒', title: 'Private by design', body: 'Secrets are redacted before they ever leave your machine. We store masked previews, never raw credentials. Per-tenant isolation, enforced.' },
];

const LANDING_CSS = `
.cr-landing { min-height: 100vh; background: var(--cr-ink-0, #0b0d10); color: var(--cr-fg-1, #e8eaed); font-family: system-ui, -apple-system, sans-serif; overflow-x: hidden; }
.cr-landing * { box-sizing: border-box; }
.ln-nav { display:flex; align-items:center; justify-content:space-between; padding: 20px 32px; max-width: 1100px; margin: 0 auto; }
.ln-brand { font-weight: 700; font-size: 18px; letter-spacing: -0.01em; }
.ln-logo { color: var(--cr-brand-500, #5b8def); margin-right: 6px; }
.ln-hero { max-width: 860px; margin: 64px auto 0; padding: 0 32px; text-align: center; }
.ln-badge { display:inline-block; padding: 6px 14px; border:1px solid var(--cr-line-2, #2a2f37); border-radius: 999px; font-size: 13px; color: var(--cr-fg-2, #aab1bd); margin-bottom: 28px; background: var(--cr-ink-1, #12151a); }
.ln-hero h1 { font-size: clamp(32px, 5vw, 56px); line-height: 1.05; letter-spacing: -0.03em; margin: 0 0 24px; font-weight: 800; }
.ln-accent { color: var(--cr-brand-500, #5b8def); }
.ln-sub { font-size: clamp(16px, 2vw, 20px); line-height: 1.6; color: var(--cr-fg-2, #aab1bd); max-width: 680px; margin: 0 auto 36px; }
.ln-cta-row { display:flex; flex-direction:column; align-items:center; gap: 12px; }
.ln-cta-note { font-size: 13px; color: var(--cr-fg-3, #6b7280); }
.ln-center { text-align:center; }
.ln-btn { font: inherit; font-weight: 600; border-radius: 10px; padding: 12px 22px; cursor: pointer; border: 1px solid transparent; transition: transform .08s ease, background .15s ease, border-color .15s ease; }
.ln-btn:hover { transform: translateY(-1px); }
.ln-btn-primary { background: var(--cr-brand-500, #5b8def); color: #fff; font-size: 16px; box-shadow: 0 6px 24px -8px var(--cr-brand-500, #5b8def); }
.ln-btn-primary:hover { background: var(--cr-brand-600, #4a7ad9); }
.ln-btn-ghost { background: transparent; color: var(--cr-fg-1, #e8eaed); border-color: var(--cr-line-2, #2a2f37); }
.ln-btn-ghost:hover { border-color: var(--cr-brand-500, #5b8def); }
.ln-btn-block { width: 100%; margin-top: 8px; }
.ln-features { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px; max-width: 1000px; margin: 96px auto 0; padding: 0 32px; }
.ln-card { background: var(--cr-ink-1, #12151a); border:1px solid var(--cr-line-1, #1e232b); border-radius: 14px; padding: 24px; }
.ln-card-icon { font-size: 26px; margin-bottom: 12px; }
.ln-card h3 { margin: 0 0 8px; font-size: 17px; }
.ln-card p { margin: 0; font-size: 14px; line-height: 1.55; color: var(--cr-fg-2, #aab1bd); }
.ln-pricing { max-width: 480px; margin: 110px auto 0; padding: 0 32px; text-align: center; }
.ln-pricing h2 { font-size: 28px; letter-spacing: -0.02em; margin: 0 0 28px; }
.ln-price-card { background: var(--cr-ink-1, #12151a); border:1px solid var(--cr-brand-500, #5b8def); border-radius: 18px; padding: 32px; text-align: left; box-shadow: 0 20px 60px -30px var(--cr-brand-500, #5b8def); }
.ln-plan-name { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--cr-fg-3, #6b7280); }
.ln-price { font-size: 40px; font-weight: 800; letter-spacing: -0.02em; margin: 6px 0 20px; }
.ln-plan-list { list-style:none; padding:0; margin: 0 0 24px; display:flex; flex-direction:column; gap: 10px; }
.ln-plan-list li { font-size: 14.5px; color: var(--cr-fg-1, #e8eaed); }
.ln-footer { display:flex; gap: 12px; align-items:center; justify-content:center; color: var(--cr-fg-3, #6b7280); font-size: 13px; padding: 80px 0 48px; }
.ln-link { background:none; border:none; color: var(--cr-brand-500, #5b8def); cursor:pointer; font: inherit; padding:0; }
`;
