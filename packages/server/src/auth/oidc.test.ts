/**
 * The OIDC metadata must be TRUE, not merely present.
 *
 * The userinfo endpoint and the discovery document are covered in
 * better-auth.test.ts. This file guards the other half of the same defect: what
 * the discovery document CLAIMS about this server.
 *
 * better-auth advertised `id_token_signing_alg_values_supported: ["RS256"]`
 * while `/mcp/token` signs the id_token with an HMAC key it generates per
 * request and then discards (plugins/mcp/index.mjs: `generateKey({ name:
 * 'HMAC', hash: 'SHA-256' })`, alg HS256). So the token could not be verified
 * by anyone, and a client that fetched `jwks_uri` looking for the advertised
 * RSA key found an empty set and read the whole authorization server as broken.
 *
 * A login passing proves none of this. The flow completes and the tools work;
 * only a client that reads the metadata and believes it finds the contradiction
 * — and a directory review is exactly that client.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userinfoClaims } from './better-auth.js';

// `import.meta.dirname`, not `new URL('.', import.meta.url).pathname`. On
// Windows the URL form yields `/D:/a/...` with a leading slash, and joining
// that produces `D:\D:\a\...` — the file opens on Linux and macOS and fails
// only on Windows, which is precisely where the first version of this file
// broke CI. The sibling suite already uses import.meta.dirname; match it.
const HERE = import.meta.dirname;
const AUTH_TS = readFileSync(join(HERE, 'better-auth.ts'), 'utf8');
const SERVER_TS = readFileSync(join(HERE, '..', 'server.ts'), 'utf8');

describe('the advertised id_token algorithm is the one actually used', () => {
  it('advertises HS256, because that is what mcp() signs with', () => {
    expect(AUTH_TS).toMatch(/id_token_signing_alg_values_supported:\s*\['HS256'\]/);
  });

  it('no longer advertises RS256, for which no key exists or can exist', () => {
    expect(AUTH_TS).not.toMatch(/id_token_signing_alg_values_supported:\s*\['RS256'\]/);
  });

  it('keeps the JWK Set empty, which is now consistent rather than a wart', () => {
    // HS256 is symmetric: there is no public half to publish. The empty set was
    // always the true answer; advertising RS256 was what made it look broken.
    expect(SERVER_TS).toMatch(/json\(\{\s*keys:\s*\[\]\s*\}\)/);
  });

  it('carries the override into the plugin, not just into a comment', () => {
    // The override is spread rather than set, because better-auth's MCPOptions
    // type omits `metadata` while its runtime reads it. A spread that stopped
    // being applied would leave the document lying again, silently.
    expect(AUTH_TS).toMatch(/\.\.\.\(MCP_METADATA_OVERRIDE as/);
  });
});

describe('userinfoClaims — the claim that a domain restriction acts on', () => {
  const USER = { email: 'person@acme.example', emailVerified: true, name: 'A Person' };

  it('reports email_verified false rather than omitting it, so a check can refuse', () => {
    // Omission reads as "not asked". A restriction that cannot tell "unverified"
    // from "unasked" will admit an address nobody proved.
    const claims = userinfoClaims('u1', 'openid email', { ...USER, emailVerified: false });
    expect(claims.email_verified).toBe(false);
  });

  it('passes a verified address through as verified', () => {
    expect(userinfoClaims('u1', 'openid email', USER).email_verified).toBe(true);
  });

  it('withholds the address when the grant did not ask, even though we hold it', () => {
    const claims = userinfoClaims('u1', 'openid profile', USER);
    expect(claims.email).toBeUndefined();
    expect(claims.email_verified).toBeUndefined();
  });

  it('accepts the comma-joined scope string better-auth actually stores', () => {
    // The schema says a string; better-auth joins with a comma while RFC 6749
    // says space. Both reach this function, and only one was ever tested.
    expect(userinfoClaims('u1', 'openid,email', USER).email).toBe('person@acme.example');
  });

  it('treats an absent scope string as no grant, not as every grant', () => {
    for (const v of [undefined, null, '', '   ']) {
      expect(userinfoClaims('u1', v, USER)).toEqual({ sub: 'u1' });
    }
  });
});
