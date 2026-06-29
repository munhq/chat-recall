/**
 * Per-request correlation context.
 *
 * Holds a request id (and, once auth resolves, the tenant/user) in an
 * AsyncLocalStorage so every log line emitted while handling a request carries
 * `{ reqId, tenant }` automatically — no manual threading. The engine logger
 * pulls these via the context provider registered in server.ts.
 *
 * The id comes from an inbound `x-request-id` (set by Traefik/ingress or a
 * caller) when present, else a fresh UUID, and is echoed back on the response so
 * a client error can be traced to exactly one server log line.
 */
import type { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  reqId: string;
  tenant?: string;
  userId?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

/** The active request's context, or undefined outside a request. */
export function currentRequestContext(): RequestContext | undefined {
  return als.getStore();
}

/**
 * The fields the logger should mix into every line. Kept tiny on purpose — high
 * cardinality belongs in explicit log payloads, not on every line.
 */
export function logContext(): Record<string, unknown> | undefined {
  const ctx = als.getStore();
  if (!ctx) return undefined;
  const out: Record<string, unknown> = { reqId: ctx.reqId };
  if (ctx.tenant) out.tenant = ctx.tenant;
  return out;
}

const REQUEST_ID_HEADER = 'x-request-id';

/** Establish the correlation context for the request and echo the id back. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers[REQUEST_ID_HEADER];
  const reqId = (Array.isArray(inbound) ? inbound[0] : inbound) || randomUUID();
  res.setHeader(REQUEST_ID_HEADER, reqId);
  als.run({ reqId }, () => next());
}

/**
 * Backfill the tenant/user onto the active context once auth has resolved them.
 * Mounted right after tenantAuth so subsequent logs are tenant-attributed.
 */
export function attachTenantToContext(req: Request, _res: Response, next: NextFunction): void {
  const ctx = als.getStore();
  if (ctx) {
    ctx.tenant = (req as any).tenant ?? ctx.tenant;
    ctx.userId = (req as any).userId ?? ctx.userId;
  }
  next();
}
