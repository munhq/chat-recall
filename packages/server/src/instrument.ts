/**
 * Sentry/GlitchTip initialization — imported FIRST in server.ts (before any
 * other module) so @sentry/node's auto-instrumentation hooks are installed
 * before the instrumented libraries load.
 *
 * Ships to the shared `munhq-backend` GlitchTip project; the `app` tag (+
 * server_name) marks these events as chat-recall so the tier project stays
 * filterable per app. No-ops when GLITCHTIP_DSN is unset (graceful degrade).
 */
import * as Sentry from '@sentry/node';

const dsn = process.env.GLITCHTIP_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    serverName: 'chat-recall',
    initialScope: { tags: { app: 'chat-recall' } },
    tracesSampleRate: 0, // error tracking only
  });
}
