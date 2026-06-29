/**
 * HTTP observability — one middleware that both logs and meters every request.
 *
 * Replaces the old entry-only `console.log('[ts] METHOD PATH')`. On response
 * finish it:
 *   - records the Prometheus duration histogram + request counter + in-flight
 *     gauge, labelled by method / route-template / status (RED metrics), and
 *   - emits one structured log line at a level derived from the status
 *     (5xx→error, 4xx→warn, else info), carrying the reqId/tenant from the
 *     request context automatically.
 *
 * `/health` and `/metrics` are skipped: probes and scrapes fire constantly and
 * would drown the logs and bloat metric cardinality with self-referential series.
 */
import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import {
  httpRequestDuration, httpRequestsTotal, httpRequestsInFlight,
} from '../metrics/registry.js';

const log = createLogger('http');

function isSkipped(path: string): boolean {
  return path === '/health' || path === '/metrics' || path.startsWith('/metrics/');
}

/**
 * The express route template for stable, low-cardinality labels:
 * mount path + matched route path (e.g. `/api/conversations` + `/:id`). Requests
 * that matched no route (404s, static SPA fallback) collapse to `unmatched` so a
 * crawler can't explode the series count with one-off URLs.
 */
function routeLabel(req: Request): string {
  const base = req.baseUrl || '';
  const path = (req.route && (req.route as any).path) || '';
  const label = `${base}${path}`;
  return label || 'unmatched';
}

export function httpObservability(req: Request, res: Response, next: NextFunction): void {
  if (isSkipped(req.path)) return next();

  const start = process.hrtime.bigint();
  httpRequestsInFlight.inc();

  let done = false;
  const finalize = () => {
    if (done) return;
    done = true;
    const durSec = Number(process.hrtime.bigint() - start) / 1e9;
    const status = res.statusCode;
    const labels = { method: req.method, route: routeLabel(req), status: String(status) };

    httpRequestsInFlight.dec();
    httpRequestDuration.observe(labels, durSec);
    httpRequestsTotal.inc(labels);

    const payload = {
      method: req.method,
      route: labels.route,
      status,
      durationMs: Math.round(durSec * 1000),
      length: res.getHeader('content-length'),
    };
    if (status >= 500) log.error(payload, 'request failed');
    else if (status >= 400) log.warn(payload, 'request rejected');
    else log.info(payload, 'request');
  };

  // `finish` = response fully flushed; `close` = client hung up mid-flight.
  res.on('finish', finalize);
  res.on('close', finalize);
  next();
}
