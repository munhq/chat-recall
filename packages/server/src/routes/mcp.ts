/**
 * The REMOTE MCP endpoint — `POST /mcp`, Streamable HTTP, OAuth-authenticated.
 *
 * This is the surface a client that cannot run our CLI connects to: claude.ai,
 * ChatGPT, a browser IDE, anything in an MCP directory. It serves the SAME tool
 * table the stdio server does (@chat-recall/engine/mcp/tools.js) — that is the
 * point of having moved the surface into the engine, and it is what stops the
 * hosted product and the local one drifting into two different things.
 *
 * ── How a caller becomes a tenant ─────────────────────────────────────────
 *
 * 1. The client sends `Authorization: Bearer <oauth access token>`.
 * 2. `getMcpSession` resolves it to a better-auth `userId`, which IS the `sub`
 *    every tenant row is keyed on — so an MCP identity is the account identity,
 *    not a parallel one.
 * 3. The tools then call the server's OWN REST API over loopback, presenting
 *    that same token. It reaches `tenantAuth` exactly like the CLI's device
 *    token does, which means the caller passes through every gate already in
 *    place: workspace provisioning, the entitlement hard stop, rate limits, RLS.
 *
 * Point 3 is the design decision worth defending. Calling the service layer
 * in-process would be faster and would BYPASS every one of those gates, each of
 * which would then need a second implementation here. One HTTP hop over
 * 127.0.0.1 buys correctness that cannot drift.
 *
 * ── Statelessness ─────────────────────────────────────────────────────────
 *
 * The kit serves each request with a fresh transport and server
 * (`sessionIdGenerator: undefined`). A client's second request can land on
 * another replica, and the recall tools are all request/response.
 */
import { Router, type Request, type Response } from 'express';
import {
  createMcpServer, setServerVersion, setMultiTenantMode, withCredentials,
} from '@chat-recall/engine/mcp/tools.js';
import { currentCredentials } from '@chat-recall/engine/mcp/credential-context.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { mcpAuthInstance, mcpResourceUrl, authIssuer } from '../auth/better-auth.js';
import { mcpKit } from '../util/auth-kit.js';

const log = createLogger('mcp-remote');
const router = Router();

/**
 * The version this endpoint reports. The server's own — a remote caller is
 * served by whatever we deployed, and there is nothing for them to upgrade.
 */
setServerVersion(process.env.CHAT_RECALL_SERVER_VERSION || 'hosted');

/**
 * Tell the tool surface it is serving many people, not one.
 *
 * This drops `recall_index` and `recall_code_index` from the listing. Both read
 * the CALLER'S OWN DISK, and this process's disk holds nobody's transcripts —
 * offering them here would advertise a capability that cannot work and, worse,
 * would look like it had worked.
 */
setMultiTenantMode(true);

/** Where the tools call back to. Loopback, not the public hostname: the request
 *  must not leave the pod, and a public hairpin would add a TLS handshake and a
 *  proxy hop to every single tool call. */
function selfBase(): string {
  return `http://127.0.0.1:${process.env.PORT || 5000}`;
}

type FetchHandler = (request: globalThis.Request) => Promise<globalThis.Response>;
let kitServe: FetchHandler | null = null;

/**
 * `mcpHandler` of `@munhq/mcp-kit`. It checks the origin (a page on another site
 * cannot drive the tools from a signed-in browser) and the access token, and
 * writes the 401 with `resource_metadata` and the 405s. A fresh transport and
 * server serve each request, so any replica can serve any request.
 */
function kitHandler(): FetchHandler {
  if (kitServe) return kitServe;
  kitServe = mcpKit().mcpHandler({
    auth: mcpAuthInstance(),
    resource: mcpResourceUrl(),
    issuer: authIssuer(),
    jwksUrl: `${selfBase()}/api/auth/jwks`,
    trustedOrigins: (process.env.TRUSTED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    productName: 'chat-recall',
    // The tools call the REST API over loopback with the caller's own token.
    // serveWithKit put a credentials object for this request in the store;
    // the token is known only here, after the check.
    createServer: (ctx) => {
      const creds = currentCredentials();
      if (creds) creds.token = ctx.token;
      return createMcpServer();
    },
    onError: (err, ctx) => log.error({ err, userId: ctx.userId }, 'mcp request failed'),
    onRefused: (refusal) => log.warn(refusal, 'mcp bearer refused'),
  });
  return kitServe;
}

/** The Express request as a Fetch request. express.json() has read the body already. */
function toFetchRequest(req: Request): globalThis.Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.delete('content-length');
  return new globalThis.Request(`${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`, {
    method: req.method,
    headers,
    body: JSON.stringify(req.body ?? null),
  });
}

async function serveWithKit(handler: FetchHandler, req: Request, res: Response): Promise<void> {
  const creds = { base: selfBase(), token: '' };
  try {
    const response = await withCredentials(creds, () => handler(toFetchRequest(req)));
    res.status(response.status);
    response.headers.forEach((value, name) => {
      if (name !== 'content-length' && name !== 'transfer-encoding') res.setHeader(name, value);
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    log.error({ err }, 'mcp request failed');
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
}

router.post('/', async (req: Request, res: Response) => {
  await serveWithKit(kitHandler(), req, res);
});

/**
 * GET and DELETE exist only to answer correctly.
 *
 * The spec has them open an SSE stream and end a session; stateless mode has
 * neither. 405 with `Allow` is the honest answer and lets a client fall back to
 * POST-only, which every one of them supports. Answering 404 instead would read
 * as "no endpoint here" and send a working client away.
 */
router.get('/', (req, res, next) => {
  // A BROWSER asking for /mcp/ wants the documentation page, and there is one:
  // README.md links https://chatrecall.dev/mcp/ and that README ships to npm.
  // Mounting this router above express.static turned that live, published URL
  // into a JSON-RPC 405 — a regression visible to anyone who followed the link.
  //
  // Split on Accept rather than moving either one. The endpoint URL is already
  // published in the protected-resource metadata a client has cached, so moving
  // it breaks discovery; the docs URL is in a README already on npm, so moving
  // that breaks a link we cannot recall. An MCP client asking for a GET stream
  // sends `Accept: text/event-stream`; a browser never does.
  if ((req.get('accept') || '').includes('text/event-stream')) {
    res.setHeader('Allow', 'POST');
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'This endpoint is POST-only (stateless Streamable HTTP); reconnect with POST.' },
      id: null,
    });
    return;
  }
  next();   // fall through to the static handler, which serves the docs page
});

router.delete('/', (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This endpoint is POST-only (stateless Streamable HTTP); there is no session to end.' },
    id: null,
  });
});

export default router;
