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
  /** No HTTP response at all. `reason` names WHY — the thing `fetch failed`
   *  refuses to tell you — and `error` keeps the raw string for a report. */
  | { kind: 'unreachable'; error: string; reason: UnreachableReason };

/** Why a request never got an answer. Node's fetch reports every one of these as
 *  the same five characters, "fetch failed", with the real code hidden in
 *  `err.cause`. A user pasting that string leaves nothing to diagnose — which is
 *  exactly what happened on a macOS install: the message named SSO, the cause
 *  was the network, and nobody could tell which. */
export type UnreachableReason =
  | 'dns'        // ENOTFOUND / EAI_AGAIN — the name does not resolve
  | 'refused'    // ECONNREFUSED — resolves, nothing listening
  | 'tls'        // certificate rejected: expired, self-signed, wrong host
  | 'timeout'    // no answer in time; a silent drop looks like this
  | 'reset'      // ECONNRESET / EPIPE — connection cut mid-flight
  | 'unknown';   // classified as such rather than guessed at

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
    return {
      kind: 'unreachable',
      error: describeCause(err),
      reason: classifyUnreachable(err),
    };
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
    return { kind: 'unreachable', error: describeCause(err), reason: classifyUnreachable(err) };
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
      // One sentence per cause, each naming the fix rather than the error.
      switch (r.reason) {
        case 'dns':
          return `cannot resolve the host in ${base} (${r.error}) — check the URL for a typo, `
            + 'and your DNS or VPN';
        case 'refused':
          return `${base} resolves but refused the connection (${r.error}) — the server is not `
            + 'running, or the port is wrong';
        case 'tls':
          return `the TLS certificate at ${base} was rejected (${r.error}) — expired, self-signed, `
            + 'or issued for another host. A corporate proxy that re-signs traffic does this.';
        case 'timeout':
          return `${base} did not answer in time (${r.error}) — a firewall or proxy that drops `
            + 'traffic silently looks exactly like this';
        case 'reset':
          return `the connection to ${base} was cut (${r.error}) — often a proxy or a captive portal`;
        default:
          return `no HTTP response from ${base} (${r.error}) — check the URL, DNS, or that the `
            + 'server is running';
      }
  }
}

/**
 * Dig the real code out of a fetch failure.
 *
 * `err.message` on a failed `fetch` is the constant string "fetch failed" for
 * every network cause there is. undici puts the truth in `err.cause`, one or two
 * levels down, as a Node error code. Walk the chain and classify.
 */
export function classifyUnreachable(err: unknown): UnreachableReason {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const code = String((e as { code?: unknown }).code ?? '');
    const msg = String((e as { message?: unknown }).message ?? '');
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
    if (code === 'ECONNREFUSED') return 'refused';
    if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return 'timeout';
    // TLS codes are many and all start the same way, plus the self-signed pair.
    if (code.startsWith('CERT_') || code.startsWith('ERR_TLS')
      || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN'
      || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || /certificate/i.test(msg)) return 'tls';
    e = (e as { cause?: unknown }).cause;
  }
  return 'unknown';
}

/** The most specific string available: the underlying code where there is one,
 *  because "fetch failed" is worth nothing in a bug report. */
export function describeCause(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && code && !parts.includes(code)) parts.push(code);
    e = (e as { cause?: unknown }).cause;
  }
  const base = err instanceof Error ? err.message : String(err);
  return parts.length ? `${base}: ${parts.join(' → ')}` : base;
}
