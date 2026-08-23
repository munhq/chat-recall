/**
 * Express server for chat-recall UI backend.
 */

// MUST be first — installs @sentry/node instrumentation before other modules load.
import './instrument.js';
import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import searchRouter from './routes/search.js';
import conversationsRouter from './routes/conversations.js';
import statusRouter from './routes/status.js';
import memoryRouter from './routes/memory.js';
import analyticsRouter from './routes/analytics.js';
import settingsRouter from './routes/settings.js';
import editsRouter from './routes/edits.js';
import activityRouter from './routes/activity.js';
import tasksRouter from './routes/tasks.js';
import sharesRouter from './routes/shares.js';
import toolkitRouter from './routes/toolkit.js';
import secretsRouter from './routes/secrets.js';
import { tenantAuth, validateAuthConfig, authProviderName } from './middleware/auth.js';
// Only the NAMES — the ids and secrets never leave the server.
import { enabledSocialProviders as socialProviderNames } from './auth/better-auth.js';
import { apiLimiter, syncLimiter, rl } from './middleware/rate-limit.js';
import { costMiddleware, startCostTelemetry } from './middleware/request-cost.js';
import metricsRouter, { startBacklogRefresher, logMetricsExposureAtBoot } from './routes/metrics.js';
import adminRouter from './routes/admin.js';
import clientEventsRouter from './routes/client-events.js';
import vaultRouter from './routes/vault.js';
import accountRouter from './routes/account.js';
import { requireEntitlement, requireFeature, billingEnabled } from './util/billing.js';
import { licenceFeatures, ssoAllowed } from './util/entitlements.js';
import projectsRouter from './routes/projects.js';
import ledgersRouter from './routes/ledgers.js';
import contactRouter from './routes/contact.js';
import kgRouter from './routes/kg.js';
import kvRouter from './routes/kv.js';
import diaryRouter from './routes/diary.js';
import syncIntentsRouter from './routes/sync-intents.js';
import filesRouter from './routes/files.js';
import subagentsRouter from './routes/subagents.js';
import codeRouter from './routes/code.js';
import recommendationsRouter from './routes/recommendations.js';
import auditRouter from './routes/audit.js';
import licenceRouter from './routes/licence.js';
import syncRouter from './routes/sync.js';
import teamsRouter from './routes/teams.js';
import teamArtifactsRouter from './routes/team-artifacts.js';
import securityConfigRouter from './routes/security-config.js';
import syncConfigRouter from './routes/sync-config.js';
import fleetHealthRouter from './routes/fleet-health.js';
import billingRouter from './routes/billing.js';
import installRouter from './routes/install.js';
import dataControlsRouter from './routes/data-controls.js';
import { capabilities, isServerMode } from './util/mode.js';
import { advertisedLimits } from './middleware/rate-limit-config.js';
import { cliRelease } from './util/cli-release.js';
import { generateMissingSummariesAllTenants, serverSummaryConfig } from './services/summary-worker.js';
import { sweepSyntheticRetention, sweepLapsedRetention, lapsedRetentionDays } from './services/retention.js';
import { sweepTrialReminders } from './services/trial-reminders.js';
import { embedMissingVectors, serverEmbedderConfigured } from './services/vector-backfill-worker.js';
import { createLogger, setLogContextProvider } from '@chat-recall/engine/core/logger.js';
import { closePgPools } from '@chat-recall/engine/core/store/pg-pool.js';
import { requestContext, attachTenantToContext, logContext } from './middleware/request-context.js';
import { httpObservability } from './middleware/http-observability.js';
import {
  summarySweepsTotal, summariesGeneratedTotal, summariesFailedTotal, summariesSkippedTotal,
  summaryConcurrency, vectorSweepsTotal, vectorsEmbeddedTotal,
} from './metrics/registry.js';

const app = express();
const PORT = parseInt(process.env.PORT || '5000', 10);
const log = createLogger('server');

// Every log line emitted while handling a request gets { reqId, tenant }.
setLogContextProvider(logContext);

// Fail-closed on auth misconfiguration BEFORE we bind a port: an unrecognized
// AUTH_PROVIDER would silently disable auth (SEC-01), and AUTH_DEV_USER=1 in
// production is a login bypass (SEC-04). Crash now rather than serve open.
validateAuthConfig();

// Flipped on SIGTERM so /health starts failing readiness and k8s drains us.
let shuttingDown = false;

// Behind an ingress/Traefik/Cloudflare the client IP is in X-Forwarded-For.
// Trust the first proxy hop so rate limiting keys on the real client, not the
// proxy's single IP. (No proxy in local dev → harmless.)
app.set('trust proxy', 1);

// Where the built client lives. Hoisted above the security middleware because
// the CSP hashes the inline <script> in index.html, so it has to read the very
// file we serve. Consumed again by the static handler further down.
const STATIC_DIR = resolve(process.env.STATIC_DIR || '../client/dist');

/**
 * SHA-256 hashes of every INLINE <script> in every shipped HTML document, in
 * the base64 form a CSP wants.
 *
 * Derived, never typed. Each document carries a pre-paint theme bootstrap that has
 * to run before first paint (a persisted light theme would otherwise flash dark
 * and revert), so it cannot move to an external file, and 'unsafe-inline' would
 * defeat the point of having a script-src at all. A hash pinned by hand would
 * silently stop matching the first time that script is edited by one character,
 * and the failure mode is invisible in dev (no CSP) and total in prod (the
 * theme bootstrap is blocked). Reading it at boot means the policy cannot drift
 * from what actually ships.
 */
