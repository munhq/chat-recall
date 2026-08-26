/**
 * The route manifest: every API surface, with its gates, on purpose.
 *
 * With a free tier, an ungated mount is not a style problem — it is revenue
 * or security. This test parses the SOURCE of server.ts, extracts every
 * `app.use('/path', ...)` / `app.get('/path', ...)` mount, and compares the
 * middleware on each mount against the MANIFEST below. Each entry records WHY
 * that surface has those gates.
 *
 * The test fails in both directions:
 *   1. A mount exists in server.ts but not here → a new surface shipped
 *      without a gating decision. Decide its gate, then add it with a reason.
 *   2. A manifest entry's gates no longer match the source → the gating
 *      changed. If the change is intentional, update the entry and its reason.
 *
 * Scope: mounts whose first argument is a string path. Pathless globals
 * (helmet, cors, compression, the error handler) and the regex SPA fallback
 * are not entitlement surfaces and are not tracked here.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_TS = resolve(dirname(fileURLToPath(import.meta.url)), 'server.ts');

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface Mount {
  method: string;
  path: string;
  gates: string[];
  line: number;
}

/**
 * Split the arguments of one app.<method>(...) call.
 *
 * Walks from the character after the opening paren. Tracks paren/bracket/brace
 * depth, skips string literals and comments, and splits on top-level commas.
 * This makes multi-line mounts (e.g. the /api/csp-report handler) parse the
 * same as one-line mounts.
 */
