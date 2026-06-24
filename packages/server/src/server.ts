/**
 * Express server for chat-recall UI backend.
 */

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import searchRouter from './routes/search.js';
import conversationsRouter from './routes/conversations.js';
import statusRouter from './routes/status.js';
import memoryRouter from './routes/memory.js';
import analyticsRouter from './routes/analytics.js';
import settingsRouter from './routes/settings.js';
import editsRouter from './routes/edits.js';
import toolkitRouter from './routes/toolkit.js';
import secretsRouter from './routes/secrets.js';
import { tenantAuth } from './middleware/auth.js';
import { apiLimiter, rl } from './middleware/rate-limit.js';
import { costMiddleware, startCostTelemetry } from './middleware/request-cost.js';
import metricsRouter from './routes/metrics.js';
import adminRouter from './routes/admin.js';
import accountRouter from './routes/account.js';
import { requireEntitlement } from './util/billing.js';
import projectsRouter from './routes/projects.js';
import kgRouter from './routes/kg.js';
import kvRouter from './routes/kv.js';
import diaryRouter from './routes/diary.js';
import syncIntentsRouter from './routes/sync-intents.js';
import filesRouter from './routes/files.js';
import subagentsRouter from './routes/subagents.js';
import syncRouter from './routes/sync.js';
import teamsRouter from './routes/teams.js';
import teamArtifactsRouter from './routes/team-artifacts.js';
import securityConfigRouter from './routes/security-config.js';
import billingRouter from './routes/billing.js';
import { capabilities, isServerMode } from './util/mode.js';
import { generateMissingSummaries, serverSummaryConfig } from './services/summary-worker.js';

const app = express();
const PORT = parseInt(process.env.PORT || '5000', 10);

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
// /api/sync carries whole (redacted) conversation batches — it gets its own
// 32mb parser below; everything else keeps the tight 100kb bound.
const smallJson = express.json({ limit: '100kb' });
// /api/sync gets a big parser; /api/billing/webhook must stay RAW (Stripe's
// signature is over the exact bytes — a JSON re-serialize would break it), so
// the billing router owns express.raw for that one path and we skip the global
// JSON parser for it here.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/sync')) return next();
  if (req.path === '/api/billing/webhook') return next();
  return smallJson(req, res, next);
});
app.use('/api/sync', express.json({ limit: '32mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

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

// Open metadata: lets the client decide which views to render before auth.
app.get('/api/capabilities', (_req, res) => res.json(capabilities()));

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

// Tenant-scoped security configuration read by the sync collector.
// Mounted after tenantAuth so req.tenant is already resolved.
app.use('/api/teams/security-config', securityConfigRouter);

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

// FS-backed routers exist only in local mode: in a server deployment data
// arrives via /api/sync and there is no settings file the UI should edit
// and no toolkit files to write. (Projects config PUT is guarded inside
// the projects router.)
if (!isServerMode()) {
  app.use('/api/settings', settingsRouter);
  app.use('/api/toolkit', toolkitRouter);
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
  console.log(`Serving client from ${STATIC_DIR}`);
}

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// Schema bootstrap is now an EXPLICIT, primary-only step (decoupled from
// opening a pool — see pg-pool.ts). Run it once here, before we serve, so a
// misconfigured/unreachable primary fails fast at boot instead of erroring on
// the first request. No-op when DATABASE_URL is unset (local sqlite mode).
if (isServerMode()) {
  const { ensurePgSchema } = await import('@chat-recall/engine/core/store/pg-pool.js');
  await ensurePgSchema();
  console.log('  Schema: ensured on primary');
}

// Start server - bind to localhost by default, 0.0.0.0 for Docker/network access
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`\nChat-Recall Backend running on http://${HOST}:${PORT}`);
  console.log(`  Health: http://${HOST}:${PORT}/health`);
  console.log(`  Bind: ${HOST} (set HOST=0.0.0.0 for network access)\n`);

  const caps = capabilities();
  console.log(`  Mode: ${caps.mode} · edition: ${caps.edition}`);

  // Server-side AI summary generation. Synced sessions arrive without an AI
  // summary (the thin collector only ships raw content + structured outcome);
  // this periodic sweep fills them in using the operator-configured provider.
  // Gated twice: server mode only (local mode generates summaries during its
  // own indexing), and only when a provider is actually configured — otherwise
  // it's a no-op and we say so once instead of spinning a useless timer.
  if (isServerMode()) {
    if (serverSummaryConfig()) {
      const SUMMARY_SWEEP_MS = 3 * 60 * 1000; // every 3 minutes
      const SUMMARY_BATCH = 10;                // small batch per tick
      let sweepInFlight = false;               // guard against overlap on slow LLMs
      const sweep = async (): Promise<void> => {
        if (sweepInFlight) return;
        sweepInFlight = true;
        try {
          const r = await generateMissingSummaries({ limit: SUMMARY_BATCH });
          if (r.generated > 0 || r.failed > 0) {
            console.log(`  Summary sweep: ${r.generated} generated, ${r.failed} failed, ${r.skipped} skipped`);
          }
        } catch (err) {
          console.error('Summary sweep failed:', err);
        } finally {
          sweepInFlight = false;
        }
      };
      // unref so the timer never keeps the process alive on its own.
      setInterval(() => { void sweep(); }, SUMMARY_SWEEP_MS).unref();
      // Kick one sweep shortly after boot so the first batch doesn't wait a
      // full interval.
      setTimeout(() => { void sweep(); }, 5000).unref();
      console.log('  Summary worker: enabled (server mode)');
    } else {
      console.log('  Summary worker: disabled (no SUMMARY_PROVIDER configured)');
    }
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
        console.log(`  Route caches warmed: ${results.filter(Boolean).join(', ')}`);
      }).catch(() => { /* benign — first user request will pay */ });
    }, 300);
  }
});
