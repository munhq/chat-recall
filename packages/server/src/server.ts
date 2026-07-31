/**
 * Express server for chat-recall UI backend.
 */

// MUST be first — installs @sentry/node instrumentation before other modules load.
import './instrument.js';
import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { existsSync, readFileSync } from 'node:fs';
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
import { tenantAuth, validateAuthConfig } from './middleware/auth.js';
import { apiLimiter, syncLimiter, rl } from './middleware/rate-limit.js';
import { costMiddleware, startCostTelemetry } from './middleware/request-cost.js';
import metricsRouter, { startBacklogRefresher, logMetricsExposureAtBoot } from './routes/metrics.js';
import adminRouter from './routes/admin.js';
import clientEventsRouter from './routes/client-events.js';
import vaultRouter from './routes/vault.js';
import accountRouter from './routes/account.js';
import { requireEntitlement } from './util/billing.js';
import projectsRouter from './routes/projects.js';
import kgRouter from './routes/kg.js';
import kvRouter from './routes/kv.js';
import diaryRouter from './routes/diary.js';
import syncIntentsRouter from './routes/sync-intents.js';
import filesRouter from './routes/files.js';
import subagentsRouter from './routes/subagents.js';
import codeRouter from './routes/code.js';
import recommendationsRouter from './routes/recommendations.js';
import syncRouter from './routes/sync.js';
import teamsRouter from './routes/teams.js';
import teamArtifactsRouter from './routes/team-artifacts.js';
import securityConfigRouter from './routes/security-config.js';
import syncConfigRouter from './routes/sync-config.js';
import billingRouter from './routes/billing.js';
import installRouter from './routes/install.js';
import { capabilities, isServerMode } from './util/mode.js';
import { cliRelease } from './util/cli-release.js';
import { generateMissingSummariesAllTenants, serverSummaryConfig } from './services/summary-worker.js';
import { sweepSyntheticRetention } from './services/retention.js';
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

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || undefined, // undefined = allow all (for local dev); set in prod
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

// Open metadata: lets the client decide which views to render before auth.
// `oidcIssuer` lets the CLI learn where to run the SSO device flow without any
// baked-in issuer (null on a no-auth self-host server → CLI uses token login).
app.get('/api/capabilities', (_req, res) => res.json({ ...capabilities(), cli: cliRelease(), oidcIssuer: process.env.OIDC_ISSUER || null }));

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

// Routes. Per-tenant class limiters (token bucket + concurrency) sit after the
// per-IP apiLimiter and tenantAuth: 'read-heavy' for FTS/vector/analytics and
// per-session compute; 'read-light' for cheap reads; 'write-light' for the
// recall write surfaces. Report-only until RATE_LIMIT_ENFORCE=1.
app.use('/api/search', paid, rl('read-heavy'), searchRouter);
app.use('/api/conversations', paid, rl('read-heavy'), conversationsRouter);
app.use('/api/status', rl('read-light'), statusRouter);
app.use('/api/memory', paid, rl('read-heavy'), memoryRouter);
app.use('/api/analytics', paid, rl('read-heavy'), analyticsRouter);
// Team activity view (per-member × per-project). RLS-scoped to the requesting
// member's visibility, so it only ever shows own + team-shared work.
app.use('/api/activity', paid, rl('read-heavy'), activityRouter);
// Collaborative team tasks (server-authoritative board). Team-visible within
// the tenant; write-light covers the POST/PATCH.
app.use('/api/tasks', paid, rl('write-light'), tasksRouter);
// Per-project sharing, data-plane (device-token capable, for the CLI).
app.use('/api/shares', paid, rl('write-light'), sharesRouter);
app.use('/api/secrets', paid, rl('read-light'), secretsRouter);

// Store-backed in both modes: the edits timeline reads synced compute_cache
// diff rows, the projects tree reads memory_metadata project_ids.
app.use('/api/edits', paid, rl('read-heavy'), editsRouter);
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
app.use('/api/code', paid, rl('read-light'), codeRouter);
// Account-level recommendations (security + behaviour) — the actionable
// approach applied to chat-recall's own data.
app.use('/api/recommendations', paid, rl('read-light'), recommendationsRouter);

// Toolkit READS (status/browse/item/matrix) come from the synced store, so the
// router is available in BOTH modes — the Toolkit tab must render on the hosted
// SaaS and on a self-host Docker server (neither can see the user's local fs).
// The fs-mutating routes inside (promote/sync-all/delete) self-guard with
// requireLocalMode; cross-tool copy on a remote server goes via the local CLI
// agent draining /api/sync-intents.
app.use('/api/toolkit', paid, rl('read-light'), toolkitRouter);

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
const STATIC_DIR = resolve(
  process.env.STATIC_DIR || '../client/dist',
);
if (existsSync(STATIC_DIR)) {
  // index.html must NEVER be cached: a browser running a stale app shell
  // renders current data with outdated code — the worst kind of lie
  // (hashed JS/CSS assets stay cacheable; their names change per build).
  app.use(express.static(STATIC_DIR, {
    setHeaders: (res, path) => {
      if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
    },
  }));
  // SPA fallback — any non-API path returns index.html so client-side routes work.
  app.get(/^\/(?!api|health).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(resolve(STATIC_DIR, 'index.html'));
  });
  log.info({ staticDir: STATIC_DIR }, 'serving client');
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
