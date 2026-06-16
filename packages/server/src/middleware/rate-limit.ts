/**
 * Rate limiting for the public API surface.
 *
 * The server is internet-facing in SaaS and self-host-behind-ingress
 * deployments, so unauthenticated abuse — device-token brute-force, tenant
 * enumeration, search floods — needs a backstop. Two tiers:
 *
 *  - `apiLimiter`: a generous per-IP ceiling on `/api/*` to blunt floods.
 *    Skips `/api/sync` (large, device-token-authenticated batches) and
 *    `/api/capabilities` (the unauthenticated bootstrap probe the UI polls).
 *  - `sensitiveLimiter`: a tight per-IP ceiling for credential-minting and
 *    tenant-admin endpoints, where a brute-force actually matters.
 *
 * Behind an ingress/Traefik the real client IP lives in `X-Forwarded-For`, so
 * the server enables `trust proxy` (see server.ts) — without it every request
 * would share the proxy's single IP and trip the limit as one client.
 *
 * Both ceilings are env-overridable for operators with unusual fan-in.
 */
import rateLimit from 'express-rate-limit';

const minutes = (n: number) => n * 60 * 1000;

export const apiLimiter = rateLimit({
  windowMs: minutes(5),
  max: Number(process.env.RATE_LIMIT_API_MAX) || 600, // ~2 req/s sustained per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit exceeded — slow down' },
  // req.url is mount-relative inside an app.use('/api', …) middleware, so match
  // on originalUrl to reliably see the full path.
  skip: (req) =>
    req.originalUrl.startsWith('/api/sync') ||
    req.originalUrl.startsWith('/api/capabilities'),
});

export const sensitiveLimiter = rateLimit({
  windowMs: minutes(15),
  max: Number(process.env.RATE_LIMIT_AUTH_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts — try again later' },
});
