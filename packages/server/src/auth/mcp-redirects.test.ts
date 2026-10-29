/**
 * The OAuth redirect guard on both builds: the hosted image installs the guard
 * of @munhq/mcp-kit, and the self-host image, which has no kit, installs the
 * copy in mcp-redirects.ts. The registration and authorize checks run against
 * Postgres in oauth-migration.pg.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as mcpKit from '@munhq/mcp-kit';
import { __setAuthKits } from '../util/auth-kit.js';
import { authOptions } from './better-auth.js';
import { redirectAllowed, MCP_REDIRECT_URIS } from './mcp-redirects.js';

const GUARD = 'munhq-mcp-redirect-guard';
const pluginIds = () => authOptions({} as never).plugins.map((p) => p.id);

describe('the OAuth redirect guard', () => {
  afterEach(() => __setAuthKits(null, null));

  it('is installed from the kit when the build carries it', () => {
    __setAuthKits(null, mcpKit as never);
    expect(pluginIds()).toContain(GUARD);
  });

  it('is installed from the local copy on the self-host build', () => {
    __setAuthKits(null, null);
    expect(pluginIds()).toContain(GUARD);
  });

  it('keeps the same list and the same rules as the kit', () => {
    expect(MCP_REDIRECT_URIS).toEqual(mcpKit.MCP_REDIRECT_URIS);
    for (const uri of [
      'https://claude.ai/api/mcp/auth_callback',
      'https://chatgpt.com/connector/oauth/abc',
      'http://127.0.0.1:33418/',
      'https://attacker-alpha.example.com/cb',
      'https://chatgpt.com.attacker-alpha.example.com/connector/oauth/x',
      'http://user@127.0.0.1/cb',
      'javascript:alert(1)',
    ]) {
      expect(redirectAllowed(uri), uri).toBe(mcpKit.redirectAllowed(uri));
    }
  });
});
