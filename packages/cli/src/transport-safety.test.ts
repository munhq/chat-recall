/**
 * The rule that decides whether transcripts may cross a wire in cleartext.
 *
 * TLS to the hosted service was never in doubt, but nothing REQUIRED it: a user
 * who typed `chat-recall login http://recall.mycompany.com` shipped every
 * transcript on the machine over the open internet with no warning. The sync
 * body carries whole conversations — source, file paths, and whatever the
 * redactor did not recognise as a secret — so this is the highest-value payload
 * the product ever sends.
 *
 * Two properties matter and both are tested: a public host over plain HTTP is
 * REFUSED, and a self-hoster on their own network is not inconvenienced.
 */
import { describe, test, expect } from 'vitest';
import { isPrivateHost, transportRisk, assertTransportSafe, insecureHttpAllowed } from './transport-safety.js';

describe('https is required for anything reachable from the internet', () => {
  test.each([
    'http://recall.mycompany.com',
    'http://example.com:8085',
    'http://203.0.113.10',
    'http://8.8.8.8:3000',
  ])('refuses %s', (url) => {
    const risk = transportRisk(url, {});
    expect(risk).toBeTruthy();
    expect(risk).toContain('plain HTTP');
    // The message has to tell them what to do, not just what went wrong.
    expect(risk).toContain('https://');
    expect(() => assertTransportSafe(url, {})).toThrow(/plain HTTP/);
  });

  test.each([
    'https://chatrecall.dev',
    'https://recall.mycompany.com:8443',
  ])('allows %s', (url) => {
    expect(transportRisk(url, {})).toBeNull();
  });

  test('a scheme that is neither http nor https is refused by name', () => {
    expect(transportRisk('ftp://files.example.com', {})).toContain('unsupported scheme');
  });

  test('a malformed URL is refused rather than silently passed', () => {
    expect(transportRisk('not a url', {})).toContain('not a valid server URL');
  });
});

describe('a self-hoster on their own network is untouched', () => {
  // Plain HTTP is fine to a host nobody else can reach, and that is the ONLY
  // exception. Each of these has no public path to intercept.
  test.each([
    'http://localhost:5000',
    'http://127.0.0.1:8085',
    'http://0.0.0.0:8085',
    'http://recall.local',
    'http://box.lan:8085',
    'http://recall.internal',
    'http://10.1.2.3:8085',
    'http://192.168.68.63:8085',
    'http://172.16.5.4',
    'http://172.31.255.1',
    'http://100.101.102.103:8085',   // Tailscale CGNAT
  ])('allows %s', (url) => {
    expect(isPrivateHost(url)).toBe(true);
    expect(transportRisk(url, {})).toBeNull();
  });

  // 172.15 and 172.32 are OUTSIDE 172.16/12 — an off-by-one here would either
  // block a real private host or, worse, wave a public one through.
  test.each(['http://172.15.0.1', 'http://172.32.0.1', 'http://100.63.0.1', 'http://100.128.0.1'])(
    'does NOT treat %s as private',
    (url) => {
      expect(isPrivateHost(url)).toBe(false);
      expect(transportRisk(url, {})).toBeTruthy();
    },
  );
});

describe('the VPN override', () => {
  // The real case this exists for: a corporate host whose name and address both
  // look public but is only reachable through a tunnel.
  test('an explicit opt-in allows a public host over plain HTTP', () => {
    const url = 'http://recall.corp.example.com';
    expect(transportRisk(url, {})).toBeTruthy();
    for (const v of ['1', 'true', 'yes', 'TRUE']) {
      expect(transportRisk(url, { CHAT_RECALL_ALLOW_INSECURE_HTTP: v })).toBeNull();
    }
  });

  test('anything else is not an opt-in — including the values that look like one', () => {
    for (const v of ['0', 'false', 'no', '', 'maybe']) {
      expect(insecureHttpAllowed({ CHAT_RECALL_ALLOW_INSECURE_HTTP: v })).toBe(false);
    }
    expect(insecureHttpAllowed({})).toBe(false);
  });

  test('the override cannot rescue an https-less scheme or a broken URL', () => {
    const env = { CHAT_RECALL_ALLOW_INSECURE_HTTP: '1' };
    expect(transportRisk('ftp://x.example.com', env)).toContain('unsupported scheme');
    expect(transportRisk('::::', env)).toContain('not a valid server URL');
  });
});
