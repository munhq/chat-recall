/**
 * Per-request credentials, for serving the SAME tool surface to a remote caller.
 *
 * ── The problem ───────────────────────────────────────────────────────────
 *
 * Every server-backed tool in mcp.ts reaches the API through five helpers
 * (remoteGet, remotePost, remotePatch, remoteGetQS, remoteGetSoft), and all five
 * resolve their credentials the same way: `remoteCredentials()`, which reads
 * CHAT_RECALL_TOKEN from the environment or credentials.json from the disk.
 *
 * That is exactly right for the stdio server, where one process serves one
 * human. It is exactly wrong for a remote /mcp endpoint, where one process
 * serves many people concurrently and the identity arrives per REQUEST, in an
 * OAuth bearer token. A process-wide credential there would answer every caller
 * out of whichever account happened to be in the environment — the worst class
 * of bug this product can have.
 *
 * ── Why AsyncLocalStorage and not a parameter ─────────────────────────────
 *
 * The obvious fix is to thread a context argument through the call chain. There
 * are 98 call sites of those five helpers inside a 4,600-line dispatch, so that
 * change touches nearly every tool and every one of them is an opportunity to
 * pass the wrong thing, silently, in a way tests structured around the stdio
 * path would not catch.
 *
 * AsyncLocalStorage moves the same information out of band. The helpers keep
 * their signatures, the 98 call sites are untouched, and the store follows the
 * async call chain of one request without leaking into a concurrent one. The
 * whole change is: run the dispatch inside `withCredentials()`, and have
 * `remoteCredentials()` consult the store first.
 *
 * ── The fallback is the stdio product, unchanged ──────────────────────────
 *
 * With no store set — which is every stdio invocation — `current()` returns
 * null and the caller falls through to env, then disk, exactly as before. This
 * module adds a path; it removes none.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** What a server-backed tool needs in order to make one API call as one user. */
export interface RemoteCredentials {
  /** Server base URL, no trailing slash. */
  base: string;
  /** Bearer token for THIS caller. On /mcp this is their OAuth access token. */
  token: string;
}

const store = new AsyncLocalStorage<RemoteCredentials>();

/**
 * Run `fn` with `creds` as the ambient credentials for its whole async subtree.
 *
 * The remote transport wraps one JSON-RPC request in this. Nested calls, awaited
 * promises and callbacks inside `fn` all see the same value; a sibling request
 * running concurrently sees its own. That isolation is the entire reason this
 * module exists, so it is asserted directly in mcp-credential-context.test.ts.
 */
export function withCredentials<T>(creds: RemoteCredentials, fn: () => T): T {
  return store.run(creds, fn);
}

/**
 * The ambient credentials, or null when there are none.
 *
 * Null is the normal answer under stdio and MUST stay non-throwing: the caller's
 * job is to fall back to env and disk, and an exception here would break the
 * local product in order to serve the remote one.
 */
export function currentCredentials(): RemoteCredentials | null {
  return store.getStore() ?? null;
}

/**
 * True when this process is serving requests on behalf of many callers, i.e. the
 * remote transport is active.
 *
 * Tools that read the CALLER'S OWN DISK (`recall_index`, `recall_code_index`)
 * are meaningless and misleading there — the server's disk is not the user's.
 * Both the LISTING and the DISPATCH consult this: dropping a tool from
 * tools/list stops a client offering it, and stops nothing else, so a client
 * calling it by name from a cached list still reaches the handler. Set once at
 * boot by the remote transport; never true for stdio.
 */
let multiTenant = false;

export function setMultiTenantMode(on: boolean): void {
  multiTenant = on;
}

export function isMultiTenant(): boolean {
  return multiTenant;
}
