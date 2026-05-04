/**
 * Helpers for serving immutable-per-mtime responses with ETag +
 * Cache-Control. The data we cache server-side (diff/outcome/commits/
 * turns/markers/messages) is keyed by `(sessionId, mtime)` — once a
 * value is computed for a given mtime it never changes. That property
 * maps cleanly to HTTP "immutable" caching: the browser can hold the
 * payload forever and only re-fetch when the URL or ETag changes.
 *
 * `private` (not `public`) because each user's session data is
 * personal — we don't want shared CDNs/proxies caching it across
 * tenants when this becomes multi-tenant. Browser cache only.
 */

import type { Request, Response } from 'express';

/**
 * Build a stable, short ETag for the given (sessionId, kind, mtime).
 * Quoted per RFC 7232. mtime alone is enough — the server-side cache
 * key already encodes it, and the kind+id are in the URL.
 */
export function buildETag(parts: Array<string | number>): string {
  // Cheap, deterministic hash. Not crypto — just for cache identity.
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return `"${(h >>> 0).toString(36)}"`;
}

/**
 * Apply ETag + Cache-Control headers and short-circuit to 304 if the
 * client already has the matching version. Call right before
 * `res.json(payload)` — returns `true` when the response was finished
 * (so the caller should `return`) and `false` when the caller should
 * continue and send the body.
 */
export function maybeSendNotModified(req: Request, res: Response, etag: string, maxAgeSeconds = 31536000): boolean {
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', `private, max-age=${maxAgeSeconds}, immutable`);
  // Vary so a browser cache doesn't reuse a compressed body for an
  // uncompressed request (or vice versa).
  res.setHeader('Vary', 'Accept-Encoding');

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === '*')) {
    res.status(304).end();
    return true;
  }
  return false;
}