function inlineScriptHashes(): string[] {
  const hashes = new Set<string>();

  // EVERY served HTML document, not just the SPA shell. Getting this wrong is
  // not theoretical: the first version read index.html only, and the static
  // marketing pages added later carry their own pre-paint theme bootstrap and a
  // theme toggle. Both were blocked in production, so the public pages were
  // stuck in dark mode with a button that did nothing — a silent failure,
  // because the documents still rendered perfectly.
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 2 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      // assets/ is hashed JS and CSS, never HTML; skipping it keeps boot cheap.
      if (entry.isDirectory() && entry.name !== 'assets' && entry.name !== 'fonts') walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.html')) files.push(full);
    }
  };
  walk(STATIC_DIR, 0);

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    // Inline only: a tag carrying src= loads an external file, which 'self' covers.
    for (const m of source.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      // A JSON-LD block is data, not script. The browser never executes it, so
      // it needs no hash, and including one would be noise in the header.
      if (/type=["']application\/ld\+json["']/i.test(m[0])) continue;
      hashes.add(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
    }
  }
  return [...hashes];
}

// Origin of the crash reporter, so the browser is allowed to POST to it. Parsed
// from the DSN rather than hardcoded: self-hosters point this at their own
// GlitchTip/Sentry, and a wrong literal here silently swallows every crash report.
function sentryOrigin(): string[] {
  const dsn = process.env.GLITCHTIP_DSN || process.env.SENTRY_DSN || '';
  try { return dsn ? [new URL(dsn).origin] : []; } catch { return []; }
}

// ── Security headers ─────────────────────────────────────────────────────────
//
// The browser session is an httpOnly cookie (it was a Bearer token in
// localStorage through the Keycloak era; 6c7f46e moved it). httpOnly means
// script cannot read the session, so XSS no longer hands over a portable
// credential — but it can still act as the user from this origin, so the
// policy below is what keeps foreign script off it in the first place. The
// assumption that has to hold is that no script the app did not ship ever runs
// on this origin. Today it does — there is no dangerouslySetInnerHTML, no rehype-raw
// and no .innerHTML anywhere in the client, so markdown from indexed sessions
// renders through React's escaping. But "we audited it once" is not a control.
// This is the layer that survives one mistake: with a real script-src, an
// injected script cannot execute and cannot exfiltrate the token.
//
// CSP_REPORT_ONLY=1 emits Content-Security-Policy-Report-Only instead, so a
// policy change can be watched in prod before it is allowed to break anything.
const cspReportOnly = process.env.CSP_REPORT_ONLY === '1';
app.use(helmet({
  contentSecurityPolicy: {
    reportOnly: cspReportOnly,
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // No 'unsafe-inline' and no 'unsafe-eval'. The one inline script is hashed.
      scriptSrc: ["'self'", ...inlineScriptHashes()],
      // 'unsafe-inline' IS required here and is a deliberate, bounded call:
      // React writes style="" attributes on nearly every component and several
      // components ship a <style> block. Removing it means rewriting the whole
      // client's styling. Injected CSS cannot run code, so the risk it leaves is
      // defacement and data-exfil via selectors, not session theft.
      // Both are 'self' only, because the three brand webfonts are vendored into
      // public/fonts (client/scripts/sync-fonts.mjs). Before that they came from
      // fonts.googleapis.com, which meant a third party was allowed to serve CSS
      // to this origin — and CSS it serves can restyle any element on the page.
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", ...sentryOrigin()],
      // Nothing here is meant to be framed. Blocks clickjacking outright.
      frameAncestors: ["'none'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      // Stops an injected <base> from re-pointing every relative URL.
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
      // Without a report sink, CSP_REPORT_ONLY only writes to each visitor's
      // browser console — which is exactly the audience that cannot report it.
      // /api/csp-report below logs violations so report-only mode is actually
      // observable before a policy change is enforced.
      reportUri: ['/api/csp-report'],
    },
  },
  // 1 year, subdomains included. NOT preloaded: the preload list is effectively
  // permanent and is the operator's decision, not a default.
  strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true, preload: false },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // Keeps the API's JSON from being sniffed into something executable.
  xContentTypeOptions: true,
  // Same intent as frame-ancestors, for browsers that predate CSP Level 2.
  xFrameOptions: { action: 'deny' },
  // Off: it would require COEP on every embedded resource for no gain here.
  crossOriginEmbedderPolicy: false,
}));

// Middleware
// The browser session is an httpOnly cookie, so the SPA sends every request
// with credentials. Two consequences, both load-bearing:
//
//  1. credentials:true is required or the browser discards the response.
//  2. The spec forbids pairing credentials with a wildcard origin, so the
//     allowlist has to be an explicit origin.
//
// On the unset case, measured against cors@2.8.6 rather than assumed: its
// middlewareWrapper treats a FALSY `origin` as "emit no CORS headers at all"
// and calls next(). So `undefined` and `false` behave identically — neither
// reflects. An earlier revision of this comment claimed the unset case
// reflected the request Origin and was therefore a live vulnerability; that is
// wrong for this version, and reflection would need `origin: true`, a function
// or an array, none of which was ever configured.
//
// `false` is still set explicitly below, for two reasons that are about the
// next reader rather than today's behaviour: it states the intent where
// `undefined` merely happened to be safe, and it fails closed if someone later
// changes the default. It is a no-op for real traffic — this server serves the
// SPA from its own origin, so the browser needs no CORS grant, and the CLI is
// not a browser.
const corsOrigin = process.env.CORS_ORIGIN || undefined;

const authEnabled = !!process.env.AUTH_PROVIDER && process.env.AUTH_PROVIDER !== 'none';
const isProd = process.env.NODE_ENV === 'production';
let corsOriginSetting: string | boolean | undefined = corsOrigin;
if (!corsOrigin && authEnabled && isProd) {
  corsOriginSetting = false; // no Access-Control-Allow-Origin → same-origin only
  log.warn(
    'CORS_ORIGIN is unset while auth is enabled: no CORS headers are sent, so '
    + 'cross-origin calls are refused. Same-origin traffic (the app this server '
    + 'serves) is unaffected. Set CORS_ORIGIN only if another origin must call this API.',
  );
}
app.use(cors({
  origin: corsOriginSetting, // string = allowlist; falsy = emit no CORS headers
  credentials: true,
}));
// Gzip/deflate compression. Skips already-compressed responses (images,
// pre-compressed assets) automatically. Threshold avoids the overhead on
// tiny payloads where the per-response framing exceeds the savings. Most
// of our /api/* responses are JSON in the 1KB-5MB range — exactly where
// compression pays off (typically 70-85% wire-size reduction).
app.use(compression({ threshold: 1024 }));
// Establish per-request correlation (reqId + tenant, echoed as x-request-id)
// BEFORE the body parsers so even a parse error is traceable to one log line.
app.use(requestContext);
// /api/sync carries whole (redacted) conversation batches — it gets its own
// 32mb parser below; everything else keeps the tight 100kb bound.
const smallJson = express.json({ limit: '100kb' });
// /api/sync gets a big parser; /api/billing/webhook must stay RAW (Stripe's
// signature is over the exact bytes — a JSON re-serialize would break it), so
// the billing router owns express.raw for that one path and we skip the global
// JSON parser for it here.
app.use((req, res, next) => {
  // better-auth reads its own request body — a pre-consumed stream breaks it.
  if (req.path.startsWith('/api/auth/')) return next();
  if (req.path.startsWith('/api/sync')) return next();
  // /api/code/index carries a full collector run (findings + map + actions) —
  // bigger than 100kb on a large repo. Its reads/PATCHes stay tight.
  if (req.path === '/api/code/index') return next();
  if (req.path === '/api/billing/webhook') return next();
  return smallJson(req, res, next);
});
// Per-IP ceiling BEFORE the 32mb parser + the route's token lookup — the
// general apiLimiter skips /api/sync, so this is the only per-IP bound on the
// pre-auth work an anonymous flood can trigger here (SEC-02 + SEC-03).
app.use('/api/sync', syncLimiter);
app.use('/api/sync', express.json({ limit: '32mb' }));
app.use('/api/code/index', express.json({ limit: '16mb' }));

