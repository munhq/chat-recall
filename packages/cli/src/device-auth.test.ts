/**
 * Device-flow wire format (RFC 8628). The grant_type URN is easy to get
 * subtly wrong — a truncated 'urn:ietf:params:oauth:device_code' made
 * Keycloak reject every token poll with unsupported_grant_type, breaking
 * `chat-recall login` for every new user (found live 2026-07-03). These
 * tests pin the exact strings the spec requires.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { deviceLogin } from './device-auth.js';

afterEach(() => vi.unstubAllGlobals());

function mockKeycloak(): { polls: URLSearchParams[] } {
  const polls: URLSearchParams[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/auth/device')) {
      return new Response(JSON.stringify({
        device_code: 'dc_123', user_code: 'ABCD-EFGH',
        verification_uri: 'https://kc.example/device', expires_in: 60, interval: 0,
      }), { status: 200 });
    }
    const body = new URLSearchParams(String(init?.body));
    polls.push(body);
    return new Response(JSON.stringify({ access_token: 'at_x', expires_in: 300 }), { status: 200 });
  }));
  return { polls };
}

describe('deviceLogin wire format', () => {
  test('token poll carries the exact RFC 8628 grant_type URN + PKCE verifier', async () => {
    const { polls } = mockKeycloak();
    const tokens = await deviceLogin({ issuer: 'https://kc.example/realms/r' }, () => {});
    expect(tokens.accessToken).toBe('at_x');
    expect(polls.length).toBe(1);
    // THE bug: 'grant-type' is part of the URN — a truncated value is
    // unsupported_grant_type to Keycloak.
    expect(polls[0].get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(polls[0].get('device_code')).toBe('dc_123');
    expect(polls[0].get('code_verifier')).toBeTruthy();
  });
});
