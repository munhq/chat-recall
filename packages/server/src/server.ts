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
import projectsRouter from './routes/projects.js';

const app = express();
const PORT = parseInt(process.env.PORT || '5000', 10);

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
app.use(express.json({ limit: '100kb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Tenant auth: resolves req.tenant and makes it ambient for the request (see
// middleware/auth.ts). Scoped to /api so /health + the static client stay open.
// Provider is 'none' by default (self-host single-tenant, tenant='default').
app.use('/api', tenantAuth);

// Routes
app.use('/api/search', searchRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/status', statusRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/edits', editsRouter);
app.use('/api/toolkit', toolkitRouter);
app.use('/api/secrets', secretsRouter);
app.use('/api/projects', projectsRouter);

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
  app.use(express.static(STATIC_DIR));
  // SPA fallback — any non-API path returns index.html so client-side routes work.
  app.get(/^\/(?!api|health).*/, (_req, res) => {
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

// Start server - bind to localhost by default, 0.0.0.0 for Docker/network access
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`\nChat-Recall Backend running on http://${HOST}:${PORT}`);
  console.log(`  Health: http://${HOST}:${PORT}/health`);
  console.log(`  Bind: ${HOST} (set HOST=0.0.0.0 for network access)\n`);

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
});
