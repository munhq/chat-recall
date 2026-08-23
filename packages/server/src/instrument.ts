/**
 * Sentry/GlitchTip initialization — imported FIRST in server.ts (before any
 * other module) so @sentry/node's auto-instrumentation hooks are installed
 * before the instrumented libraries load.
 *
 * Ships to whichever GlitchTip project the DSN points at; the `app` tag (+
 * server_name) marks these events as chat-recall so a shared project stays
 * filterable per app. No-ops when GLITCHTIP_DSN is unset (graceful degrade).
 *
 * The operator's own project name used to be written here. This repo is public
 * and the DSN already carries the destination, so naming private infrastructure
 * in a comment told a reader something about the operator and nothing about the
 * code.
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
