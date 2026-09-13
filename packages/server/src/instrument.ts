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
    /* otel.ts owns the TracerProvider. Without this Sentry installs a second
     * OpenTelemetry setup and both patch pg and http, so every query carries two
     * spans and one of them goes nowhere. */
    skipOpenTelemetrySetup: true,
    /* NO tracesSampleRate. Errors only, and the way to ask for that is to leave
     * the option out.
     *
     * `tracesSampleRate: 0` stood here and read as "off". It is the opposite.
     * hasSpansEnabled() in @sentry/core turns span RECORDING on whenever the
     * option is non-nullish, and its source carries the note: "`0` is not
     * nullish". So every HTTP request and every pg query built a span and
     * cloned the Sentry Scope, and the sampler threw the result away after the
     * allocation had already happened.
     *
     * Measured with the V8 sampling heap profiler on a production pod serving
     * about one request a minute, over 120 seconds:
     *
     *   Scope.clone                              49.99 MB
     *   _startChildSpan                          13.86 MB
     *   patchSpanEnd, from setScopeGucs           7.30 MB
     *   WeakRef, from withActiveSpan              4.25 MB
     *                                            ------
     *   81.4 MB in two minutes, ~61% of it Scope.clone
     *
     * setScopeGucs runs SELECT set_config on every pooled checkout, so the
     * instrumentation charged a span to the two queries that exist to set the
     * tenant. At roughly 40 MB a minute a 250 MB heap fills in about six, which
     * is the 7-24 minute window the pods were dying in: 421 OOM crashes in 14
     * days, every replica, continuously. */
  });
}
