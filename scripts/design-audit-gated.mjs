/**
 * The screens a nav sweep cannot reach.
 *
 * Ten screens sit behind auth, edition or billing state, so the sidebar sweep in
 * .shot-app.mjs never rendered one of them — and "32 combinations clean" was
 * only ever a claim about the eight screens it could reach.
 *
 * Two facts about this app decide how the sweep has to work:
 *
 *  1. `isCloud()` is a BUILD-TIME flag (VITE_CLOUD). With it unset, main.tsx
 *     always renders <App />, so AuthPage and DeviceApprovePage are unreachable
 *     at any URL. They need a second dev server built with the flag on.
 *  2. App.tsx has a snap-back: `if (!enabledViews.has(view)) setView('search')`.
 *     A deep link to a view that is not yet enabled paints one frame and bounces
 *     to Conversations. So every stub must be installed BEFORE first paint —
 *     page.route before page.goto, never after.
 *
 * Everything here stubs RESPONSES, never the rendering. What gets audited is the
 * real component tree against real markup.
 */
import { chromium } from 'playwright';
import { AUDIT } from './design-audit-lib.mjs';

const APP = process.env.APP || 'http://127.0.0.1:5174';   // default build
const CLOUD = process.env.CLOUD || 'http://127.0.0.1:5176'; // built with VITE_CLOUD=1
const OUT = process.env.OUT;
const THEMES = (process.env.THEMES || 'dark,light').split(',');
const DEVICES = (process.env.DEVICES || 'desktop,mobile').split(',');

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** Capabilities with the account/team features on, so ?view= is not snapped back. */
const CAPS = {
  edition: 'cloud',
  serverMode: 'server',
  authProvider: 'none',
  socialProviders: [],
  features: { account: true, teams: true, settings: true, security: true, code: true, tasks: true, toolkit: true, insights: true },
};

const ME = {
  user: { sub: 'demo', email: 'demo@example.com', name: 'Demo' },
  teams: [{ team_slug: 'demo', team_name: 'Demo team', role: 'owner' }],
  isOperator: true,
};

// `selfServe` is what gates the whole price block. Without it PlanPicker mounts
// and renders three bare names, which is why this screen produced a file
// byte-identical to `account` and still passed.
const PLANS = {
  configured: true,
  billingEnabled: true,
  trialDays: 14,
  plans: [
    { key: 'solo-monthly', label: 'Solo', seats: 'fixed', amount: 900, currency: 'usd', interval: 'month', selfServe: true },
    { key: 'team-monthly', label: 'Team', seats: 'per_seat', amount: 1900, currency: 'usd', interval: 'month', minSeats: 2, maxSeats: 50, selfServe: true },
    { key: 'enterprise', label: 'Enterprise', contact: 'hello@example.com', selfServe: false },
  ],
};

/** The settings screen reads one endpoint and renders nothing without it. */
const SETTINGS = {
  settings: {
    v: 1,
    embedding: { provider: 'none' },
    summary: { provider: 'none' },
    // The REAL SourcesEnabled shape, every key present. A partial one crashed
    // the screen on `sources.enabled.common.mcps` — the audit's own stub was
    // the reason `settings` never rendered.
    sources: {
      enabled: {
        claude: { sessions: true, plans: true, tasks: true, pasteCache: true, history: true,
                  skills: true, agents: true, commands: true, hooks: true, plugins: true },
        gemini: { sessions: true, plans: true, brain: true, extensions: true },
        opencode: { sessions: true, plans: true, todos: true, skills: true },
        codex: { sessions: true, plugins: true, skills: true },
        agy: { sessions: true, plans: true },
        cursor: { sessions: true, skills: true, agents: true, commands: true },
        common: { mcps: true, agentMd: true },
      },
    },
    privacy: {
      redactIndex: true, redactionRules: [], projectDenylist: [], projectAllowlist: [],
      redactToolOutputs: true, redactPasteCache: true, redactFilePaths: false,
    },
    sync: {
      enabled: true, endpoint: 'https://example.com',
      upload: { raw: false, findings: true, sessionMeta: true, dismissals: true, customRules: true },
      excludeTools: [], excludeProjects: [], excludePreviewPatterns: [],
    },
  },
  presets: {
    embeddingProviders: ['none', 'ollama', 'gemini', 'openai-compat'],
    summaryProviders: ['none', 'ollama', 'openai-compat', 'cli'],
    summaryCliPresets: ['claude', 'gemini'],
    summaryCliPresetCommands: { claude: 'claude -p', gemini: 'gemini -p' },
    embeddingHints: {}, summaryHints: {},
  },
  status: { ollama: { reachable: false }, cli: { available: true }, cliDetected: {} },
};

