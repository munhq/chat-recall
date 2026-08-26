/**
 * CLIENT ID METADATA DOCUMENTS — a client_id that IS a URL.
 *
 * Two ways an OAuth client can become known to us:
 *
 *   DCR (RFC 7591)  the client POSTs /api/auth/mcp/register, we mint a random
 *                   client_id and store it. claude.ai does this. It works.
 *   CIMD            the client_id is an https URL. Nobody registers anything;
 *                   the authorization server FETCHES that URL and reads the
 *                   client's metadata out of it.
 *
 * better-auth implements the first and not the second, so an authorize request
 * carrying a URL client_id was rejected with `invalid_client` — verified against
 * a real server, DCR issuing a code and CIMD refused side by side. That closed
 * the door on Smithery, whose publishing flow says in as many words: "No client
 * registration needed. Smithery handles client registration automatically via
 * Client ID Metadata Documents." A registry that never registers cannot reach a
 * server that requires registration.
 *
 * WHAT THIS DOES. It resolves a URL client_id into the same stored client row
 * that DCR would have created, then gets out of the way: better-auth validates
 * redirect_uri, PKCE, consent and the token exchange exactly as it already does
 * for a registered client. The new surface is one fetch and one insert, not a
 * second authorization path — a parallel path is how the two disagree later.
 *
 * WHY THE PARANOIA BELOW. The client_id is attacker-controlled and we fetch it
 * server-side, which is a textbook SSRF: `client_id=https://169.254.169.254/…`
 * would have us read a cloud metadata endpoint and, worse, cache what came back
 * as a client. So the guards are not garnish:
 *
 *   - https only, no credentials, no fragment, default port only
 *   - every resolved address checked against private / loopback / link-local /
 *     CGNAT / multicast ranges, over BOTH families, AFTER DNS resolution
 *     (a public name can resolve to 127.0.0.1 — that is the whole trick)
 *   - redirects NEVER followed: a permitted host can 302 to an internal one
 *   - hard timeout, hard byte cap, JSON content-type required
 *   - the document must name itself: doc.client_id === the URL we fetched
 *
 * The pure functions are exported and injected so the interesting cases — the
 * ones an attacker sends, which a live server will not produce on request — are
 * reachable from a unit test.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** How long a resolved (or rejected) document stays good for. */
export const CIMD_CACHE_MS = 10 * 60 * 1000;
/** A metadata document is small. Anything larger is not one. */
export const CIMD_MAX_BYTES = 64 * 1024;
export const CIMD_TIMEOUT_MS = 5_000;

/** Does this client_id ask for CIMD resolution at all? */
export function isCimdClientId(clientId: string | undefined | null): boolean {
  if (!clientId) return false;
  return clientId.startsWith('https://');
}

/**
 * Reject an address we must never fetch from.
 *
 * Checked after DNS resolution, because the name is not the target — the address
 * is. `internal.example.com` resolving to 10.0.0.5 is the normal shape of this
 * attack, and a hostname allowlist cannot see it.
 */
export function isBlockedAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const p = addr.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true;                        // "this network"
    if (a === 10) return true;                       // private
    if (a === 127) return true;                      // loopback
    if (a === 169 && b === 254) return true;         // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;// private
    if (a === 192 && b === 168) return true;         // private
    if (a === 100 && b >= 64 && b <= 127) return true;// CGNAT
    if (a === 192 && b === 0) return true;           // protocol assignments / test
    if (a >= 224) return true;                       // multicast + reserved + broadcast
    return false;
  }
  if (v === 6) {
    const a = addr.toLowerCase();
    if (a === '::' || a === '::1') return true;      // unspecified, loopback
    if (a.startsWith('fe80')) return true;           // link-local
    if (a.startsWith('fc') || a.startsWith('fd')) return true;  // unique-local
    if (a.startsWith('ff')) return true;             // multicast
    // ::ffff:127.0.0.1 and friends — an IPv4 loopback wearing an IPv6 coat.
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (m) return isBlockedAddress(m[1]);
    return false;
  }
  return true;   // not an address we can reason about
}

/** The URL itself must be safe before we ever look up its name. */
export function validateCimdUrl(clientId: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try { url = new URL(clientId); } catch { return { ok: false, reason: 'client_id is not a URL' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: 'client_id must be https' };
  if (url.username || url.password) return { ok: false, reason: 'client_id must not carry credentials' };
  if (url.hash) return { ok: false, reason: 'client_id must not carry a fragment' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'client_id must use the default https port' };
  // A bare IP as the client_id is never a published metadata document, and
  // allowing it removes the DNS check's whole purpose.
  if (isIP(url.hostname)) return { ok: false, reason: 'client_id must name a host, not an address' };
  return { ok: true, url };
}

/** The subset of client metadata we act on. */
export interface CimdClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  isPublic: boolean;
}

/**
 * Validate a fetched document against the URL it came from.
 *
 * `client_id` must equal that URL. Without this check, any page that happens to
 * serve JSON with a `redirect_uris` array becomes a usable client — an open
 * redirector assembled out of somebody else's uploads.
 */
