/**
 * Memory bound for the ingest route.
 *
 * The append route holds the whole request while it parses it: the raw body,
 * the gunzip buffer, the repaired container, the parsed messages, the re-gzip
 * and the JSON envelope live at the same time (measured in issue #16: about
 * 280 MiB of memory for one 32 MB archive). A pod with a 512 MiB limit then
 * dies on two appends of that size, and the collector sees HTTP 502.
 *
 * `ingestGate` (middleware/rate-limit.ts) bounds the row cost and the
 * concurrency of the WRITE, but it runs after `express.json` has buffered the
 * body. This guard runs BEFORE the parser, so it bounds the memory itself:
 *
 *   - a declared body above `maxBodyBytes` is refused with 413, before any
 *     buffer exists;
 *   - bodies are held within a byte budget: a body above `maxInflightBytes`
 *     runs ALONE, and a body that does not fit beside the bodies already held
 *     is refused with 429 and a `Retry-After` header (the collector honours
 *     both, see packages/cli/src/sync-client.ts).
 *
 * Worst case memory is therefore one body of `maxBodyBytes`, never the sum of
 * the requests that happen to arrive. A large body is never refused for being
 * large: refusing it would drop a real session that the collector cannot
 * chunk, and it costs the same memory alone as it did before this guard.
 *
 * Why alone rather than never: a normal full sync of a large session is a few
 * MB (the largest local transcripts compress about nine times), but a
 * transcript carrying pasted images is close to incompressible and can reach
 * the ceiling. Such a request is rare and is safe by itself; two at once are
 * what kills the pod.
 *
 * A chunked request carries no `content-length`, so the byte cap cannot refuse
 * it here; the parser's own `limit` (server.ts) stays as the ceiling for that
 * case.
 *
 * Both limits are env-tunable for an operator with a different pod budget.
 */
import type { Request, Response, NextFunction } from 'express';

export const DEFAULT_INGEST_MAX_BODY_BYTES = 16 * 1024 * 1024;
export const DEFAULT_INGEST_MAX_INFLIGHT = 2;
export const DEFAULT_INGEST_MAX_INFLIGHT_BYTES = 8 * 1024 * 1024;
/** How long a refused collector should wait. Short: a slot frees in seconds. */
export const INGEST_BUSY_RETRY_AFTER_MS = 2000;

export interface IngestBodyGuardOptions {
  maxBodyBytes?: number;
  maxInflight?: number;
  maxInflightBytes?: number;
}

/** Bodies held on this pod right now. Module state is per process, per pod. */
let inFlight = 0;
let inFlightBytes = 0;

export function ingestInFlight(): number {
  return inFlight;
}

export function ingestInFlightBytes(): number {
  return inFlightBytes;
}

/** Test seam: a failed assertion must not leak a held slot into the next test. */
export function resetIngestGuard(): void {
  inFlight = 0;
  inFlightBytes = 0;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function ingestBodyGuard(opts: IngestBodyGuardOptions = {}) {
  const maxBodyBytes = positiveInt(
    opts.maxBodyBytes ?? process.env.CHAT_RECALL_INGEST_MAX_BODY_BYTES,
    DEFAULT_INGEST_MAX_BODY_BYTES,
  );
  const maxInflight = positiveInt(
    opts.maxInflight ?? process.env.CHAT_RECALL_INGEST_MAX_INFLIGHT,
    DEFAULT_INGEST_MAX_INFLIGHT,
  );
  const maxInflightBytes = positiveInt(
    opts.maxInflightBytes ?? process.env.CHAT_RECALL_INGEST_MAX_INFLIGHT_BYTES,
    DEFAULT_INGEST_MAX_INFLIGHT_BYTES,
  );

  return function guard(req: Request, res: Response, next: NextFunction): void {
    // Declared size first: this refusal costs nothing, no body is read.
    const declared = Number(req.headers['content-length']);
    const sized = Number.isFinite(declared) && declared >= 0;
    if (sized && declared > maxBodyBytes) {
      res.status(413).json({
        error: `ingest body is ${declared} bytes, above the ${maxBodyBytes} byte limit`,
        code: 'body_too_large',
        max_bytes: maxBodyBytes,
      });
      return;
    }

    // An unsized (chunked) body counts as a full-budget body, so it can never
    // be admitted beside another large one on the strength of a missing header.
    const bytes = sized ? declared : maxInflightBytes;
    const alone = bytes > maxInflightBytes;
    const fits = alone
      ? inFlight === 0
      : inFlight < maxInflight && inFlightBytes + bytes <= maxInflightBytes;
    if (!fits) {
      const retryAfterS = Math.max(1, Math.ceil(INGEST_BUSY_RETRY_AFTER_MS / 1000));
      res.setHeader('Retry-After', String(retryAfterS));
      res.status(429).json({
        error: 'ingest is busy — retry shortly',
        code: 'ingest_busy',
        retry_after_ms: INGEST_BUSY_RETRY_AFTER_MS,
      });
      return;
    }

    inFlight += 1;
    inFlightBytes += bytes;
    // One release per request: `finish` and `close` both fire on a normal end,
    // and a client that drops mid-body fires only `close`. A held slot would
    // wedge the pod until the next deploy, so the latch matters.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
      inFlightBytes = Math.max(0, inFlightBytes - bytes);
    };
    res.on('finish', release);
    res.on('close', release);
    next();
  };
}