// Structured access logging + Prometheus RED metrics (duration/count/in-flight),
// one line per response, labelled by route template. Skips /health + /metrics.
app.use(httpObservability);

// Cost telemetry: establish a per-request cost context (wall + DB time/queries)
// for every /api request and record a sample on finish. This is the DATA the
// rate-limit policy is derived from (see middleware/request-cost.ts). Mounted
// before the limiters so it measures the true cost of served requests; the
// background flush/pool-sampler is started once here.
app.use('/api', costMiddleware);
startCostTelemetry();

// Rate limiting: generous per-IP ceiling on the API surface (skips /api/sync
// batches + the /api/capabilities probe — see middleware/rate-limit.ts).
// Credential-minting endpoints get a tighter limiter applied at their routes.
app.use('/api', apiLimiter);

// Prometheus metrics — top-level, before tenantAuth, so a cluster scraper hits
// it without a tenant context (optionally gated by METRICS_TOKEN). Mounted
// before the /api rate-limiter too.
app.use('/metrics', metricsRouter);

// Public install surface (/install.sh + /install/chat-recall.tgz) — the
// funnel's first touch happens before any credential exists, so it mounts
// top-level like /metrics: outside /api auth, limiters, and entitlements.
app.use('/', installRouter);

// CSP violation sink, named by report-uri above. Unauthenticated by necessity
// (the browser sends it with no credentials) and it stores nothing: it only
// logs, so it cannot be used to write to the database. Browsers post
// application/csp-report, which the global express.json() does not accept.
app.post(
  '/api/csp-report',
  express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }),
  (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const report = (body['csp-report'] ?? body) as Record<string, unknown>;
    // Coerce and truncate. The route is unauthenticated by necessity, the
    // fields are attacker-chosen, and pino will serialise whatever arrives —
    // including a nested object. 512 chars is far more than a real URI needs
    // and stops this being a cheap way to write bulk text into the log stream.
    const field = (v: unknown): string => String(v ?? '').slice(0, 512);
    log.warn({
      blockedUri: field(report['blocked-uri'] ?? report.blockedURL),
      violatedDirective: field(report['violated-directive'] ?? report.effectiveDirective),
      documentUri: field(report['document-uri'] ?? report.documentURL),
    }, 'csp violation');
    res.status(204).end();
  },
);

// SSO is a LICENSED feature, and this is the only place it can be enforced.
//
// It was in the plan map and on the pricing page while nothing checked it: an
// unlicensed self-hoster could point AUTH_PROVIDER at their own Keycloak realm
// and get the feature for free. Every other paid feature has a route to guard;
// this one is a boot-time configuration choice, so the gate has to be here.
//
// Self-host only. billingEnabled() means a Stripe key is configured, i.e. the
// hosted service, where the operator's own choice of identity provider is not a
// customer entitlement. The free tier keeps better-auth and 'none' — nobody is
// locked out of their own server, they just cannot bring an external IdP.
if (!ssoAllowed(authProviderName(), { hosted: billingEnabled(), licensed: licenceFeatures().has('sso') })) {
  log.error(
    'AUTH_PROVIDER=keycloak requires an SSO licence. Set CHAT_RECALL_LICENSE or '
    + 'CHAT_RECALL_LICENSE_SERIAL, or use AUTH_PROVIDER=better-auth (included, no licence).',
  );
  process.exit(1);
}

// Embedded auth (AUTH_PROVIDER=better-auth): better-auth owns everything
// under /api/auth/* — sign-in/up/out, get-session, and the RFC 8628 device
// flow the CLI uses. Registered BEFORE tenantAuth (it IS the login) and
// excluded from the JSON parsers above (the handler reads its own body).
// Boot-time migrations create/upgrade the auth tables in the same Postgres —
// same fail-fast contract as ensurePgSchema() below.
if (authProviderName() === 'better-auth') {
  const { toNodeHandler } = await import('better-auth/node');
  const { getAuth, runAuthMigrations } = await import('./auth/better-auth.js');
  await runAuthMigrations();
  app.all('/api/auth/*', toNodeHandler(getAuth()));
  log.info('better-auth mounted at /api/auth (embedded provider)');
}

// Open metadata: lets the client decide which views to render before auth.
// `authProvider` tells the CLI which login flow to run: 'better-auth' → the
// server's own device flow; 'keycloak' → the realm device flow at
// `oidcIssuer`; 'none' → tokenless/token login (no baked-in issuer anywhere).
// `socialProviders` lists only the providers whose id AND secret are both set,
// so the sign-in page renders a Google/GitHub button only when pressing it can
// actually work. Advertising a button for an unconfigured provider sends the
// user to an IdP error page they cannot act on.
// Self-host licence activation. PUBLIC and pre-auth by necessity: the caller is a
// self-hosted server with no account here, and the serial is the credential. Mounted
// beside /api/capabilities, before tenantAuth.
// Enterprise/reseller enquiries. PUBLIC and pre-auth for the same reason as
// /api/licence: the sender has no account here yet. Rate limited as 'sensitive'
// because it is anonymous and it sends mail.
app.use('/api/contact', rl('sensitive'), contactRouter);
app.use('/api/licence', licenceRouter);
app.get('/api/capabilities', (_req, res) => res.json({ ...capabilities(), cli: cliRelease(), authProvider: authProviderName(), oidcIssuer: process.env.OIDC_ISSUER || null, socialProviders: socialProviderNames(), limits: advertisedLimits() }));

