/**
 * CIMD resolution, and mostly the refusals.
 *
 * The client_id is attacker-controlled and the server FETCHES it, so the
 * interesting inputs are the hostile ones: an internal address, a public name
 * that resolves to a private one, a redirect to somewhere else, a document that
 * claims an identity it does not own. None of those can be produced by asking a
 * live server nicely, which is the whole reason the fetch and the DNS lookup are
 * injected.
 */
import { describe, it, expect } from 'vitest';
import {
  isCimdClientId,
  isBlockedAddress,
  validateCimdUrl,
  validateCimdDocument,
  resolveCimdClient,
  type CimdDeps,
} from './cimd.js';

const URL_OK = 'https://smithery.ai/client-metadata.json';

/** A well-formed document for the URL above. */
const doc = (over: Record<string, unknown> = {}) => ({
  client_id: URL_OK,
  client_name: 'Smithery',
  redirect_uris: ['https://smithery.ai/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  ...over,
});

const deps = (over: Partial<CimdDeps> = {}): CimdDeps => ({
  resolve: async () => ['93.184.216.34'],
  fetchDoc: async () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(doc()) }),
  ...over,
});

describe('isCimdClientId', () => {
  it('is true only for an https URL', () => {
    expect(isCimdClientId(URL_OK)).toBe(true);
    // Every DCR client — the middleware must return instantly for these.
    expect(isCimdClientId('KUxTUBZxtQvPFmIiKPUPClNoPfDjYIwR')).toBe(false);
    expect(isCimdClientId('chat-recall-cli')).toBe(false);
    expect(isCimdClientId('http://smithery.ai/x.json')).toBe(false);
    expect(isCimdClientId(undefined)).toBe(false);
    expect(isCimdClientId('')).toBe(false);
  });
});