const BILLING = {
  billingEnabled: true, entitled: false, onTrial: false, trialDaysLeft: 0,
  hasSubscription: false, plan: null, gate: 'subscribe', tenantFeatures: ['team'],
};

const LICENCE = {
  serial: 'CR-DEMO-0000-0000', seats: 5, email: 'demo@example.com',
  features: ['team', 'sso'], issuedAt: Date.now(),
};

/**
 * PROOF OF RENDER. Every screen carries `expect`: text that appears only when
 * THAT screen is on the page.
 *
 * Without it this sweep reported "clean" on screens it never rendered, which is
 * worse than reporting nothing. `settings` scored an error card reading "Failed
 * to load settings: Not Found" and passed, because an error card has good
 * contrast and square corners. `planpicker` produced a file byte-identical to
 * `account` — the plan branch never mounted — and passed twice over. A sweep
 * that cannot tell a screen from its absence is not evidence.
 */
const APP_SCREENS = [
  { slug: 'settings', url: '/?view=settings', expect: 'Sources' },
  { slug: 'connect', url: '/?view=connect&device=my-laptop', expect: 'chat-recall' },
  { slug: 'account', url: '/?view=account', expect: 'Display name' },
  { slug: 'team', url: '/?view=team', expect: 'Team' },
  // PlanPicker renders inside AccountPage's dormant branch when entitled=false.
  { slug: 'planpicker', url: '/?view=account', wait: 1800, expect: 'Seats' },
  // LicenceDelivery mounts purely on the URL shape; the session id is validated
  // client-side against /^cs_[A-Za-z0-9_]{10,200}$/.
  { slug: 'licence', url: '/?view=account&checkout=success&session_id=cs_test_aaaaaaaaaaaaaaaa', expect: 'CR-DEMO-0000-0000' },
  // AdminPage is absent from URL_VIEWS, so there is NO url that reaches it.
  { slug: 'admin', url: '/?view=home', click: '[data-testid="open-admin"]', expect: 'Tenants' },
];

/** Screens that only exist in a VITE_CLOUD build. */
const CLOUD_SCREENS = [
  { slug: 'auth', url: '/', signedIn: false, expect: 'Sign in' },
  { slug: 'auth-reset', url: '/?token=abc123', signedIn: false, expect: 'password' },
  { slug: 'device-approve', url: '/device?user_code=WDJB-MJHT', signedIn: true, expect: 'WDJB' },
];

async function stub(ctx, { signedIn = true } = {}) {
  // Installed on the CONTEXT, so they are live before the first navigation.
  await ctx.route('**/api/capabilities', (r) => r.fulfill(json(CAPS)));
  await ctx.route('**/api/me', (r) => r.fulfill(json(ME)));
  await ctx.route('**/api/billing/plans', (r) => r.fulfill(json(PLANS)));
  await ctx.route('**/api/settings', (r) => r.fulfill(json(SETTINGS)));
  await ctx.route('**/api/billing', (r) => r.fulfill(json(BILLING)));
  await ctx.route('**/api/licence/for-session*', (r) => r.fulfill(json(LICENCE)));
  await ctx.route('**/api/auth/get-session', (r) =>
    r.fulfill(json(signedIn ? { user: { id: 'u1', email: 'demo@example.com', twoFactorEnabled: false } } : {})));
  await ctx.route('**/api/auth/device/**', (r) => r.fulfill(json({ ok: true })));
  await ctx.route('**/api/admin**', (r) => r.fulfill(json({
    totals: { tenants: 240, sessions: 180, chunks: 77, raw: 42, findings: 32, verified: 1 },
    tenants: [],
  })));
  // ConnectTokenPage self-navigates to '/' once sync reports sessions > 0, which
  // would replace the page mid-screenshot. Report zero so it stays put.
  // The REAL shape. An earlier version of this stub omitted `rawArchived`, and
  // TopBar's tooltip called .toLocaleString() on it — one missing field took the
  // whole page down and, with it, the admin button this sweep needs to click.
  await ctx.route('**/api/status/sync*', (r) => r.fulfill(json({
    sessions: 0, rawArchived: 0, rawBytes: 0,
    newestSessionAgeMs: null, sourceTypes: {}, progress: null, lastSyncAgeMs: null,
  })));
}

const findings = [];
const b = await chromium.launch();