// Self-authenticating surfaces, mounted BEFORE tenantAuth:
//   /api/sync       — agent (device) token; resolves + scopes its own tenant.
//   /api (teams)    — /me, /teams*, /tenants* verify the Keycloak user or the
//                     admin key directly; they map identity → tenant, so they
//                     run before any tenant exists for the request.
app.use('/api/sync', syncRouter);
app.use('/api/team', teamArtifactsRouter);  // toolkit library (team-client.ts contract)
app.use('/api', teamsRouter);
// Billing is self-authenticating: /checkout verifies the Keycloak user
// (requireUser) and the webhook verifies a Stripe signature — both map to a
// tenant themselves, so this mounts BEFORE tenantAuth like teams.
app.use('/api/billing', billingRouter);

// Admin surface (P1-10): cross-tenant operator metrics. Self-authenticating via
// the Keycloak `chat-recall-admin` realm role (or the ADMIN_KEY header on
// self-host), so it mounts BEFORE tenantAuth — it must not run inside one
// tenant's RLS context.
app.use('/api/admin', adminRouter);

// Tenant auth: resolves req.tenant and makes it ambient for the request (see
// middleware/auth.ts). Scoped to /api so /health + the static client stay open.
// Provider is 'none' by default (self-host single-tenant, tenant='default').
app.use('/api', tenantAuth);

// Now that tenantAuth resolved req.tenant/req.userId, attach them to the
// request's log context so every subsequent line is tenant-attributed.
app.use('/api', attachTenantToContext);

// Tenant-scoped security configuration read by the sync collector.
// Mounted after tenantAuth so req.tenant is already resolved.
app.use('/api/teams/security-config', securityConfigRouter);
app.use('/api/sync-config', syncConfigRouter);
app.use('/api/client-events', clientEventsRouter);
// Per-device idempotency ledgers (team installs, vault uploads). Mounted after
// tenantAuth so req.tenant and the device identity are both resolved.
app.use('/api/ledgers', ledgersRouter);

// Vault key parameters (salt + keyId fingerprint). Ungated like /api/account:
// a device must be able to fetch these to set the vault up at all, and they are
// not the paid surface — no key material or blob content lives here.
app.use('/api/vault', vaultRouter);

// Account configuration (secret-alert webhook). Ungated so a lapsed/un-subscribed
// user can still reach their account to (re)subscribe and configure alerts.
app.use('/api/account', accountRouter);

// Entitlement gate (util/billing.ts): 402 when the tenant isn't active|trialing.
// NO-OP until billing is enabled (STRIPE_SECRET_KEY set) and on self-host, so it
// is safe to ship before Stripe go-live. Applied to the VALUE surfaces only —
// /api/status, /api/account, /api/billing, /api/teams stay reachable so a user
// can see state, subscribe, and configure without already being paid.
const paid = requireEntitlement;
// Collaboration gate. Distinct from `paid` because isEntitled() answers "may this
// tenant use the paid surface at all", not "which tier did they buy".
//
// This was requireTeamFeature, which opened with `if (billingEnabled()) return
// next()` on the reasoning that the subscription governs — but the only thing
// mounted beside it is `paid`, which any TRIALING or SOLO tenant passes. So these
// three mounts were guarded by "has a subscription" and never looked at the plan.
// requireFeature asks the one resolver instead (plan on cloud, licence on
// self-host), so the two editions cannot drift apart again.
const team = requireFeature('team');
// The rest of the paid packaging. Each is the feature name from
// util/entitlements.ts, resolved per tenant from the plan on cloud and the licence
// on self-host — so what a tier includes is edited in ONE map, not at these mounts.
//
// Always-free surfaces carry no gate at all and must not gain one: memory (search,
// conversations, memory, projects, edits) and the secret-scan VERDICT. Monitoring
// the scan — rules, dismissals, alerting, history — is 'alerts', which is why
// /api/secrets is gated while the finding counts a user sees are not.
const findings = requireFeature('findings');
const alerts = requireFeature('alerts');
const toolkit = requireFeature('toolkit');
const insights = requireFeature('insights');
// The task board for your OWN work. Separate from 'team' because it needs no
// second person: it was mounted behind the collaboration gate, so a paying Solo
// customer was refused a board they had every reason to expect. Assignment to
// someone else is still 'team', enforced inside the router.
const tasks = requireFeature('tasks');

// Routes. Per-tenant class limiters (token bucket + concurrency) sit after the
// per-IP apiLimiter and tenantAuth: 'read-heavy' for FTS/vector/analytics and
// per-session compute; 'read-light' for cheap reads; 'write-light' for the
// recall write surfaces. Report-only until RATE_LIMIT_ENFORCE=1.
app.use('/api/search', paid, rl('read-heavy'), searchRouter);
app.use('/api/conversations', paid, rl('read-heavy'), conversationsRouter);
app.use('/api/status', rl('read-light'), statusRouter);
// Fleet health — the one place that answers "is it working on my machines?".
// Mounted after tenantAuth like the other tenant-scoped reads.
app.use('/api/health', rl('read-light'), fleetHealthRouter);
app.use('/api/memory', paid, rl('read-heavy'), memoryRouter);
app.use('/api/analytics', paid, insights, rl('read-heavy'), analyticsRouter);
// Team activity view (per-member × per-project). RLS-scoped to the requesting
// member's visibility, so it only ever shows own + team-shared work.
app.use('/api/activity', paid, team, rl('read-heavy'), activityRouter);
// Collaborative team tasks (server-authoritative board). Team-visible within
// the tenant; write-light covers the POST/PATCH.
app.use('/api/tasks', paid, tasks, rl('write-light'), tasksRouter);
// Per-project sharing, data-plane (device-token capable, for the CLI).
app.use('/api/shares', paid, team, rl('write-light'), sharesRouter);
// NOT alerts-gated at the mount. The scan VERDICT is free — counts, the finding
// list, which sessions carry them — because that is the one surface that pays out
// before any memory has accumulated, and it runs locally at no cost to us. The
// MONITORING half is gated inside the router: rules, dismissals, re-scans, trend
// history and task export. Gating the whole mount would have meant the free tier
// could not see its own findings in the dashboard at all, which is stricter than
// what was agreed.
app.use('/api/secrets', paid, rl('read-light'), secretsRouter);

