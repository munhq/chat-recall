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
 * A fresh transport and Server per request (`sessionIdGenerator: undefined`).
 * The alternative keeps a sessionId→transport map in process memory, which
 * breaks the moment there is more than one replica — a client's second request
 * lands on a pod that never saw its first — and leaks a transport for every
 * client that disconnects without saying goodbye. The recall tools are all
 * request/response, so there is nothing a long-lived session would buy.
 */
import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createMcpServer, setServerVersion, setMultiTenantMode, withCredentials,
} from '@chat-recall/engine/mcp/tools.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { mcpSessionFor } from '../auth/better-auth.js';

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

/**
 * Reject a cross-origin browser request.
 *
 * A page on any site can POST to this endpoint from a victim's browser; without
 * this check a logged-in cookie would be enough to drive their tools (DNS
 * rebinding, in the MCP spec's words). A NON-browser client — every real MCP
 * client — sends no Origin at all, so absence is allowed and only a PRESENT,
 * unrecognised Origin is refused.
 */
function originAllowed(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true;
  const allowed = (process.env.TRUSTED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return allowed.includes(origin.replace(/\/+$/, ''));
}

/**
 * The 401 that STARTS the OAuth flow.
 *
 * `WWW-Authenticate` carrying `resource_metadata` is not decoration: it is how a
 * client discovers where to authenticate (RFC 9728 §5.1). Without it a client
 * receiving 401 has nowhere to go, and the connector simply fails to connect
 * with no way to diagnose it.
 */
function unauthorized(req: Request, res: Response): void {
  const base = (process.env.BETTER_AUTH_URL || `http://${req.get('host') ?? 'localhost'}`).replace(/\/+$/, '');
  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
  );
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized: connect this account with OAuth to use chat-recall.' },
    id: null,
  });
}

router.post('/', async (req: Request, res: Response) => {
  if (!originAllowed(req)) {
    res.status(403).json({ error: 'origin not allowed' });
    return;
  }

  const session = await mcpSessionFor(req.headers).catch(() => null);
  if (!session) {
    unauthorized(req, res);
    return;
  }

  // The caller's own token, for the caller's own request only. withCredentials
  // scopes it to this async subtree, so two requests in flight on this process
  // cannot see each other's — the property asserted in credential-context.test.ts
  // and the reason a process-wide credential was never an option here.
  const creds = { base: selfBase(), token: session.accessToken };

  // Everything from here is inside the try, and the cleanup is registered before
  // anything can throw. Constructing outside it left a window where a throw
  // between `new Transport` and `res.on('close')` leaked the transport — and
  // express 4 does not catch a rejected async handler, so the rejection went
  // unhandled rather than to the 500 below.
  let transport: StreamableHTTPServerTransport | null = null;
  let server: ReturnType<typeof createMcpServer> | null = null;
  res.on('close', () => {
    void transport?.close().catch(() => {});
    void server?.close().catch(() => {});
  });

  try {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    server = createMcpServer();
    await server.connect(transport);
    await withCredentials(creds, () => transport!.handleRequest(req, res, req.body));
  } catch (err) {
    log.error({ err, userId: session.userId }, 'mcp request failed');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
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
