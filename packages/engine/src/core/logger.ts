/**
 * Structured logging — the one logger every package uses.
 *
 * JSON to stdout by default (one line per event), so Vector/Loki and any
 * log-shipping pipeline can parse it without regex. Plain `console.*` is
 * unparseable at scale, carries no level/timestamp/context, and can't be
 * filtered or correlated — this replaces all of it.
 *
 * Context correlation: the server registers a context provider (request id +
 * tenant, kept in an AsyncLocalStorage) via `setLogContextProvider`. Every log
 * emitted while handling a request then carries `{ reqId, tenant }` with zero
 * call-site plumbing — `mixin` injects it. The engine has no HTTP concept, so it
 * stays decoupled: no provider registered ⇒ no extra fields, identical behaviour.
 *
 * Levels via LOG_LEVEL (default: info in production, debug otherwise).
 * Human-readable dev output via LOG_PRETTY=1 (uses pino-pretty if resolvable;
 * silently falls back to JSON if it isn't installed — e.g. in the engine alone).
 */
import { createRequire } from 'node:module';
import pino, { type Logger } from 'pino';

/** Returns ambient fields to attach to every log line (e.g. request id, tenant). */
export type LogContextProvider = () => Record<string, unknown> | undefined;

let contextProvider: LogContextProvider | undefined;

/**
 * Register a provider that supplies ambient context (request id, tenant, …) for
 * every subsequent log line. The server sets this from its per-request
 * AsyncLocalStorage; other consumers can leave it unset.
 */
export function setLogContextProvider(provider: LogContextProvider): void {
  contextProvider = provider;
}

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// Optional pretty printing for local dev. We resolve pino-pretty lazily so the
// engine (which doesn't depend on it) never crashes when LOG_PRETTY is unset or
// the module is absent — we just keep JSON.
function prettyTransport(): pino.TransportSingleOptions | undefined {
  if (process.env.LOG_PRETTY !== '1') return undefined;
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' } };
  } catch {
    return undefined; // pino-pretty not installed → stay on JSON
  }
}

const baseOptions: pino.LoggerOptions = {
  level,
  base: { service: process.env.LOG_SERVICE || 'chat-recall' },
  // Inject ambient request context (set by the server) into every line.
  mixin() {
    return contextProvider?.() ?? {};
  },
  // Never let a secret reach the log pipeline. Covers the common header/field
  // shapes our code and deps put on logged objects.
  redact: {
    paths: [
      'authorization', 'cookie', 'password', 'token', 'apiKey', 'api_key',
      'secret', 'DB_PASS', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
      'req.headers.authorization', 'req.headers.cookie',
      'headers.authorization', 'headers.cookie',
    ],
    censor: '[redacted]',
  },
  formatters: {
    // Emit the level as a word ("info") not a number — friendlier for Loki/jq.
    level(label) {
      return { level: label };
    },
  },
};

const transport = prettyTransport();
// JSON straight to stdout (no worker thread) is the default/production path;
// only pretty mode spins up a pino-pretty transport.
export const logger: Logger = transport ? pino(baseOptions, pino.transport(transport)) : pino(baseOptions);

/**
 * A child logger tagged with a component name. Use one per module so every line
 * carries `{ component: 'summary-worker' }` and logs can be filtered by source.
 *
 *   const log = createLogger('summary-worker');
 *   log.info({ generated, failed }, 'sweep complete');
 */
export function createLogger(component: string): Logger {
  return logger.child({ component });
}