// Store-backed in both modes: the edits timeline reads synced compute_cache
// diff rows, the projects tree reads memory_metadata project_ids.
app.use('/api/edits', paid, rl('read-heavy'), editsRouter);
// The user's own export and delete controls. `paid` still applies, and its
// lapsed-tenant rule is exactly right here: export is a GET so it keeps working
// after a subscription ends — taking your history with you must never require
// paying again — while the deletes are POSTs and stop, like every other write.
app.use('/api/data', paid, rl('write-light'), dataControlsRouter);
app.use('/api/projects', paid, rl('read-light'), projectsRouter);

// Recall surfaces for the thin-collector MCP: knowledge graph + key-value.
// Tenant-scoped via the same tenantAuth above; readable/writable over HTTP so
// the MCP server needs no local store.
app.use('/api/kg', paid, rl('write-light'), kgRouter);
app.use('/api/kv', paid, rl('write-light'), kvRouter);
app.use('/api/diary', paid, rl('write-light'), diaryRouter);
// Cross-tool sync intent queue (Model B). MUST be available in BOTH local and
// server mode: the SaaS UI enqueues intents here and the user's local CLI agent
// (which has the actual filesystem) drains + executes them. Unlike /api/toolkit
// (local-only, writes files), this only touches the DB queue.
app.use('/api/sync-intents', paid, rl('write-light'), syncIntentsRouter);
app.use('/api/files', paid, rl('read-light'), filesRouter);
app.use('/api/subagents', paid, rl('read-light'), subagentsRouter);

// Code intelligence (codeindex merge). Store-backed in BOTH modes: the local
// CLI `code index` POSTs collector output to /index; the dashboard reads it
// back. read-light for the GETs; the POST/PATCH are light DB writes. The
// collector runs on the user's machine, never here.
app.use('/api/code', paid, findings, rl('read-light'), codeRouter);
// Account-level recommendations (security + behaviour) — the actionable
// approach applied to chat-recall's own data.
// The recommendation engine reasons over the code findings, so it belongs with
// them rather than behind a gate of its own.
app.use('/api/recommendations', paid, findings, rl('read-light'), recommendationsRouter);

// Toolkit READS (status/browse/item/matrix) come from the synced store, so the
// router is available in BOTH modes — the Toolkit tab must render on the hosted
// SaaS and on a self-host Docker server (neither can see the user's local fs).
// The fs-mutating routes inside (promote/sync-all/delete) self-guard with
// requireLocalMode; cross-tool copy on a remote server goes via the local CLI
// agent draining /api/sync-intents.
app.use('/api/toolkit', paid, toolkit, rl('read-light'), toolkitRouter);
// Audit log export. The router gates itself on 'audit' for every route, since the
// whole surface IS the licensed feature — 'audit' was on the pricing page with
// nothing behind it until this existed.
app.use('/api/audit', paid, rl('read-light'), auditRouter);

// Settings editing genuinely mutates the local fs, so it stays local-only.
// (Projects config PUT is guarded inside the projects router.)
if (!isServerMode()) {
  app.use('/api/settings', settingsRouter);
}

// Health check. During graceful shutdown it returns 503 so the readiness probe
// pulls this pod out of the Service endpoints before we stop accepting — the
// other half of zero-downtime rolling (the rest is the preStop drain + SIGTERM
// handler below).
// build identifies the running image ("did the deploy actually roll?"). The
// Dockerfile stamps git sha or build time into BUILD_STAMP_FILE; 'dev' outside
// an image. Read once — it can't change while the process lives.
const BUILD_STAMP = process.env.BUILD_STAMP || (() => {
  try { return readFileSync(process.env.BUILD_STAMP_FILE || '/app/.build-stamp', 'utf-8').trim() || 'dev'; }
  catch { return 'dev'; }
})();

app.get('/health', (req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  // The build stamp is OPERATOR data — /health is public, and advertising
  // image versions/deploy cadence to the internet is a free recon gift. Only
  // reveal it to requests that prove they're the operator (x-admin-key).
  const isOperator = !!process.env.ADMIN_KEY && req.get('x-admin-key') === process.env.ADMIN_KEY;
  res.json({ status: 'ok', timestamp: new Date().toISOString(), ...(isOperator ? { build: BUILD_STAMP } : {}) });
});