// WARM BOTH DEV SERVERS FIRST.
//
// Vite compiles a route on its first request. The first screen of the sweep
// therefore raced the compile and scored a half-mounted page — `device-approve`
// failed on every full run and passed on every single-screen run, which reads
// like a flake and is not one. One throwaway load per base removes the race.
for (const base of [APP, CLOUD]) {
  const warm = await b.newContext();
  const wp = await warm.newPage();
  await wp.goto(base + '/', { waitUntil: 'networkidle' }).catch(() => {});
  await wp.waitForTimeout(500);
  await warm.close();
}

for (const theme of THEMES) {
  for (const dev of DEVICES) {
    const [width, height] = dev === 'desktop' ? [1440, 900] : [390, 844];

    for (const [base, screens] of [[APP, APP_SCREENS], [CLOUD, CLOUD_SCREENS]]) {
      for (const sc of screens) {
        const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
        await ctx.addInitScript(`try { localStorage.setItem('cr-theme', '${theme}'); } catch {}`);
        await stub(ctx, { signedIn: sc.signedIn });
        const p = await ctx.newPage();
        const errs = [];
        p.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
        await p.goto(base + sc.url, { waitUntil: 'networkidle' }).catch(() => {});
        await p.waitForTimeout(sc.wait ?? 1200);
        // WAIT FOR THE MARKER, do not hope for it. main.tsx picks the root from
        // an async session response, so a slow one renders a DIFFERENT screen
        // under this screen's name — that is how `device-approve` failed on a
        // different combination every run and passed on every single-screen
        // one. A fixed timeout cannot fix a race; waiting on the thing you are
        // asserting can. Bounded, so a screen that genuinely never mounts still
        // fails instead of hanging.
        if (sc.expect) {
          await p
            .waitForFunction(
              (needle) => (document.body.innerText || '').toLowerCase().includes(needle),
              sc.expect.toLowerCase(),
              { timeout: 6000 },
            )
            .catch(() => {});
        }
        if (sc.click) {
          const el = p.locator(sc.click).first();
          if (await el.count()) { await el.click().catch(() => {}); await p.waitForTimeout(1200); }
          else { console.log(`${sc.slug.padEnd(15)} ${theme.padEnd(5)} ${dev.padEnd(7)} SKIPPED — ${sc.click} not present`); await ctx.close(); continue; }
        }
        const a = await p.evaluate(AUDIT);
        await p.screenshot({ path: `${OUT}/${sc.slug}-${theme}-${dev}.png`, fullPage: dev === 'desktop' });
        const flags = [];
        // Did the named screen actually mount? A missing marker, or a load
        // failure standing in its place, is a FINDING — never a pass.
        const body = await p.evaluate(() => document.body.innerText || '');
        if (sc.expect && !body.toLowerCase().includes(sc.expect.toLowerCase())) {
          flags.push(`NOT RENDERED (no "${sc.expect}")`);
        }
        const failed = body.match(/Failed to load[^\n]{0,60}|Could not [a-z ]{0,30}: [^\n]{0,40}/i);
        if (failed) flags.push(`ERROR STATE: ${failed[0].trim()}`);
        if (a.scrollWidth > width) flags.push(`OVERFLOW +${a.scrollWidth - width}`);
        if (a.contrast.length) flags.push(`contrast ${a.contrast.length}`);
        if (a.small.length) flags.push(`sub12px ${a.small.length}`);
        if (a.radius.length) flags.push(`radius ${a.radius.length}`);
        if (a.shadow.length) flags.push(`shadow ${a.shadow.length}`);
        if (a.panning?.length) flags.push(`pans ${a.panning.map((x) => x.cls + '+' + x.over).join(',')}`);
        console.log(`${sc.slug.padEnd(15)} ${theme.padEnd(5)} ${dev.padEnd(7)} theme=${a.theme} ${flags.length ? flags.join(' · ') : 'clean'}`);
        if (errs.length) console.log(`  pageerrors: ${[...new Set(errs)].slice(0, 2).join(' | ')}`);
        findings.push({ screen: sc.slug, theme, dev, flags, ...a });
        await ctx.close();
      }
    }
  }
}

await b.close();
const fs = await import('node:fs');
fs.writeFileSync(`${OUT}/audit-gated.json`, JSON.stringify(findings, null, 1));
console.log(`\ngated audit written to ${OUT}/audit-gated.json`);

// A sweep that prints its failures and exits 0 is a sweep nobody notices
// failing. Anything flagged — including a screen that never mounted — is a
// non-zero exit.
const bad = findings.filter((f) => f.flags && f.flags.length);
if (bad.length) {
  console.log(`\n${bad.length} screen/theme/device combination(s) FAILED:`);
  for (const f of bad) console.log(`  ${f.screen} ${f.theme} ${f.dev} — ${f.flags.join(' · ')}`);
  process.exit(1);
}