describe('isBlockedAddress', () => {
  it('blocks the ranges an SSRF aims at', () => {
    for (const a of [
      '127.0.0.1', '127.1.2.3',       // loopback
      '169.254.169.254',              // cloud instance metadata — the classic
      '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '100.64.0.1',                   // CGNAT
      '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1',
      '::ffff:127.0.0.1',             // IPv4 loopback in IPv6 clothing
    ]) {
      expect(isBlockedAddress(a), `${a} must be blocked`).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const a of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isBlockedAddress(a), `${a} must be allowed`).toBe(false);
    }
  });

  it('blocks anything that is not an address at all', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('validateCimdUrl', () => {
  it('accepts a plain https URL', () => {
    expect(validateCimdUrl(URL_OK).ok).toBe(true);
  });

  it('refuses the shapes that smuggle something past the checks', () => {
    const cases: Array<[string, RegExp]> = [
      ['http://smithery.ai/x.json', /https/],
      ['ftp://smithery.ai/x.json', /https/],
      ['https://user:pw@smithery.ai/x.json', /credentials/],
      ['https://smithery.ai/x.json#frag', /fragment/],
      ['https://smithery.ai:8443/x.json', /port/],
      // A bare address would bypass the point of resolving the name.
      ['https://169.254.169.254/latest/meta-data/', /address/],
      ['https://127.0.0.1/x.json', /address/],
      ['not a url', /not a URL/],
    ];
    for (const [input, re] of cases) {
      const r = validateCimdUrl(input);
      expect(r.ok, `${input} must be refused`).toBe(false);
      if (!r.ok) expect(r.reason, input).toMatch(re);
    }
  });
});

describe('validateCimdDocument', () => {
  it('accepts a well-formed document', () => {
    const r = validateCimdDocument(URL_OK, doc());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.client.clientId).toBe(URL_OK);
      expect(r.client.clientName).toBe('Smithery');
      expect(r.client.redirectUris).toEqual(['https://smithery.ai/callback']);
      expect(r.client.isPublic).toBe(true);
    }
  });

  it('refuses a document that does not name itself', () => {
    // THE load-bearing check. Without it, any host serving JSON with a
    // redirect_uris array becomes a usable client — an open redirector built out
    // of someone else's file uploads.
    const r = validateCimdDocument(URL_OK, doc({ client_id: 'https://evil.example/other.json' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not match its own URL/);
  });

  it('refuses a redirect_uri that is not https or loopback', () => {
    for (const u of ['app://callback', 'javascript:alert(1)', 'file:///etc/passwd', 'http://evil.example/cb']) {
      const r = validateCimdDocument(URL_OK, doc({ redirect_uris: [u] }));
      expect(r.ok, `${u} must be refused`).toBe(false);
    }
  });

  it('allows loopback redirects, which local MCP clients really use', () => {
    for (const u of ['http://127.0.0.1:9999/callback', 'http://localhost:1234/cb']) {
      expect(validateCimdDocument(URL_OK, doc({ redirect_uris: [u] })).ok, u).toBe(true);
    }
  });

  it('refuses a confidential client', () => {
    // A CIMD client published its own identity, so anyone can claim it. Treating
    // it as confidential would mean minting a secret that proves nothing.
    const r = validateCimdDocument(URL_OK, doc({ token_endpoint_auth_method: 'client_secret_basic' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/public/);
  });

  it('refuses documents missing what the flow needs', () => {
    expect(validateCimdDocument(URL_OK, doc({ redirect_uris: [] })).ok).toBe(false);
    expect(validateCimdDocument(URL_OK, doc({ redirect_uris: undefined })).ok).toBe(false);
    expect(validateCimdDocument(URL_OK, doc({ client_id: undefined })).ok).toBe(false);
    expect(validateCimdDocument(URL_OK, doc({ grant_types: ['client_credentials'] })).ok).toBe(false);
    expect(validateCimdDocument(URL_OK, doc({ response_types: ['token'] })).ok).toBe(false);
    expect(validateCimdDocument(URL_OK, 'a string').ok).toBe(false);
    expect(validateCimdDocument(URL_OK, null).ok).toBe(false);
    expect(validateCimdDocument(URL_OK, [doc()]).ok).toBe(false);
  });

  it('falls back to the hostname when no client_name is given', () => {
    const r = validateCimdDocument(URL_OK, doc({ client_name: '   ' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.client.clientName).toBe('smithery.ai');
  });

  it('caps an absurd redirect_uris list', () => {
    const many = Array.from({ length: 21 }, (_, i) => `https://smithery.ai/cb${i}`);
    expect(validateCimdDocument(URL_OK, doc({ redirect_uris: many })).ok).toBe(false);
  });
});

describe('resolveCimdClient', () => {
  it('resolves a good client end to end', async () => {
    const r = await resolveCimdClient(URL_OK, deps());
    expect(r.ok).toBe(true);
  });

  it('refuses a public NAME that resolves to a private address', async () => {
    // The attack a hostname check cannot see, and the reason the guard runs
    // after DNS instead of before it.
    const r = await resolveCimdClient(URL_OK, deps({ resolve: async () => ['10.0.0.5'] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/non-public address/);
  });

  it('refuses when ANY resolved address is private, not just the first', async () => {
    const r = await resolveCimdClient(URL_OK, deps({ resolve: async () => ['93.184.216.34', '127.0.0.1'] }));
    expect(r.ok).toBe(false);
  });

  it('refuses a host that does not resolve', async () => {
    expect((await resolveCimdClient(URL_OK, deps({ resolve: async () => [] }))).ok).toBe(false);
    expect((await resolveCimdClient(URL_OK, deps({ resolve: async () => { throw new Error('ENOTFOUND'); } }))).ok).toBe(false);
  });

  it('refuses a non-200, a non-JSON content type, and unparseable JSON', async () => {
    expect((await resolveCimdClient(URL_OK, deps({
      fetchDoc: async () => ({ status: 404, contentType: 'application/json', body: '{}' }),
    }))).ok).toBe(false);
    expect((await resolveCimdClient(URL_OK, deps({
      fetchDoc: async () => ({ status: 200, contentType: 'text/html', body: JSON.stringify(doc()) }),
    }))).ok).toBe(false);
    expect((await resolveCimdClient(URL_OK, deps({
      fetchDoc: async () => ({ status: 200, contentType: 'application/json', body: '<html>' }),
    }))).ok).toBe(false);
  });

  it('accepts a JSON media-type suffix', async () => {
    const r = await resolveCimdClient(URL_OK, deps({
      fetchDoc: async () => ({ status: 200, contentType: 'application/ld+json; charset=utf-8', body: JSON.stringify(doc()) }),
    }));
    expect(r.ok).toBe(true);
  });

  it('turns a thrown fetch into a reason, never an exception', async () => {
    // The caller answers invalid_client on a refusal; if this threw, an authorize
    // request would 500 and the client would be told nothing useful.
    const r = await resolveCimdClient(URL_OK, deps({
      fetchDoc: async () => { throw new Error('socket hang up'); },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not fetch/);
  });

  it('never fetches a URL that failed validation', async () => {
    let fetched = false;
    const r = await resolveCimdClient('http://169.254.169.254/latest/', deps({
      fetchDoc: async () => { fetched = true; return { status: 200, contentType: 'application/json', body: '{}' }; },
    }));
    expect(r.ok).toBe(false);
    expect(fetched, 'a rejected URL must not be fetched').toBe(false);
  });
});
