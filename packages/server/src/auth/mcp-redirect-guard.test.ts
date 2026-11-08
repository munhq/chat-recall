/**
 * The two guards of the MCP authorization server come from `@munhq/mcp-kit` on every build. The registration and
 * authorize checks run against Postgres in oauth-migration.pg.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { __setAuthKits } from '../util/auth-kit.js';
import { authOptions } from './better-auth.js';

process.env.BETTER_AUTH_SECRET ??= 'mcp-guard-test-secret-0123456789abcdef';
const authKit = await import('@munhq/auth');
const mcpKit = await import('@munhq/mcp-kit');

const REDIRECT_GUARD = 'munhq-mcp-redirect-guard';
const pluginIds = () => authOptions({} as never).plugins.map((p) => p.id);

describe('the guards of the MCP authorization server', () => {
  afterEach(() => __setAuthKits(null, null));

  it('are installed from the kit', () => {
    __setAuthKits(authKit as never, mcpKit as never);
    const ids = pluginIds();
    expect(ids).toContain(REDIRECT_GUARD);
    expect(ids).toContain(mcpKit.mcpRefreshGuard().id);
  });

  it('are never left out: the options refuse to build with no kit loaded', () => {
    __setAuthKits(null, null);
    expect(() => authOptions({} as never)).toThrow(/is not loaded/);
  });
});
