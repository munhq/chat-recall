/**
 * The seam between this server and `@munhq/auth` and `@munhq/mcp-kit`.
 *
 * The kits hold the fleet's better-auth settings (sessions, cookies, codes,
 * TOTP, the CLI login, rate limits, the auth mails) and the MCP authorization
 * server (the options of `mcp()` and `cimd()`, the discovery documents, the
 * MCP endpoint). Like `@munhq/product-kit` they are private packages and
 * optional dependencies: the hosted image installs them, and the public
 * self-host image (`npm ci --omit=optional`) does not. auth/better-auth.ts
 * then builds the same settings itself.
 *
 * Loaded once at boot, before the auth instance is built, because the plugin
 * list is fixed when the instance is made.
 */
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('auth-kit');

type AuthKit = typeof import('@munhq/auth');
type McpKit = typeof import('@munhq/mcp-kit');

let auth: AuthKit | null = null;
let mcp: McpKit | null = null;
let loading: Promise<void> | null = null;

/** Load the kits. Safe to call more than once; later calls await the first. */
export function loadAuthKit(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        auth = await import('@munhq/auth');
      } catch {
        auth = null;
      }
      try {
        mcp = await import('@munhq/mcp-kit');
      } catch {
        mcp = null;
      }
      log.info({ auth: auth !== null, mcp: mcp !== null }, auth || mcp ? 'auth kits loaded' : 'auth kits are not installed: the server builds the auth settings itself');
    })();
  }
  return loading;
}

/** `@munhq/auth`, or null on a build that does not carry it. */
export function authKit(): AuthKit | null { return auth; }

/** `@munhq/mcp-kit`, or null on a build that does not carry it. */
export function mcpKit(): McpKit | null { return mcp; }

/** TESTS ONLY: install the kits directly, or put back "not installed" with null. */
export function __setAuthKits(a: AuthKit | null, m: McpKit | null = null): void {
  auth = a;
  mcp = m;
  loading = Promise.resolve();
}