export function validateCimdDocument(url: string, doc: unknown): { ok: true; client: CimdClient } | { ok: false; reason: string } {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'document is not a JSON object' };
  const d = doc as Record<string, unknown>;

  if (typeof d.client_id !== 'string') return { ok: false, reason: 'document has no client_id' };
  if (d.client_id !== url) return { ok: false, reason: 'document client_id does not match its own URL' };

  const uris = d.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return { ok: false, reason: 'document lists no redirect_uris' };
  if (uris.length > 20) return { ok: false, reason: 'document lists too many redirect_uris' };
  const redirectUris: string[] = [];
  for (const u of uris) {
    if (typeof u !== 'string') return { ok: false, reason: 'redirect_uris contains a non-string' };
    let r: URL;
    try { r = new URL(u); } catch { return { ok: false, reason: `redirect_uri is not a URL: ${u.slice(0, 60)}` }; }
    // https, or loopback for a client running on the user's own machine — the
    // two cases the MCP clients in the wild actually use. No other scheme: a
    // custom scheme here is how a redirect leaves the browser entirely.
    const loopback = r.protocol === 'http:' && (r.hostname === '127.0.0.1' || r.hostname === 'localhost' || r.hostname === '[::1]');
    if (r.protocol !== 'https:' && !loopback) return { ok: false, reason: `redirect_uri must be https or loopback: ${u.slice(0, 60)}` };
    redirectUris.push(r.toString());
  }

  // A CIMD client cannot hold a secret — it published its own identity, so
  // anyone can claim it. Public + PKCE is the only sound reading, and storing it
  // as confidential would mean minting a secret nobody asked for.
  const authMethod = typeof d.token_endpoint_auth_method === 'string' ? d.token_endpoint_auth_method : 'none';
  if (authMethod !== 'none') return { ok: false, reason: 'a CIMD client must be public (token_endpoint_auth_method=none)' };

  if (Array.isArray(d.grant_types) && !d.grant_types.includes('authorization_code')) {
    return { ok: false, reason: 'document does not request the authorization_code grant' };
  }
  if (Array.isArray(d.response_types) && !d.response_types.includes('code')) {
    return { ok: false, reason: 'document does not request the code response type' };
  }

  const name = typeof d.client_name === 'string' && d.client_name.trim()
    ? d.client_name.trim().slice(0, 120)
    : new URL(url).hostname;

  return { ok: true, client: { clientId: url, clientName: name, redirectUris, isPublic: true } };
}

export interface CimdDeps {
  /** Resolve a hostname to addresses. Injected so the SSRF path is testable. */
  resolve: (hostname: string) => Promise<string[]>;
  /** Fetch the document. Must not follow redirects. */
  fetchDoc: (url: string) => Promise<{ status: number; contentType: string; body: string }>;
}

export const defaultCimdDeps: CimdDeps = {
  resolve: async (hostname) => {
    const rs = await lookup(hostname, { all: true, verbatim: true });
    return rs.map((r) => r.address);
  },
  fetchDoc: async (url) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CIMD_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        // A permitted host that 302s to an internal one defeats every check
        // above, so the redirect is an error rather than a hop.
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: ctl.signal,
      });
      // Read with a cap rather than res.json(): an unbounded body is a memory
      // denial-of-service that costs the caller one header.
      const reader = res.body?.getReader();
      let body = '';
      if (reader) {
        const dec = new TextDecoder();
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > CIMD_MAX_BYTES) { await reader.cancel(); throw new Error('document exceeds the size cap'); }
          body += dec.decode(value, { stream: true });
        }
      }
      return { status: res.status, contentType: res.headers.get('content-type') || '', body };
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * Resolve a URL client_id into a client we can store, or a reason we will not.
 *
 * Never throws: every failure is a reason, because the caller turns it into an
 * `invalid_client` the client can read rather than a 500 it cannot.
 */
export async function resolveCimdClient(
  clientId: string,
  deps: CimdDeps = defaultCimdDeps,
): Promise<{ ok: true; client: CimdClient } | { ok: false; reason: string }> {
  const v = validateCimdUrl(clientId);
  if (!v.ok) return v;

  let addrs: string[];
  try { addrs = await deps.resolve(v.url.hostname); }
  catch { return { ok: false, reason: 'client_id host does not resolve' }; }
  if (!addrs.length) return { ok: false, reason: 'client_id host does not resolve' };
  // EVERY address, not the first: a name with one public and one private A
  // record would otherwise pass on a lucky ordering.
  for (const a of addrs) {
    if (isBlockedAddress(a)) return { ok: false, reason: 'client_id host resolves to a non-public address' };
  }

  let res: { status: number; contentType: string; body: string };
  try { res = await deps.fetchDoc(v.url.toString()); }
  catch (err) { return { ok: false, reason: `could not fetch the document (${err instanceof Error ? err.message : 'request failed'})` }; }
  if (res.status !== 200) return { ok: false, reason: `document responded ${res.status}` };
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(res.contentType)) {
    return { ok: false, reason: 'document is not served as JSON' };
  }
  let doc: unknown;
  try { doc = JSON.parse(res.body); } catch { return { ok: false, reason: 'document is not valid JSON' }; }

  return validateCimdDocument(v.url.toString(), doc);
}
