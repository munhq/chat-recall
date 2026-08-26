/**
 * Resolve a CIMD client_id just before better-auth's authorize endpoint runs.
 *
 * Mounted on `/api/auth/mcp/authorize` AHEAD of the better-auth catch-all. It
 * looks at one query parameter and, in the ordinary case, does nothing:
 *
 *   client_id is not an https URL   -> next(), instantly. This is every DCR
 *                                      client, claude.ai included.
 *   client_id is already stored     -> next() after one indexed SELECT.
 *   otherwise                       -> fetch and validate the metadata document,
 *                                      store it, then next(). better-auth now
 *                                      sees a client it knows and validates
 *                                      redirect_uri, PKCE and consent itself.
 *
 * So there is exactly one authorization code path, and CIMD is a way of learning
 * a client rather than a second way of authorizing one. That matters more than it
 * sounds: a parallel path is how the strict checks end up on only one of them.
 *
 * A refusal answers the way OAuth expects — `error=invalid_client` with a short
 * description — because a client that cannot be resolved must be able to tell
 * why, and a 500 tells it nothing. The reason is deliberately terse in the
 * response and complete in the log: "resolves to a non-public address" in a
 * public error message is a network-probing oracle.
 */
import type { RequestHandler } from 'express';
import { resolveCimdClient, isCimdClientId } from './cimd.js';
import { upsertCimdClient, cimdClientExists } from './better-auth.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('cimd');

/** Resolutions and refusals, briefly, so a retry storm costs one fetch. */
const cache = new Map<string, { at: number; ok: boolean }>();
const CACHE_MS = 10 * 60 * 1000;
/** A refusal is cached for less time: a client fixing its document should not
 *  wait ten minutes to be believed. */
const NEGATIVE_CACHE_MS = 60 * 1000;

export function _resetCimdCache(): void { cache.clear(); }

export function mcpCimdResolver(): RequestHandler {
  return (req, res, next) => {
    const raw = req.query?.client_id;
    const clientId = typeof raw === 'string' ? raw : undefined;
    if (!isCimdClientId(clientId)) return next();
    const id = clientId as string;

    // Only the POSITIVE cache short-circuits here. A cached REFUSAL must not,
    // because it would outrank a client that has since become resolvable — and
    // it did: a transient failure pinned a client_id as invalid for a minute,
    // and the row written in the meantime could not get it unstuck. Stored
    // beats remembered, always.
    const hit = cache.get(id);
    if (hit?.ok && Date.now() - hit.at < CACHE_MS) return next();

    void (async () => {
      try {
        // Already known — a DCR client whose id happens to be a URL, or a CIMD
        // client we resolved before the cache was dropped. Checked FIRST, and
        // ahead of the negative cache, so the stored row is authoritative.
        if (await cimdClientExists(id)) {
          cache.set(id, { at: Date.now(), ok: true });
          return next();
        }
        // Not stored. Now a fresh refusal is worth honouring, and it is what
        // keeps a retrying client from making us re-fetch on every attempt.
        const neg = cache.get(id);
        if (neg && !neg.ok && Date.now() - neg.at < NEGATIVE_CACHE_MS) {
          return refuse(res, 'the client metadata document could not be used');
        }
        const r = await resolveCimdClient(id);
        if (!r.ok) {
          cache.set(id, { at: Date.now(), ok: false });
          log.warn({ clientId: id, reason: r.reason }, 'refused a CIMD client_id');
          return refuse(res, 'the client metadata document could not be used');
        }
        await upsertCimdClient(r.client);
        cache.set(id, { at: Date.now(), ok: true });
        log.info({ clientId: id, name: r.client.clientName, redirectUris: r.client.redirectUris.length },
          'resolved a CIMD client_id');
        return next();
      } catch (err) {
        // Never a 500 from here: an authorize request that dies on our
        // bookkeeping looks to the client like the server rejecting its identity,
        // which sends whoever is debugging it in the wrong direction.
        log.error({ clientId: id, err: err instanceof Error ? err.message : String(err) },
          'CIMD resolution failed');
        return refuse(res, 'the client metadata document could not be resolved');
      }
    })();
  };
}

function refuse(res: Parameters<RequestHandler>[1], description: string): void {
  if (res.headersSent) return;
  res.status(400).json({ error: 'invalid_client', error_description: description });
}
