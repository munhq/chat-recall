/**
 * What is actually wrong with a configured server URL.
 *
 * THE FAILURE THIS EXISTS TO END. `doctor` used to do:
 *
 *     fetch(`${base}/api/capabilities`).then((r) => r.json())
 *
 * with no `r.ok` check, inside one try/catch. A host that had been renamed
 * away served an HTML 404 page, `.json()` choked on `<!DO`, and the user was
 * told:
 *
 *     ✗ Server reachable   unreachable: Unexpected non-whitespace character
 *                          after JSON at position 4
 *
 * Three different problems with three different fixes — a stale token, a moved
 * server, a server that is down — all arrived as that one sentence. And the
 * "Logged in" row above it printed a green tick, because it only checked that
 * credentials.json had an entry.
 *
 * So: classify, then advise. Every branch names the URL and the command that
 * fixes it.
 */

export type ProbeResult =
  /** Spoke to a chat-recall server and understood the answer. */
  | { kind: 'ok'; apiVersion: number; edition?: string; cliVersion?: string }
  /** Reached an HTTP server, but nothing is mounted here. Usually a moved host. */
  | { kind: 'moved'; status: number }
  /** The server is there and refused the credential. */
  | { kind: 'unauthorized'; status: number }
  /** The server is there and broken. */
  | { kind: 'server_error'; status: number }
  /** 2xx, but not a chat-recall API — a proxy, a captive portal, a parked domain. */
  | { kind: 'not_api'; status: number; snippet: string }
  /** Never got an HTTP response at all: DNS, TLS, connection, timeout. */
  | { kind: 'unreachable'; error: string };

/** True when the probe proves a usable chat-recall server. */
export function probeOk(r: ProbeResult): r is Extract<ProbeResult, { kind: 'ok' }> {
  return r.kind === 'ok' && r.apiVersion >= 2;
}

/**
 * Probe `<base>/api/capabilities`, which is unauthenticated and cheap.
 *
 * `fetchImpl` is injectable so the classification is testable without a server —
 * the whole point of this module is behaviour on responses that are hard to
 * produce on demand (an HTML 404, a parked domain, a 502).
 */
export async function probeServer(
  base: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ProbeResult> {
  const f = opts.fetchImpl || fetch;
  let res: Response;
  try {
    res = await f(`${base.replace(/\/+$/, '')}/api/capabilities`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    return { kind: 'unreachable', error: err instanceof Error ? err.message : String(err) };
  }

  if (res.status === 401 || res.status === 403) return { kind: 'unauthorized', status: res.status };
  // 404 and 410 mean "this URL serves HTTP but not us". 404 is what a renamed
  // host, a parked domain or a wrong path all produce.
  if (res.status === 404 || res.status === 410) return { kind: 'moved', status: res.status };
  if (res.status >= 500) return { kind: 'server_error', status: res.status };
  if (!res.ok) return { kind: 'moved', status: res.status };

  // 2xx. Read as TEXT first: .json() on an HTML body throws a parse error that
  // says nothing about the actual problem, which is how this bug shipped.
  let body: string;
  try { body = await res.text(); } catch (err) {
    return { kind: 'unreachable', error: err instanceof Error ? err.message : String(err) };
  }
  let parsed: { apiVersion?: number; edition?: string; cli?: { version?: string } | null };
  try { parsed = JSON.parse(body); } catch {
    return { kind: 'not_api', status: res.status, snippet: body.trim().slice(0, 60) };
  }
  if (typeof parsed?.apiVersion !== 'number') {
    return { kind: 'not_api', status: res.status, snippet: body.trim().slice(0, 60) };
  }
  return {
    kind: 'ok',
    apiVersion: parsed.apiVersion,
    edition: parsed.edition,
    cliVersion: parsed.cli?.version,
  };
}

/**
 * One line the user can act on. Never a stack trace, always the next command.
 */
export function probeAdvice(r: ProbeResult, base: string): string {
  switch (r.kind) {
    case 'ok':
      return r.apiVersion >= 2
        ? `apiVersion ${r.apiVersion}${r.edition ? `, edition ${r.edition}` : ''}`
        : `apiVersion ${r.apiVersion} is too old for this CLI — upgrade the server`;
    case 'moved':
      // The case that produced the parse error. Say what it means.
      return `HTTP ${r.status} — nothing is served at ${base}. If the host moved, `
        + 're-point it: `chat-recall login <new-server-url>`';
    case 'unauthorized':
      return `HTTP ${r.status} — ${base} rejected the credential. Re-login: `
        + '`chat-recall login ' + base + '`';
    case 'server_error':
      return `HTTP ${r.status} — ${base} is up but failing. Nothing to fix locally; check the server.`;
    case 'not_api':
      return `${base} answered ${r.status} with something that is not the chat-recall API `
        + `(${JSON.stringify(r.snippet)}) — check the URL, a proxy or a captive portal`;
    case 'unreachable':
      return `no HTTP response from ${base} (${r.error}) — check the URL, DNS, or that the server is running`;
  }
}
