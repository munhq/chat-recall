/**
 * The connector flow's one-way door: if the authorize request is not carried
 * across sign-in, the client that sent the user waits for a code forever and
 * nothing anywhere reports an error. These are the cases a browser cannot
 * produce on demand.
 */
import { describe, it, expect } from 'vitest';
import {
  pendingAuthorizeQuery,
  authorizeResumeUrl,
  postAuthorizeSignInPath,
  AUTHORIZE_ENDPOINT,
} from './oauth-resume';

/** A realistic authorize query, as better-auth forwards it to the login page. */
const REAL =
  '?response_type=code&client_id=abc123'
  + '&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fcallback'
  + '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  + '&code_challenge_method=S256&scope=openid+profile+email+offline_access'
  + '&state=xyz789&resource=https%3A%2F%2Fexample.com%2Fmcp';

describe('pendingAuthorizeQuery', () => {
  it('recognises a real authorize request and keeps every OAuth parameter', () => {
    const q = pendingAuthorizeQuery(REAL);
    expect(q).not.toBeNull();
    const p = new URLSearchParams(q!);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('abc123');
    expect(p.get('redirect_uri')).toBe('https://claude.ai/api/mcp/callback');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toBe('xyz789');
    // Dropping the challenge would make the token exchange fail at the very
    // last step, which is the hardest place to diagnose it from.
    expect(p.get('code_challenge')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(p.get('scope')).toBe('openid profile email offline_access');
  });

  it('is null for an ordinary visitor', () => {
    expect(pendingAuthorizeQuery('')).toBeNull();
    expect(pendingAuthorizeQuery('?view=account')).toBeNull();
  });

  it('needs BOTH client_id and response_type=code', () => {
    // A share link with a stray state or scope must reach the dashboard, not an
    // OAuth error page.
    expect(pendingAuthorizeQuery('?state=abc&scope=openid')).toBeNull();
    expect(pendingAuthorizeQuery('?client_id=abc123')).toBeNull();
    expect(pendingAuthorizeQuery('?response_type=code')).toBeNull();
    expect(pendingAuthorizeQuery('?client_id=abc123&response_type=token')).toBeNull();
  });

  it('forwards no parameter that is not part of the flow', () => {
    const q = pendingAuthorizeQuery(
      '?response_type=code&client_id=abc123&utm_source=x&next=%2Fetc%2Fpasswd&admin=1');
    const p = new URLSearchParams(q!);
    expect(p.get('utm_source')).toBeNull();
    expect(p.get('next')).toBeNull();
    expect(p.get('admin')).toBeNull();
    expect(p.get('client_id')).toBe('abc123');
  });

  it('treats an empty value as absent rather than sending a blank parameter', () => {
    const q = pendingAuthorizeQuery('?response_type=code&client_id=abc123&state=');
    expect(new URLSearchParams(q!).has('state')).toBe(false);
  });
});

describe('authorizeResumeUrl', () => {
  it('replays the request against our own authorize endpoint', () => {
    const url = authorizeResumeUrl(REAL)!;
    expect(url.startsWith(`${AUTHORIZE_ENDPOINT}?`)).toBe(true);
    // Same-origin path, never an absolute URL built from the query: redirect_uri
    // is the client's, and the browser must not be sent to it from here.
    expect(url).not.toMatch(/^https?:\/\//);
    expect(new URLSearchParams(url.split('?')[1]).get('client_id')).toBe('abc123');
  });

  it('is null when nothing is pending', () => {
    expect(authorizeResumeUrl('?view=account')).toBeNull();
  });
});

describe('postAuthorizeSignInPath', () => {
  it('carries the request through the IdP round trip', () => {
    // The bug this exists for: callbackURL was '/app', so a Google sign-in came
    // back with the query gone and the flow could not be resumed at all.
    const path = postAuthorizeSignInPath(REAL)!;
    expect(path.startsWith('/app?')).toBe(true);
    const p = new URLSearchParams(path.split('?')[1]);
    expect(p.get('client_id')).toBe('abc123');
    expect(p.get('code_challenge')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is null for a normal sign-in, so the usual landing still applies', () => {
    expect(postAuthorizeSignInPath('')).toBeNull();
  });
});
