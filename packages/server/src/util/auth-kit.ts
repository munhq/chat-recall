/**
 * The seam between this server and `@munhq/auth` and `@munhq/mcp-kit`.
 *
 * The kits hold the fleet's better-auth settings (sessions, cookies, codes,
 * TOTP, the CLI login, rate limits, the auth mails) and the MCP authorization
 * server (the options of `mcp()` and `cimd()`, the discovery documents, the
 * MCP endpoint). Both are normal dependencies, bundled into every image that the landing builds (the self-host
 * image included), so a missing kit is a broken install: `loadAuthKit` stops the boot, and the server never runs
 * with no redirect guard or no refresh guard.
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
      auth = await import('@munhq/auth');
      mcp = await import('@munhq/mcp-kit');
      log.info('auth kits loaded');
    })();
  }
  return loading;
}

/** `@munhq/auth`. Throws before `loadAuthKit` ran. */
export function authKit(): AuthKit {
  if (!auth) throw new Error('@munhq/auth is not loaded: call loadAuthKit() before the auth options are built');
  return auth;
}

/** `@munhq/mcp-kit`. Throws before `loadAuthKit` ran, so the guards are never left out. */
export function mcpKit(): McpKit {
  if (!mcp) throw new Error('@munhq/mcp-kit is not loaded: call loadAuthKit() before the auth options are built');
  return mcp;
}

/** TESTS ONLY: install the kits directly, or put back "not loaded" with null. */
export function __setAuthKits(a: AuthKit | null, m: McpKit | null = null): void {
  auth = a;
  mcp = m;
  loading = Promise.resolve();
}