// Serve the built React client from the same origin in production / Docker.
// Tries STATIC_DIR first (set in the Dockerfile), then falls back to the
// repo-relative path used during development.
if (existsSync(STATIC_DIR)) {
  const SPA_SHELL = resolve(STATIC_DIR, 'index.html');
  const LANDING = resolve(STATIC_DIR, 'landing.html');
  const hasLanding = existsSync(LANDING);

  /**
   * Does this request carry a live-looking session cookie?
   *
   * Presence only — this decides which HTML to hand back, never what anyone is
   * allowed to read. A forged cookie gets the app shell, whose every API call
   * then fails auth exactly as it should. Matching both the plain and
   * __Secure- prefixed names because better-auth adds the prefix only when the
   * deployment is https, so local dev and production differ.
   */
  const looksSignedIn = (req: express.Request): boolean =>
    /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(req.headers.cookie || '');

  /**
   * '/' is the one path that serves two different documents.
   *
   * Registered BEFORE express.static, because static's own index resolution
   * would otherwise answer '/' with index.html (the SPA shell) and this would
   * never run.
   *
   *   no session  → landing.html, the static marketing page. This is what every
   *                 crawler gets, and it is the entire reason the page is not a
   *                 React component any more: a client-rendered SPA serves
   *                 `<div id="root"></div>` to anything that does not execute
   *                 JavaScript, which includes most AI crawlers.
   *   session     → the app shell, so returning users are not bounced through a
   *                 marketing page to reach their own data.
   *   any query   → the app shell. ?view=connect is the installer's token page
   *                 and ?view=account is where Stripe returns; both are app
   *                 routes that happen to live on '/'.
   *
   * Cache-Control is no-store rather than something edge-cacheable, and that is
   * a deliberate cost. The response varies on a cookie, and Cloudflare ignores
   * Vary: Cookie below Enterprise, so an edge-cached '/' would eventually serve
   * one user's document to the other kind of visitor. The page is a single
   * ~15KB file with inline CSS and no JavaScript, so serving it from origin is
   * cheap; serving the wrong one is not.
   */
  // Query params that mean "this is an app route", NOT merely "there is a query
  // string". `Object.keys(req.query).length > 0` was too broad: a marketing link
  // carrying ?utm_source= / ?ref= / ?gclid= handed the SPA shell to a logged-out
  // visitor, and since the shell's signed-out branch is now the sign-in form
  // (main.tsx), every campaign link to the bare domain opened a login box
  // instead of the landing page.
  const APP_QUERY_KEYS = new Set(['view', 'device', 'session', 'project', 'tool', 'user_code']);

  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Cookie');
    const wantsApp = looksSignedIn(req)
      || Object.keys(req.query).some((k) => APP_QUERY_KEYS.has(k));
    res.sendFile(wantsApp || !hasLanding ? SPA_SHELL : LANDING);
  });

  // index.html must NEVER be cached: a browser running a stale app shell
  // renders current data with outdated code — the worst kind of lie
  // (hashed JS/CSS assets stay cacheable; their names change per build).
  //
  // The marketing pages are the opposite case: they are static documents with
  // no session in them, so they get a short public TTL. Fonts are immutable
  // (their content is their name's whole reason to exist) and get a year.
  app.use(express.static(STATIC_DIR, {
    setHeaders: (res, path) => {
      if (path.endsWith('index.html') || path.endsWith('landing.html')) {
        res.setHeader('Cache-Control', 'no-store');
      } else if (path.includes('/fonts/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

  // SPA fallback — any non-API path returns index.html so client-side routes
  // work. The static marketing pages are matched above by express.static, so
  // they never reach this.
  app.get(/^\/(?!api|health).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(SPA_SHELL);
  });
  log.info({ staticDir: STATIC_DIR, landing: hasLanding }, 'serving client');
}

// Capture request errors to GlitchTip before our own handler formats the 500.
// Registered after all routes, before the JSON error handler (no-ops if Sentry
// wasn't initialized — i.e. GLITCHTIP_DSN unset).
Sentry.setupExpressErrorHandler(app);

// Error handler. pino serializes the `err` key (message + stack); the reqId and
// tenant ride along from the request log context.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, 'unhandled error');
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// Validate the storage backend BEFORE serving: resolveBackend() is fail-closed
// (unset/unknown CHAT_RECALL_STORAGE throws), and we want that throw here at
// boot — one clear crash with a clear message — not on the first request that
// happens to touch the store. A server deployment must be postgres.
{
  const { resolveBackend } = await import('@chat-recall/engine/core/store/index.js');
  const backend = resolveBackend();
  if (isServerMode() && backend !== 'postgres') {
    throw new Error(
      `CHAT_RECALL_STORAGE=${backend} is not valid in server mode — a server deployment must use postgres. ` +
        'The sqlite backend exists for unit tests only.',
    );
  }
  log.info({ backend }, 'storage backend resolved');
}

// Schema bootstrap is now an EXPLICIT, primary-only step (decoupled from
// opening a pool — see pg-pool.ts). Run it once here, before we serve, so a
// misconfigured/unreachable primary fails fast at boot instead of erroring on
// the first request.
if (isServerMode()) {
  const { ensurePgSchema } = await import('@chat-recall/engine/core/store/pg-pool.js');
  await ensurePgSchema();
  log.info('schema ensured on primary');
}

// Start server - bind to localhost by default, 0.0.0.0 for Docker/network access
const HOST = process.env.HOST || '127.0.0.1';
const httpServer = app.listen(PORT, HOST, () => {
  const caps = capabilities();
  log.info({ host: HOST, port: PORT, mode: caps.mode, edition: caps.edition }, 'server listening');

  // Tier role (see D-split): 'api' serves HTTP only and runs NO background sweeps
  // (so the API tier autoscales on real web traffic, never on worker CPU bursts);
  // 'worker' runs the summary + vector sweeps; 'all' (default = self-host) does
  // both. The HTTP server always starts (health/metrics probes) regardless.
  const role = process.env.CHAT_RECALL_ROLE || 'all';
  const runWorkers = role !== 'api';
  log.info({ role, backgroundWorkers: runWorkers }, 'tier role');

  // Backlog refresher: keep /metrics/backlog instant (background-computed) so the
  // KEDA scalers (OVMS summaries + Ollama embeddings) never time out reading it.
  // Runs on every tier that serves HTTP (the API service is what KEDA scrapes).
  if (isServerMode()) startBacklogRefresher();

  // Loud boot-time error when the cloud edition runs /metrics without a token
  // (business/security gauges guarded only by the private-peer-IP stopgap).
  logMetricsExposureAtBoot();

  // Server-side AI summary generation. Synced sessions arrive without an AI
  // summary (the thin collector only ships raw content + structured outcome);
  // this periodic sweep fills them in using the operator-configured provider.
  // Gated twice: server mode only (local mode generates summaries during its
  // own indexing), and only when a provider is actually configured — otherwise
  // it's a no-op and we say so once instead of spinning a useless timer.
  if (isServerMode() && runWorkers) {
    if (serverSummaryConfig()) {
      const SUMMARY_SWEEP_MS = 30 * 1000;      // sweep often; sweepInFlight prevents overlap
      // FIXED, provider-sized concurrency — the lease-based work queue (see
      // summary-worker.ts) keeps `concurrency` LLM calls in flight per worker pod,
      // claiming more leases as slots free. No AIMD: it was brittle (a transient
      // failure storm beat it to the floor, and it only ramped on *completed*
      // sweeps). One explicit number scales cleanly — raise it, or add worker
      // replicas, or let KEDA add model-tier pods; all independent. Per-tenant
      // quota (SUMMARY_CAP_PER_HOUR) stays the only deliberate rate limit.
      const concurrency = Math.max(1, Number(process.env.SUMMARY_CONCURRENCY) || 8);
      // Per-sweep ceiling on sessions TOUCHED — high so the FREE trivial sessions
      // (first_prompt, no LLM) drain fast; real LLM ones stay quota-capped downstream.
      const SUMMARY_BATCH = Math.max(200, Number(process.env.SUMMARY_BATCH) || 2000);
      let sweepInFlight = false;
      const sweep = async (): Promise<void> => {
        if (sweepInFlight) return;
        sweepInFlight = true;
        try {
          const r = await generateMissingSummariesAllTenants({ limit: SUMMARY_BATCH, concurrency });
          summarySweepsTotal.inc({ result: 'ok' });
          summariesGeneratedTotal.inc(r.generated);
          summariesFailedTotal.inc(r.failed);
          summariesSkippedTotal.inc(r.skipped);
          summaryConcurrency.set(concurrency);
          if (r.generated > 0 || r.failed > 0) {
            log.info({ generated: r.generated, failed: r.failed, skipped: r.skipped, tenants: r.tenants, concurrency }, 'summary sweep');
          }
        } catch (err) {
          summarySweepsTotal.inc({ result: 'error' });
          log.error({ err }, 'summary sweep failed');
        } finally {
          sweepInFlight = false;
        }
      };
      // unref so the timer never keeps the process alive on its own.
      setInterval(() => { void sweep(); }, SUMMARY_SWEEP_MS).unref();
      // Kick one sweep shortly after boot so the first batch doesn't wait a
      // full interval.
      setTimeout(() => { void sweep(); }, 5000).unref();
      log.info('summary worker enabled (server mode)');
    } else {
      log.info('summary worker disabled (no SUMMARY_PROVIDER configured)');
    }
  }

  // Synthetic-tenant retention: purge healthcheck/probe sessions (tenant
  // allowlist SYNTHETIC_TENANTS, default 'synccheck') older than
  // SYNTHETIC_RETENTION_DAYS. Without this the sync probe grew the DB without
  // bound (15k sessions / 2.5 GB in 12 days). Hourly, bounded per tick.
  if (isServerMode() && runWorkers) {
    const RETENTION_SWEEP_MS = 60 * 60 * 1000;
    let retentionInFlight = false;
    const retentionSweep = async (): Promise<void> => {
      if (retentionInFlight) return;
      retentionInFlight = true;
      try {
        await sweepSyntheticRetention();
        // Off unless LAPSED_RETENTION_DAYS is set, and report-only unless
        // LAPSED_RETENTION_APPLY=1 as well. Two switches because this one
        // deletes paying-customers-who-stopped-paying data, and a deploy must
        // never be the thing that starts that.
        if (lapsedRetentionDays() > 0) await sweepLapsedRetention();
      } catch (err) {
        log.error({ err }, 'synthetic retention sweep failed');
      } finally {
        retentionInFlight = false;
      }
    };
    setInterval(() => { void retentionSweep(); }, RETENTION_SWEEP_MS).unref();
    setTimeout(() => { void retentionSweep(); }, 30_000).unref();
    log.info('synthetic-tenant retention sweep enabled');
  }

  // Trial reminders: warn a trialing tenant at 7 / 2 / 0 days left, once each.
  // Hourly is ample for day-wide windows, and the per-stage "already sent" flag
  // lives in tenant settings so restarts and extra replicas cannot re-send.
  // Gated on billing being configured: self-host has no trials to remind about.
  if (isServerMode() && runWorkers && billingEnabled()) {
    const TRIAL_SWEEP_MS = 60 * 60 * 1000;
    let trialInFlight = false;
    const trialSweep = async (): Promise<void> => {
      if (trialInFlight) return;
      trialInFlight = true;
      try {
        await sweepTrialReminders();
      } catch (err) {
        log.error({ err }, 'trial reminder sweep failed');
      } finally {
        trialInFlight = false;
      }
    };
    setInterval(() => { void trialSweep(); }, TRIAL_SWEEP_MS).unref();
    setTimeout(() => { void trialSweep(); }, 45_000).unref();
    log.info('trial reminder sweep enabled');
  }

  // Licence activation refresh, for a SELF-HOSTED deployment holding a serial. Runs
  // hourly and refreshes only when the current token is past the halfway point of its
  // life, so a single failed call costs nothing and we do not hammer the service.
  //
  // Deliberately NOT gated on billingEnabled(): this is the path a self-hoster uses,
  // and they have no Stripe key. It no-ops when no serial is configured.
  if (isServerMode() && runWorkers) {
    const ACT_SWEEP_MS = 60 * 60 * 1000;
    let actInFlight = false;
    const actSweep = async (): Promise<void> => {
      if (actInFlight) return;
      actInFlight = true;
      try {
        const { refreshDue, refreshEntitlement, serial } = await import('./util/licence-activation.js');
        if (!serial() || !refreshDue()) return;
        const r = await refreshEntitlement();
        if (r.ok) log.info('licence entitlement refreshed');
        else log.warn({ reason: r.reason }, 'licence refresh did not succeed; cached token still in force');
      } catch (err) {
        log.error({ err }, 'licence refresh sweep failed');
      } finally {
        actInFlight = false;
      }
    };
    setInterval(() => { void actSweep(); }, ACT_SWEEP_MS).unref();
    // Early first run: a fresh install with a serial should activate at once.
    setTimeout(() => { void actSweep(); }, 10_000).unref();
    log.info('licence activation refresh enabled');
  }

  // Vector backfill: embed chunks that are in FTS but missing from
  // memory_vectors (embedder switched on, model changed, missed batches).
  // New ingests embed on the fly; this sweep catches up the backlog across all
  // tenants so semantic search becomes complete on its own. Gated like the
  // summary worker: server mode + an embedder actually configured.
  // Master kill-switch: semantic search is OFF by default (SEMANTIC_SEARCH_ENABLED
  // unset). When off we do NOT embed — the vector tier is dormant (keyword FTS +
  // pg_trgm typo tolerance cover search), so we don't burn embed quota for a
  // feature nobody's querying. Flip SEMANTIC_SEARCH_ENABLED=true to bring it back
  // (embedder config is retained). All vector code is kept, just gated.
  const semanticEnabled = process.env.SEMANTIC_SEARCH_ENABLED === 'true';
  if (isServerMode() && runWorkers && semanticEnabled) {
    if (serverEmbedderConfigured()) {
      const VEC_SWEEP_MS = 30 * 1000;   // keep it moving; inFlight guard prevents overlap
      const VEC_BATCH = 256;
      let vecInFlight = false;
      const vecSweep = async (): Promise<void> => {
        if (vecInFlight) return;
        vecInFlight = true;
        try {
          const r = await embedMissingVectors({ batch: VEC_BATCH });
          vectorSweepsTotal.inc({ result: 'ok' });
          vectorsEmbeddedTotal.inc(r.embedded);
          if (r.embedded > 0 || r.rewindowed > 0) {
            log.info({ embedded: r.embedded, tenants: r.tenants, rewindowed: r.rewindowed }, 'vector backfill');
          }
        } catch (err) {
          vectorSweepsTotal.inc({ result: 'error' });
          log.error({ err }, 'vector backfill failed');
        } finally {
          vecInFlight = false;
        }
      };
      setInterval(() => { void vecSweep(); }, VEC_SWEEP_MS).unref();
      setTimeout(() => { void vecSweep(); }, 8000).unref();
      log.info('vector backfill worker enabled (server mode)');
    } else {
      log.info('vector backfill worker disabled (no EMBEDDING_PROVIDER)');
    }
  } else if (isServerMode() && runWorkers && !semanticEnabled) {
    log.info('vector backfill worker disabled (SEMANTIC_SEARCH_ENABLED not set — no embedding)');
  }

  // Self-heal: rebuild any session whose rendered view is thinner than its own
  // shrink-protected raw archive (the Claude Code 2.1.20x resume-truncation
  // fingerprint). Fully automatic, no client/customer action. A full backlog
  // pass runs once shortly after boot; a windowed pass repeats hourly to catch
  // ongoing truncations. Only ever grows a conversation, from its own archive.
  if (isServerMode() && runWorkers) {
    const SELFHEAL_SWEEP_MS = 60 * 60 * 1000;      // hourly recurring pass
    const SELFHEAL_WINDOW_MS = 7 * 24 * 3600 * 1000; // recurring pass scans last 7d
    let healInFlight = false;
    const healSweep = async (sinceMs: number, label: string): Promise<void> => {
      if (healInFlight) return;
      healInFlight = true;
      try {
        const { selfHealSweepAllTenants } = await import('./services/self-heal.js');
        const r = await selfHealSweepAllTenants({ sinceMs });
        if (r.healed > 0) log.info({ ...r, pass: label }, 'self-heal sweep healed sessions');
        else log.info({ scanned: r.scanned, tenants: r.tenants, pass: label }, 'self-heal sweep: nothing to heal');
      } catch (err) {
        log.error({ err, pass: label }, 'self-heal sweep failed');
      } finally {
        healInFlight = false;
      }
    };
    // One full backlog pass (all archives) ~15s after boot, then hourly windowed.
    setTimeout(() => { void healSweep(0, 'backlog'); }, 15_000).unref();
    setInterval(() => { void healSweep(Date.now() - SELFHEAL_WINDOW_MS, 'recurring'); }, SELFHEAL_SWEEP_MS).unref();
    log.info('self-heal sweep enabled (server mode)');
  }

  // Secret re-scan: run TODAY's rules over text we ALREADY store. Detection
  // has to happen client-side (we never receive unredacted text), so the one
  // gap that leaves is a device whose redactor missed something — the secret is
  // then sitting in our DB in cleartext with nothing to notice it. This pass
  // notices, records it as a server-owned finding, and alerts. Daily window +
  // one backlog pass after boot; off by default via SECRET_RESCAN=0.
  if (isServerMode() && runWorkers && process.env.SECRET_RESCAN !== '0') {
    const RESCAN_SWEEP_MS = 24 * 60 * 60 * 1000;
    const RESCAN_WINDOW_MS = 2 * 24 * 3600 * 1000;   // recurring pass: last 2d
    const RESCAN_LIMIT = Math.max(0, parseInt(process.env.SECRET_RESCAN_LIMIT || '2000', 10));
    let rescanInFlight = false;
    const rescanSweep = async (sinceMs: number, label: string): Promise<void> => {
      if (rescanInFlight) return;
      rescanInFlight = true;
      try {
        const { rescanAllTenants } = await import('./services/secret-rescan.js');
        const r = await rescanAllTenants({ sinceMs, limit: RESCAN_LIMIT });
        if (r.sessionsWithMisses > 0) log.warn({ ...r, pass: label }, 'secret re-scan found redaction misses');
        else log.info({ scanned: r.scanned, tenants: r.tenants, pass: label }, 'secret re-scan: nothing missed');
      } catch (err) {
        log.error({ err, pass: label }, 'secret re-scan failed');
      } finally {
        rescanInFlight = false;
      }
    };
    // After self-heal's backlog pass, so re-scan sees healed (fuller) envelopes.
    setTimeout(() => { void rescanSweep(0, 'backlog'); }, 90_000).unref();
    setInterval(() => { void rescanSweep(Date.now() - RESCAN_WINDOW_MS, 'recurring'); }, RESCAN_SWEEP_MS).unref();
    log.info('secret re-scan sweep enabled (server mode)');
  }

  // Cache prewarming only makes sense in local mode — in server mode there
  // is no filesystem to walk and (with keycloak auth) the warm fetches
  // would just 401.
  if (!isServerMode()) {
    // Pre-warm the caches that the UI hits on first page load. Without
    // this, the user's first /status, /analytics, /outcome calls each pay
    // their own 1-2s cold-walk cost. Better to absorb it once at boot.
    // All warmups run async in parallel — listen() doesn't block.
    void import('./routes/conversations.js').then(m => m.prewarmConversationCaches());

    // Warm the per-route TTL caches by hitting the actual HTTP endpoints.
    // Going through the routes (rather than calling the service classes
    // directly) guarantees we warm the SAME singleton instances the route
    // handlers use — calling `new Service()` from outside creates a
    // separate instance with its own empty cache, which doesn't help.
    setTimeout(() => {
      void Promise.all([
        fetch(`http://127.0.0.1:${PORT}/api/status`).then(() => 'status'),
        fetch(`http://127.0.0.1:${PORT}/api/analytics`).then(() => 'analytics'),
        fetch(`http://127.0.0.1:${PORT}/api/memory/status`).then(() => 'memory/status'),
        fetch(`http://127.0.0.1:${PORT}/api/edits/timeline?since_hours=24&limit=200`).then(() => 'edits/timeline'),
      ]).then(results => {
        log.info({ caches: results.filter(Boolean) }, 'route caches warmed');
      }).catch(() => { /* benign — first user request will pay */ });
    }, 300);
  }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// On SIGTERM (rolling update / scale-down / node drain): stop readiness (above),
// stop accepting new connections, let in-flight requests finish, close the pg
// pools, then exit. A hard cap prevents a stuck socket from blocking the
// rollout. Paired with the k8s preStop sleep + terminationGracePeriodSeconds.
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutdown: draining connections');
  const forceMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 25000;
  const force = setTimeout(() => {
    log.warn('shutdown: forced exit after timeout');
    process.exit(0);
  }, forceMs);
  force.unref();
  httpServer.close(async () => {
    try { await closePgPools(); } catch (err) { log.warn({ err }, 'shutdown: pool close failed'); }
    log.info('shutdown: complete');
    process.exit(0);
  });
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
