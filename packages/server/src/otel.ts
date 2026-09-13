/**
 * OpenTelemetry traces → Tempo.
 *
 * Imported FIRST in server.ts, before instrument.ts and before any instrumented
 * library loads, because an instrumentation can only patch a module it sees
 * required after it is registered.
 *
 * WHY THIS EXISTS. MONITORING.md recorded chat-recall as having "the log field
 * (trace_id via pino) and the metrics; nothing exports spans". Half of that was
 * optimistic: a production request line carries component, durationMs, length,
 * level, method, msg, reqId, route, service, status, tenant and time, and no
 * trace_id at all. Nothing was ever wired — not the SDK, not the exporter, not
 * the log field.
 *
 * What DID run was @sentry/node's own OpenTelemetry setup, on
 * `tracesSampleRate: 0`. hasSpansEnabled() in @sentry/core treats any
 * non-nullish value as "record spans", so every HTTP request and every pg query
 * built a span and cloned the Sentry Scope, and the sampler discarded the
 * result after the allocation. Measured on a production pod with the V8
 * sampling profiler over 120s: 81.4 MB allocated, 50.0 MB of it Scope.clone.
 * Tempo received none of it.
 *
 * The sampler here runs BEFORE the span is built: at a 0.1 ratio the SDK
 * returns a NonRecordingSpan for nine calls in ten and allocates nothing for
 * them. That is the difference between this and what it replaces.
 *
 * CONFIGURED ENTIRELY BY THE STANDARD OTEL_* VARIABLES, so nothing about any
 * one deployment is written here:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT   http://collector.example:4318
 *   OTEL_EXPORTER_OTLP_PROTOCOL   http/protobuf
 *   OTEL_SERVICE_NAME             chat-recall
 *   OTEL_RESOURCE_ATTRIBUTES      service.namespace=acme,deployment.environment=prod
 *   OTEL_TRACES_SAMPLER           parentbased_traceidratio
 *   OTEL_TRACES_SAMPLER_ARG       0.1
 *
 * Those names are the OpenTelemetry spec's, so any collector reads them and any
 * SDK writes them. The values belong to whoever runs the deployment.
 *
 * With OTEL_EXPORTER_OTLP_ENDPOINT unset this file starts nothing, so a local
 * run and a self-hosted deployment are unaffected. An SDK with an endpoint set
 * and no collector behind it queues spans and retries for ever, which is the
 * reason the chart's own helper defaults to disabled.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

let sdk: NodeSDK | null = null;

export function startTracing(): void {
  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim();
  if (!endpoint) return;

  sdk = new NodeSDK({
    // The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT itself and appends
    // /v1/traces. Resource attributes, service name and the sampler all come
    // from the OTEL_* environment, so nothing about the fleet's conventions is
    // restated here.
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      // Health and metrics are scraped every few seconds by kubelet and
      // Prometheus. Tracing them buries real traffic in noise and pays storage
      // for it.
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => {
          const url = req.url || '';
          return url.startsWith('/health') || url.startsWith('/metrics');
        },
      }),
      new ExpressInstrumentation(),
      // The pg spans are the ones worth having: setScopeGucs runs
      // SELECT set_config on every pooled checkout, so a slow tenant switch is
      // visible here and nowhere else.
      new PgInstrumentation(),
    ],
  });

  sdk.start();

  // Flush on the way out so the last spans of a rolling pod are not lost.
  // SIGTERM is what Kubernetes sends; the shutdown is bounded because a pod
  // being replaced must not wait on a collector.
  const stop = () => { void sdk?.shutdown().catch(() => { /* going away anyway */ }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