function splitArgs(src: string, openIdx: number): string[] {
  const args: string[] = [];
  let depth = 1;
  let cur = '';
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    // String literals: copy verbatim, honour backslash escapes.
    if (ch === "'" || ch === '"' || ch === '`') {
      cur += ch;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { cur += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        cur += src[i];
        if (src[i] === ch) { i++; break; }
        i++;
      }
      continue;
    }
    // Comments inside an argument (inline handlers carry them): drop the text,
    // or an apostrophe in prose desynchronises the string scanner.
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    if (depth === 1 && ch === ',') {
      args.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  args.push(cur);
  return args;
}

/**
 * Normalize one middleware argument to a stable name.
 *
 * Whitespace collapses, so formatting churn does not fail the test. An inline
 * function collapses to '<inline>' — its body is route logic, not a gate name.
 * Named middleware and calls (paid, rl('read-heavy'), express.json({...}))
 * keep their exact text, because that text IS the gating decision.
 */
function normalizeGate(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (/=>/.test(flat) || /^(async[\s(])|^function\b/.test(flat)) return '<inline>';
  return flat;
}

function extractMounts(src: string): Mount[] {
  const mounts: Mount[] = [];
  const re = /\bapp\.(use|get|post|put|delete|patch|all)\(\s*(['"])(\/[^'"]*)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // Skip a match on a comment line (a commented-out mount is not a surface).
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const prefix = src.slice(lineStart, m.index).trimStart();
    if (prefix.startsWith('//') || prefix.startsWith('*')) continue;

    const openIdx = src.indexOf('(', m.index);
    const args = splitArgs(src, openIdx);
    const gates = args
      .slice(1) // args[0] is the path
      .map(normalizeGate)
      .filter((g) => g.length > 0);
    const line = src.slice(0, m.index).split('\n').length;
    mounts.push({ method: m[1], path: m[3], gates, line });
  }
  return mounts;
}

/** Aggregate repeated mounts of the same method+path into one gate list. */
function aggregate(mounts: Mount[]): Map<string, string[]> {
  const surfaces = new Map<string, string[]>();
  for (const mt of mounts) {
    const key = `${mt.method} ${mt.path}`;
    const list = surfaces.get(key) ?? [];
    list.push(...mt.gates);
    surfaces.set(key, list);
  }
  return surfaces;
}

// ---------------------------------------------------------------------------
// The manifest. Key: '<method> <path>'. gates: every middleware name that the
// mount lines for that path carry, in source order. reason: why this surface
// has exactly those gates. Comparison is order-insensitive (sorted), so a
// swap of `paid` and `rl(...)` does not fail — a changed SET of gates does.
// ---------------------------------------------------------------------------

const MANIFEST: Record<string, { gates: string[]; reason: string }> = {
  // --- pre-auth plumbing and public surfaces -------------------------------
  'use /api': {
    gates: ['costMiddleware', 'apiLimiter', 'teamsRouter', 'tenantAuth', 'attachTenantToContext'],
    reason: 'API-wide plumbing: cost telemetry, per-IP limiter, self-authenticating teams router, then tenant auth + log context; order in source is load-bearing (teams runs before tenantAuth).',
  },
  'use /api/sync': {
    gates: ['syncLimiter', "express.json({ limit: '32mb' })", 'syncRouter'],
    reason: 'Self-authenticating via the device token; its own per-IP limiter and 32mb parser bound the pre-auth work an anonymous flood can trigger.',
  },
  'use /api/code/index': {
    gates: ["express.json({ limit: '16mb' })"],
    reason: 'Body-size carve-out only: a full collector run exceeds the global 100kb parser; the /api/code gates still apply to the route itself.',
  },
  'use /metrics': {
    gates: ['metricsRouter'],
    reason: 'Prometheus scrape endpoint; mounted outside /api auth so a cluster scraper reaches it, optionally gated by METRICS_TOKEN inside the router.',
  },
  'use /': {
    gates: ['installRouter'],
    reason: 'Public install funnel (/install.sh, tarball): the first touch happens before any credential exists.',
  },
  'post /api/csp-report': {
    gates: [
      "express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' })",
      '<inline>',
    ],
    reason: 'CSP violation sink: unauthenticated by necessity (browsers send it without credentials); it only logs, with a 16kb bound and field truncation.',
  },
  'all /api/auth/*': {
    gates: ['funnelTelemetry', 'authHandler()'],
    reason: 'better-auth owns sign-in/up/out, the device flow and the MCP OAuth authorize/token/register endpoints; it IS the login, so it runs before tenantAuth and reads its own body. funnelTelemetry sits in front of it — NOT a gate, and it refuses nothing: it is the only place that can observe the steps a user FAILS at, since every growth event before it fired only after success and the CLI cannot report a login it never completed. It reads the path and the response status, never a body. Mounted via authHandler() rather than toNodeHandler(getAuth()) because the auth instance type cannot cross a module boundary — see the note on getAuth in auth/better-auth.ts.',
  },
  'get /api/auth/mcp/authorize': {
    gates: ['mcpCimdResolver()'],
    reason: 'CIMD resolution, mounted in FRONT of better-auth\'s own authorize endpoint (which still runs — this calls next()). Not a gate and not an authorization path: it resolves a client_id that is an https URL into a stored client so better-auth can validate it the same way it validates a DCR one, and returns immediately for every client_id that is not a URL. Ungated because authorize is pre-credential by definition. It is the one place that fetches an attacker-supplied URL server-side, so the SSRF guards in auth/cimd.ts (https only, post-DNS address checks, no redirects, size and time caps) are the real control here.',
  },
  'get /api/auth/mcp/jwks': {
    gates: ['<inline>'],
    reason: 'The JWK Set both discovery documents advertise (better-auth publishes jwks_uri and registers no endpoint for it, so the URL 404\'d). DELIBERATELY UNGATED, for the same reason as the two well-known documents: it is part of discovery, read before any credential exists. It returns an EMPTY key set and that is the true answer, not a stub — the MCP plugin issues opaque access tokens looked up server-side, so no signing key exists for a client to verify against. Exposes nothing: a public key would be publishable anyway, and there is not even one.',
  },
  'get /.well-known/oauth-authorization-server': {
    gates: ['oauthAuthorizationServerHandler()'],
    reason: 'RFC 8414 OAuth discovery. DELIBERATELY UNGATED and unauthenticated: a client reads this in order to find out how to authenticate, so any gate here is a deadlock. It exposes only endpoint URLs and supported grant types — no tenant data, and nothing an attacker cannot infer from the spec.',
  },
  'use /mcp': {
    gates: ['apiLimiter', "express.json({ limit: '4mb' })", 'mcpRouter'],
    reason: 'The remote MCP endpoint. DELIBERATELY OUTSIDE the /api gates: it authenticates with an OAuth access token rather than a tenant session, so tenantAuth would reject it before its own auth ran. It is not ungated — the router 401s without a valid grant, 403s a cross-origin browser request, and its tools then call back through /api over loopback, where entitlement, rate limits and RLS all apply on the way in. It carries apiLimiter explicitly because the /api mount does not cover it, and an unauthenticated endpoint that does a database lookup per request is a brute-force and DoS surface without one.',
  },
  'get /.well-known/oauth-protected-resource': {
    gates: ['oauthProtectedResourceHandler()'],
    reason: 'RFC 9728 protected-resource metadata, the first document an MCP client fetches after a 401 from /mcp. Ungated for the same reason as the authorization-server document above; it names the resource and its authorization servers, nothing tenant-scoped. Served at the ORIGIN ROOT because clients look there and never under /api/auth.',
  },
  'use /api/contact': {
    gates: ["rl('sensitive')", 'contactRouter'],
    reason: 'Enterprise enquiries: public and pre-auth (the sender has no account yet); rate-limited as sensitive because it is anonymous and sends mail.',
  },
  'use /api/licence': {
    gates: ['licenceRouter'],
    reason: 'Self-host licence activation: public and pre-auth by necessity — the serial IS the credential.',
  },
  'get /api/capabilities': {
    gates: ['<inline>'],
    reason: 'Open metadata so the client can pick views and login flow before auth; skipped by the apiLimiter as a cheap probe.',
  },
  'use /api/team': {
    gates: ['teamArtifactsRouter'],
    reason: 'Toolkit library (team-client.ts contract): self-authenticating like /api/sync, so it mounts before tenantAuth.',
  },
  'use /api/billing': {
    gates: ['billingRouter'],
    reason: 'Self-authenticating: /checkout verifies the user, the webhook verifies a Stripe signature; must stay reachable so a lapsed tenant can pay.',
  },
  'use /api/admin': {
    gates: ['adminRouter'],
    reason: 'Cross-tenant operator surface, self-authenticating via realm role or ADMIN_KEY; it must not run inside one tenant’s RLS context.',
  },

  // --- tenant-scoped, ungated (deliberate) ---------------------------------
  'use /api/teams/security-config': {
    gates: ['securityConfigRouter'],
    reason: 'Read by the sync collector; part of the sync/config plane, not the paid value surface.',
  },
  'use /api/sync-config': {
    gates: ['syncConfigRouter'],
    reason: 'Sync configuration must be reachable for the collector to run at all; not the paid value surface.',
  },
  'use /api/client-events': {
    gates: ['clientEventsRouter'],
    reason: 'Client telemetry ingestion; gating it would only blind us to a lapsed or free tenant’s errors.',
  },
  'use /api/ledgers': {
    gates: ['ledgersRouter'],
    reason: 'Per-device idempotency ledgers for installs/vault uploads; the write plane must work whenever sync works.',
  },
  'use /api/vault': {
    gates: ['vaultRouter'],
    reason: 'Vault key parameters (salt + keyId): a device must fetch these to set the vault up at all; no key material lives here.',
  },
  'use /api/account': {
    gates: ['accountRouter'],
    reason: 'Ungated so a lapsed or un-subscribed user can still reach their account to (re)subscribe and configure alerts.',
  },
  'use /api/status': {
    gates: ["rl('read-light')", 'statusRouter'],
    reason: 'State visibility stays reachable when lapsed — a user must be able to see state before they pay.',
  },
  'use /api/health': {
    gates: ["rl('read-light')", 'fleetHealthRouter'],
    reason: '"Is it working on my machines?" — diagnostics must not hide behind the paywall they might explain.',
  },

  // --- paid value surfaces -------------------------------------------------
  'use /api/search': {
    gates: ['paid', "rl('read-heavy')", 'searchRouter'],
    reason: 'Core memory value (paid); FTS/vector queries are the expensive read class.',
  },
  'use /api/conversations': {
    gates: ['paid', "rl('read-heavy')", 'conversationsRouter'],
    reason: 'Core memory value (paid); per-session reads carry real compute.',
  },
  'use /api/memory': {
    gates: ['paid', "rl('read-heavy')", 'memoryRouter'],
    reason: 'Core memory value (paid); unified-memory search is read-heavy.',
  },
  'use /api/edits': {
    gates: ['paid', "rl('read-heavy')", 'editsRouter'],
    reason: 'Edits timeline over synced diff rows: memory value (paid), read-heavy.',
  },
  'use /api/projects': {
    gates: ['paid', "rl('read-light')", 'projectsRouter'],
    reason: 'Project tree over memory metadata: memory value (paid), cheap reads.',
  },
  'use /api/data': {
    gates: ["rl('write-light')", 'dataControlsRouter'],
    reason: 'Export/delete controls: DELIBERATELY UNGATED. Taking your history with you must never require paying again, and neither must erasing it. `paid` was removed on 2026-08-25, when the lapsed rule became a hard stop: under the old rule it passed the export GET and refused both delete POSTs, which was exactly backwards.',
  },
  'use /api/secrets': {
    gates: ['paid', "rl('read-light')", 'secretsRouter'],
    reason: 'Scan VERDICT is free-tier visible, so no alerts gate at the mount; the monitoring half (rules, dismissals, rescans) gates inside the router.',
  },
  'use /api/analytics': {
    gates: ['paid', 'insights', "rl('read-heavy')", 'analyticsRouter'],
    reason: 'Analysis tier: `insights` is not in the free plan.',
  },
  'use /api/activity': {
    gates: ['paid', 'team', "rl('read-heavy')", 'activityRouter'],
    reason: 'Team activity view needs a second person: collaboration tier.',
  },
  'use /api/shares': {
    gates: ['paid', 'team', "rl('write-light')", 'sharesRouter'],
    reason: 'Per-project sharing is collaboration by definition: team tier.',
  },
  'use /api/tasks': {
    gates: ['paid', 'tasks', "rl('write-light')", 'tasksRouter'],
    reason: '`tasks`, not `team`: a Solo customer gets their own board; assignment to others is enforced as team inside the router.',
  },
  'use /api/kg': {
    gates: ['paid', "rl('write-light')", 'kgRouter'],
    reason: 'Knowledge-graph recall surface for the thin MCP: memory value (paid).',
  },
  'use /api/kv': {
    gates: ['paid', "rl('write-light')", 'kvRouter'],
    reason: 'Key-value recall surface for the thin MCP: memory value (paid).',
  },
  'use /api/diary': {
    gates: ['paid', "rl('write-light')", 'diaryRouter'],
    reason: 'Agent-diary recall surface: memory value (paid).',
  },
  'use /api/sync-intents': {
    gates: ['paid', "rl('write-light')", 'syncIntentsRouter'],
    reason: 'Cross-tool intent queue. ENQUEUE self-gates on toolkit inside the router; drain/ack stay open so a lapsed tenant’s CLI can finish intents enqueued while entitled.',
  },
  'use /api/files': {
    gates: ['paid', "rl('read-light')", 'filesRouter'],
    reason: 'File-level memory reads: memory value (paid), cheap reads.',
  },
  'use /api/subagents': {
    gates: ['paid', "rl('read-light')", 'subagentsRouter'],
    reason: 'Subagent transcript reads: memory value (paid), cheap reads.',
  },
  'use /api/code': {
    gates: ['paid', 'findings', "rl('read-light')", 'codeRouter'],
    reason: 'Code intelligence is the `findings` feature; the collector runs on the user’s machine, the store-backed reads live here.',
  },
  'use /api/recommendations': {
    gates: ['paid', 'findings', "rl('read-light')", 'recommendationsRouter'],
    reason: 'Reasons over the code findings, so it shares the `findings` gate rather than growing one of its own.',
  },
  'use /api/toolkit': {
    gates: ['paid', 'toolkit', "rl('read-light')", 'toolkitRouter'],
    reason: 'Toolkit tier: reads come from the synced store; fs-mutating routes self-guard with requireLocalMode inside the router.',
  },
  'use /api/audit': {
    gates: ['paid', "rl('read-light')", 'auditRouter'],
    reason: 'The router gates every route on the `audit` feature itself — the whole surface IS the licensed feature.',
  },

  // --- non-API surfaces ----------------------------------------------------
  'use /api/settings': {
    gates: ['settingsRouter'],
    reason: 'Local-only (mounted inside !isServerMode()): settings editing mutates the local fs, so no entitlement applies.',
  },
  'get /health': {
    gates: ['<inline>'],
    reason: 'Public liveness/readiness probe; the build stamp inside only reveals itself to the operator (x-admin-key).',
  },
  'get /': {
    gates: ['<inline>'],
    reason: 'Landing-vs-app-shell switch on the session cookie; presence-only, decides which HTML to serve, never what anyone may read.',
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('route manifest ↔ server.ts mounts', () => {
  const src = readFileSync(SERVER_TS, 'utf-8');
  const surfaces = aggregate(extractMounts(src));

  test('extraction is non-trivial (guards a broken regex)', () => {
    // A parser change that silently extracts nothing must fail loudly, not
    // pass an empty comparison.
    expect(surfaces.size).toBeGreaterThan(30);
    expect(surfaces.get('use /api/search')).toBeDefined();
  });

  test('every mount in server.ts is a surface the manifest knows', () => {
    const problems: string[] = [];
    for (const [key, gates] of surfaces) {
      if (!(key in MANIFEST)) {
        problems.push(
          `NEW SURFACE: \`${key}\` is mounted in server.ts with gates [${gates.join(', ')}] `
          + 'but is not in the MANIFEST. This is a new API surface — decide its gate '
          + '(paid? which feature? which rate class? deliberately ungated?) and add it '
          + 'to MANIFEST in route-manifest.test.ts with a one-sentence reason.',
        );
      }
    }
    expect(problems, problems.join('\n\n')).toEqual([]);
  });

  test('every manifest entry still matches the gates in the source', () => {
    const problems: string[] = [];
    for (const [key, entry] of Object.entries(MANIFEST)) {
      const actual = surfaces.get(key);
      if (!actual) {
        problems.push(
          `REMOVED SURFACE: \`${key}\` is in the MANIFEST but no longer mounted in `
          + 'server.ts. If the removal is intentional, delete its MANIFEST entry; '
          + 'if not, the surface (and its gates) silently disappeared.',
        );
        continue;
      }
      const want = [...entry.gates].sort();
      const got = [...actual].sort();
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        problems.push(
          `GATING CHANGED: \`${key}\`\n`
          + `  source has:       [${got.join(', ')}]\n`
          + `  manifest expects: [${want.join(', ')}]\n`
          + '  If the change is intentional, update the MANIFEST entry AND its reason '
          + `(current reason: "${entry.reason}").`,
        );
      }
    }
    expect(problems, problems.join('\n\n')).toEqual([]);
  });

  test('every manifest entry carries a reason', () => {
    for (const [key, entry] of Object.entries(MANIFEST)) {
      expect(entry.reason.trim().length, `${key} has an empty reason`).toBeGreaterThan(10);
    }
  });
});
