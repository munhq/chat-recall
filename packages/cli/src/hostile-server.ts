/**
 * Servers that answer BADLY, on demand, so CI can meet them before a user does.
 *
 * Every install bug found on 2026-08-27 was found by a person running a command
 * on a laptop, because the test suite only ever pointed the CLI at a healthy
 * server or at nothing:
 *
 *   - a failed capabilities probe reported "No OIDC issuer configured for SSO
 *     login" on a service that has never used SSO;
 *   - that failure called process.exit(1), so `init` died before configuring MCP;
 *   - a retired hostname answered `404 page not found` in text/plain, and the
 *     sync client called .json() on it, so the user was shown "Unexpected
 *     non-whitespace character after JSON at position 4".
 *
 * None of those need a network to reproduce. They need a server that responds
 * the way real infrastructure does when something is wrong — which is what this
 * is. Each mode is one line of behaviour, deliberately: the point is to be
 * obviously correct, not configurable.
 */
import { createServer, type Server } from 'node:http';

export type HostileMode =
  /** A retired route behind Traefik/nginx: plain text, HTTP 404. THE one that
   *  produced the JSON parse error, because `404 page not found` parses as the
   *  number 404 and then fails at position 4. */
  | 'text404'
  /** A parked domain or a login wall: HTML with a 200. */
  | 'html200'
  /** An upstream that is up but broken. */
  | 'gateway502'
  /** Authenticated but forbidden — a revoked device token looks like this. */
  | 'forbidden403'
  /** 200, valid JSON, but not our API: a different service on the same host. */
  | 'notOurApi'
  /** Accepts the connection and never answers. A dropped packet looks like this
   *  to the client, and it is the failure people describe as "it just hangs". */
  | 'silent';

export interface HostileServer {
  url: string;
  /** Every path the CLI actually asked for, in order. A test that only checks
   *  the printed message cannot tell "the CLI handled a 404 well" from "the CLI
   *  never sent a request" — and the first version of this harness spawned the
   *  CLI with execFileSync, which blocks the test process's event loop, so this
   *  server answered NOTHING and four assertions passed on a timeout. */
  hits: string[];
  close: () => Promise<void>;
}

/** Start one. Always on 127.0.0.1 and an ephemeral port, so tests can run in
 *  parallel and nothing is exposed. */
export async function startHostileServer(mode: HostileMode): Promise<HostileServer> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    switch (mode) {
      case 'text404':
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 page not found');
        return;
      case 'html200':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><body>Nothing here</body></html>');
        return;
      case 'gateway502':
        res.writeHead(502, { 'content-type': 'text/html' });
        res.end('<html><head><title>502 Bad Gateway</title></head></html>');
        return;
      case 'forbidden403':
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      case 'notOurApi':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ service: 'something-else', version: 9 }));
        return;
      case 'silent':
        // Deliberately no response and no close: the socket stays open until the
        // client's own timeout fires. `req` is untouched on purpose.
        void req;
        return;
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => {
      // closeAllConnections, or a 'silent' server keeps the process alive with
      // its open socket and the test run hangs at the end instead of exiting.
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/**
 * A port nothing listens on — connection refused, immediately. Distinct from
 * 'silent' (accepted then ignored) and from a name that does not resolve.
 *
 * IT HAS TO BE A REAL PORT. This returned `http://127.0.0.1:1`, and port 1 is on
 * the WHATWG "bad port" list, so undici refuses the request before it opens a
 * socket and throws a bare `Error: bad port` with no code. The test asserting
 * "a refused port says refused" was therefore never testing a refused port, and
 * it failed against a CLI whose ECONNREFUSED handling was correct all along.
 *
 * Bind an ephemeral port, read it, close it: nothing else can be listening on it
 * at that instant, and the number is one undici will actually dial.
 */
export async function refusedUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const addr = probe.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** A hostname that cannot resolve. `.invalid` is reserved by RFC 2606 exactly so
 *  a test can rely on this without depending on somebody's DNS. */
export function unresolvableUrl(): string {
  return 'https://chat-recall-does-not-exist.invalid';
}
