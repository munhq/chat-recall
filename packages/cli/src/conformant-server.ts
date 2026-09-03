/**
 * The SMALLEST server the collector will successfully sync to.
 *
 * ── Why this exists, next to hostile-server.ts ────────────────────────────
 * hostile-server.ts proves the CLI describes a BROKEN server correctly. Nothing
 * proved the CLI can complete a sync at all except the compose-integration
 * workflow, which needs Docker and therefore runs on Linux only. So on macOS and
 * Windows the gate said: it installs, it prints a version, it boots the MCP
 * server, and it fails gracefully. Whether `login` then `sync` actually uploads
 * a session on those two platforms was never checked anywhere.
 *
 * Every failure that gap could hide is platform-shaped — path separators, a
 * case-insensitive filesystem, a home directory with a space in it, CRLF in a
 * transcript, a Windows temp path in a project id. This answers it with no
 * Docker and no network: an in-process HTTP server that speaks enough of the API
 * for a real `login --token` and a real `sync` to succeed, and that RECORDS what
 * it was sent so a test can assert the session actually arrived.
 *
 * It is deliberately not a fake of the product. It has no storage, no tenants
 * and no search. It answers the seven endpoints the collector's sync path calls,
 * with the minimum each one needs, and keeps the request bodies.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';

/** One request the collector made. */
export interface RecordedRequest {
  method: string;
  path: string;
  /** Parsed JSON body, when there was one. */
  body?: unknown;
  /** When the request arrived, and when this stub finished answering it.
   *  A test that cares about ORDER needs both: two POSTs can arrive in the
   *  right order and still be answered in the wrong one. */
  at?: number;
  doneAt?: number;
}

export interface ConformantServerOptions {
  /**
   * Hold an /api/sync upload open for this many ms before answering.
   *
   * A stub that answers instantly cannot distinguish "B was queued after A"
   * from "B was queued after A LANDED", and the collector's uploads are pooled
   * and concurrent — so an ordering bug passes against a fast stub every time.
   * `pick` chooses which uploads to delay from the parsed body.
   */
  delayMs?: number;
  delayWhen?: (body: Record<string, unknown>) => boolean;
}

export interface ConformantServer {
  url: string;
  /** Every request, in order — the record a test asserts against. */
  requests: RecordedRequest[];
  /** The conversations POSTed to /api/sync across every upload. */
  uploaded: () => Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

/** The API version this stub claims. Must be >= the collector's floor. */
const API_VERSION = 2;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  let raw = Buffer.concat(chunks);
  // The collector gzips a body when the server advertises it. This one does not
  // advertise it, but decode anyway rather than fail confusingly if that ever
  // changes.
  if (req.headers['content-encoding'] === 'gzip') {
    try { raw = gunzipSync(raw); } catch { /* fall through to a parse failure */ }
  }
  try { return JSON.parse(raw.toString('utf8')); } catch { return raw.toString('utf8'); }
}

export async function startConformantServer(opts: ConformantServerOptions = {}): Promise<ConformantServer> {
  const requests: RecordedRequest[] = [];
  const conversations: Array<Record<string, unknown>> = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url || '').split('?')[0];
      const body = await readBody(req);
      const record: RecordedRequest = { method: req.method || 'GET', path, body, at: Date.now() };
      requests.push(record);

      const json = (status: number, payload: unknown): void => {
        record.doneAt = Date.now();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      switch (path) {
        case '/api/capabilities':
          // apiVersion is what verifyServerApi requires; `limits` is what it
          // learns from here instead of assuming.
          return json(200, {
            apiVersion: API_VERSION,
            edition: 'test-stub',
            authProvider: 'none',
            oidcIssuer: null,
            limits: { ingestConcurrencyPerTenant: 2, acceptsGzipBody: false },
          });

        case '/api/status':
          // Used by `login` to verify a token, and by `status`.
          return json(200, { ok: true, sessions: 0 });

        case '/api/secrets/rules':
          // No tenant rules; the collector's compiled-in redactors still apply.
          return json(200, { version: 'stub-1', rules: [], pack: { version: 'stub-1', rules: [] } });

        case '/api/teams/security-config':
          return json(200, { verifySecrets: true, telemetry: false });

        case '/api/sync-config/sources':
          // The collector REPORTS its sources here; nothing to answer.
          return json(200, { ok: true });

        case '/api/sync-config':
          // No server-side exclusions. An empty set here is a real answer, and
          // the collector refuses to sync when it cannot get one at all.
          return json(200, { excludeTools: [], excludeProjects: [], excludeSources: [], approveSources: [] });

        case '/api/sync': {
          const b = body as { conversations?: Array<Record<string, unknown>>; fields?: unknown[] } | undefined;
          if (Array.isArray(b?.conversations)) conversations.push(...b.conversations);
          if (opts.delayMs && (!opts.delayWhen || opts.delayWhen((body || {}) as Record<string, unknown>))) {
            await new Promise((r) => setTimeout(r, opts.delayMs));
          }
          // `cli: null` so the collector never tries to self-update from a stub.
          return json(200, { accepted: b?.conversations?.length ?? 0, full_resync_needed: [], cli: null, telemetry: false });
        }

        default:
          // A 404 here is honest: this stub implements the sync path, not the
          // whole API. Anything the collector needs and does not get shows up as
          // a named endpoint in `requests`, which is how this stays minimal.
          return json(404, { error: 'not implemented by the conformant stub', path });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    uploaded: () => conversations,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
