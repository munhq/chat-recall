/**
 * Ambient types for `@munhq/mcp-kit`, which is an OPTIONAL dependency.
 *
 * Private, like `@munhq/auth`: the hosted image installs it, and the self-host
 * image does not. util/auth-kit.ts loads it with a dynamic import, and
 * auth/better-auth.ts builds the same options itself when it is absent. Only
 * the parts the server uses are here.
 */
declare module '@munhq/mcp-kit' {
  import type { McpOptions } from '@better-auth/mcp';
  import type { CimdOptions } from '@better-auth/cimd';

  export const MCP_SCOPES: string[];
  export function mcpResource(baseURL: string, path?: string): string;

  export interface FleetMcpOptions {
    baseURL: string;
    resourcePath?: string;
    loginPage?: string;
    consentPage?: string;
    scopes?: string[];
    registration?: 'open' | 'cimd';
    extend?: Partial<McpOptions>;
  }
  export function fleetMcp(o: FleetMcpOptions): McpOptions;
  export function fleetCimd(o?: { extend?: Partial<CimdOptions> }): CimdOptions;

  export const MCP_REDIRECT_URIS: readonly string[];
  export function redirectAllowed(uri: string, allowed?: readonly string[]): boolean;
  export function mcpRedirectGuard(o?: { allow?: readonly string[] }): import('better-auth').BetterAuthPlugin;

  export interface AuthHandlerLike {
    handler: (request: Request) => Promise<Response>;
    options: { basePath?: string };
  }
  export function wellKnownRoutes(o: { basePath: string; resourcePath?: string }): Record<string, string>;
  export function wellKnownHandler(auth: AuthHandlerLike, o?: { basePath?: string; resourcePath?: string }): (request: Request) => Promise<Response>;

  export interface McpServerLike {
    connect(transport: unknown): Promise<void>;
    close(): Promise<void>;
  }
  export interface McpCallContext {
    userId: string;
    clientId: string;
    scopes: string[];
    token: string;
    via: 'oauth' | 'api_key' | 'login';
    request: Request;
  }
  export interface McpRefusal {
    status: 401 | 403;
    reason: 'origin' | 'login_token' | 'api_key' | 'oauth' | 'scope';
    credential: 'none' | 'jwt' | 'opaque' | 'other';
    userAgent: string;
  }
  export interface McpHandlerOptions {
    auth: unknown;
    resource: string;
    createServer: (ctx: McpCallContext) => McpServerLike | Promise<McpServerLike>;
    trustedOrigins?: string[];
    jwksUrl?: string;
    issuer?: string;
    productName?: string;
    onError?: (error: unknown, ctx: McpCallContext) => void;
    onRefused?: (refusal: McpRefusal, request: Request) => void;
  }
  export function mcpHandler(o: McpHandlerOptions): (request: Request) => Promise<Response>;
}
