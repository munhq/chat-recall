/**
 * The redirect URIs an OAuth client of chat-recall may use: the copy of
 * `mcpRedirectGuard` of `@munhq/mcp-kit` (packages/mcp-kit/src/redirects.ts of
 * munhq/launchkit) for the self-host build, which does not carry the kit.
 * auth/better-auth.ts uses the kit's guard when the build carries it.
 *
 * Registration of MCP clients is open (`localMcp`), and the oauth-provider
 * plugin stores any `redirect_uris` the request names, so anybody could
 * register a client that sends the authorization code to their own host. The
 * guard accepts only the callbacks of the known MCP clients and loopback
 * (RFC 8252 §7.3), on registration, on the client endpoints of a signed-in
 * user, and on authorize. The check on authorize also refuses the clients that
 * were registered before the guard. A client whose `client_id` is an https URL
 * is a Client ID Metadata Document client, and `cimd()` checks it against its
 * document.
 */
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';

/**
 * The callbacks the MCP clients document. An entry that ends with `*` is a
 * prefix on the same origin.
 *
 * - claude.ai and Claude Desktop: claude.ai and claude.com.
 * - ChatGPT: the stable URI, and the per-callback URIs under /connector/oauth/.
 * - VS Code on the web, and Insiders.
 * - Cursor: hosted agents, and the desktop scheme.
 *
 * Claude Code, Cursor desktop, Windsurf, Gemini CLI, VS Code desktop and the
 * MCP Inspector use loopback, which `redirectAllowed` accepts on any port.
 */
export const MCP_REDIRECT_URIS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://chatgpt.com/connector/oauth/*',
  'https://vscode.dev/redirect',
  'https://insiders.vscode.dev/redirect',
  'https://www.cursor.com/agents/mcp/oauth/callback',
  'cursor://anysphere.cursor-mcp/oauth/callback',
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True when `uri` is http loopback, or matches an entry of `allowed`. */
export function redirectAllowed(uri: string, allowed: readonly string[] = MCP_REDIRECT_URIS): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return true;

  return allowed.some((entry) => {
    if (!entry.endsWith('*')) return uri === entry;
    const prefix = entry.slice(0, -1);
    // The origin check stops a prefix match that the URL parser reads as another host.
    return uri.startsWith(prefix) && url.origin === new URL(prefix).origin;
  });
}

export interface McpRedirectGuardOptions {
  /** Callbacks of the product's own clients, added to `MCP_REDIRECT_URIS`. Same format. */
  allow?: readonly string[];
}

/** The endpoints that store redirect URIs, and where their body holds them. */
const CLIENT_WRITES: Record<string, (body: Record<string, unknown>) => unknown> = {
  '/oauth2/register': (b) => b.redirect_uris,
  '/oauth2/create-client': (b) => b.redirect_uris,
  '/oauth2/update-client': (b) => (b.update as Record<string, unknown> | undefined)?.redirect_uris,
};

function refuse(uri: string): never {
  throw new APIError('BAD_REQUEST', {
    error: 'invalid_redirect_uri',
    error_description: `redirect_uri is not allowed: ${uri}`,
  });
}

/** better-auth plugin: `plugins: [..., mcpRedirectGuard()]`. */
export function mcpRedirectGuard(o: McpRedirectGuardOptions = {}): BetterAuthPlugin {
  const allowed = [...MCP_REDIRECT_URIS, ...(o.allow ?? [])];
  return {
    id: 'munhq-mcp-redirect-guard',
    hooks: {
      before: [
        {
          matcher: (ctx) => (ctx.path ?? '') in CLIENT_WRITES,
          handler: createAuthMiddleware(async (ctx) => {
            const uris = CLIENT_WRITES[ctx.path]!((ctx.body ?? {}) as Record<string, unknown>);
            if (!Array.isArray(uris)) return;
            for (const uri of uris) {
              if (typeof uri !== 'string' || !redirectAllowed(uri, allowed)) refuse(String(uri));
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/oauth2/authorize',
          handler: createAuthMiddleware(async (ctx) => {
            const q = (ctx.query ?? {}) as Record<string, unknown>;
            const clientId = typeof q.client_id === 'string' ? q.client_id : '';
            const uri = typeof q.redirect_uri === 'string' ? q.redirect_uri : '';
            if (!clientId || !uri || clientId.startsWith('https://')) return;
            if (!redirectAllowed(uri, allowed)) refuse(uri);
          }),
        },
      ],
    },
  };
}
