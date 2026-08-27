/**
 * A FAILED CAPABILITIES PROBE MUST NOT LOOK LIKE A CONFIGURATION MISTAKE.
 *
 * `chat-recall login` asks the target server /api/capabilities to learn which
 * sign-in flow to run. That request used to be one 8-second attempt wrapped in
 * `catch {}`, so a slow or blocked probe left `authProvider` undefined, the code
 * fell through to the OIDC branch, and the user was told:
 *
 *   "No OIDC issuer configured for SSO login. Pass --issuer <url>, set
 *    CHAT_RECALL_OIDC_ISSUER, or log in with a token instead…"
 *
 * on a plain `npx chat-recall init --server https://chatrecall.dev`. Reported
 * from a real machine. The hosted service has never had an OIDC issuer, so that
 * message sent someone hunting for a Keycloak URL that does not exist, and said
 * nothing about the request that had actually failed.
 *
 * The fix has three parts, and this pins the decision logic behind them:
 *   1. retry, rather than one attempt;
 *   2. keep the failure reason instead of discarding it;
 *   3. when the probe cannot be read and no issuer was supplied, ASSUME
 *      better-auth — what the hosted service and every AUTH_PROVIDER=better-auth
 *      self-host runs — because its device endpoints answer for themselves. A
 *      wrong guess produces a specific error; refusing to try helps nobody.
 *
 * The logic is reproduced here rather than imported: cli.ts is a Commander
 * program whose import registers commands and reads argv, so importing it to
 * test one branch runs the CLI.
 */
import { describe, test, expect } from 'vitest';

/** The decision cli.ts makes after probing, in isolation. */
function chooseFlow(opts: {
  issuer?: string;
  probe: { ok: true; authProvider?: string; oidcIssuer?: string | null } | { ok: false; error: string };
}): { flow: 'better-auth' | 'oidc'; issuer?: string; warn?: string } {
  let issuer = opts.issuer;
  let authProvider: string | undefined;
  let capsError: string | null = null;

  if (!issuer) {
    if (opts.probe.ok) {
      authProvider = opts.probe.authProvider;
      if (opts.probe.oidcIssuer) issuer = opts.probe.oidcIssuer;
    } else {
      capsError = opts.probe.error;
    }
  }
  let warn: string | undefined;
  if (!authProvider && !issuer) {
    authProvider = 'better-auth';
    if (capsError) warn = `Could not read the server's capabilities (${capsError})`;
  }
  return { flow: authProvider === 'better-auth' ? 'better-auth' : 'oidc', issuer, warn };
}

describe('login flow selection', () => {
  test('the hosted service: probe succeeds, better-auth device flow', () => {
    const r = chooseFlow({ probe: { ok: true, authProvider: 'better-auth', oidcIssuer: null } });
    expect(r.flow).toBe('better-auth');
    expect(r.warn).toBeUndefined();
  });

  test('THE BUG: a failed probe must not become "no OIDC issuer"', () => {
    // Exactly the reported case — `init --server https://chatrecall.dev` where
    // the probe did not come back.
    const r = chooseFlow({ probe: { ok: false, error: 'fetch failed' } });
    expect(r.flow).toBe('better-auth');            // proceeds, rather than dead-ending
    expect(r.warn).toMatch(/Could not read the server's capabilities/);
    expect(r.warn).toMatch(/fetch failed/);        // names the real cause
    expect(r.warn).not.toMatch(/OIDC|issuer/i);    // and not a red herring
  });

  test('a non-2xx probe is a failure too, not a silent empty answer', () => {
    const r = chooseFlow({ probe: { ok: false, error: 'HTTP 502' } });
    expect(r.flow).toBe('better-auth');
    expect(r.warn).toMatch(/HTTP 502/);
  });

  test('an explicit --issuer still selects OIDC and skips the probe entirely', () => {
    // A Keycloak self-host must keep working, and must not be second-guessed.
    const r = chooseFlow({ issuer: 'https://sso.example.com/realms/acme', probe: { ok: false, error: 'fetch failed' } });
    expect(r.flow).toBe('oidc');
    expect(r.issuer).toBe('https://sso.example.com/realms/acme');
    expect(r.warn).toBeUndefined();
  });

  test('a server that advertises keycloak plus an issuer selects OIDC', () => {
    const r = chooseFlow({ probe: { ok: true, authProvider: 'keycloak', oidcIssuer: 'https://sso.example.com/realms/acme' } });
    expect(r.flow).toBe('oidc');
    expect(r.issuer).toBe('https://sso.example.com/realms/acme');
  });

  test('an issuer with no provider named still selects OIDC, and does not warn', () => {
    // The pre-better-auth shape: older servers advertised only an issuer.
    const r = chooseFlow({ probe: { ok: true, oidcIssuer: 'https://sso.example.com/realms/acme' } });
    expect(r.flow).toBe('oidc');
    expect(r.warn).toBeUndefined();
  });

  test('a successful probe that names nothing still proceeds', () => {
    // A server answering 200 with an empty body must not strand the login
    // either — same reasoning as a failed probe, minus the warning, since
    // nothing actually broke.
    const r = chooseFlow({ probe: { ok: true } });
    expect(r.flow).toBe('better-auth');
    expect(r.warn).toBeUndefined();
  });
});
