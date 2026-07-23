/**
 * Ambient tenant context. The server's auth middleware wraps each request in
 * `runWithTenant(tenant, () => next())`; the store factories then default their
 * tenant to `currentTenant()` when no explicit `tenant` option is passed. This
 * keeps the ~45 `createStore()` call-sites untouched — they automatically scope
 * to the request's tenant — while the CLI / auto-indexer (which never call
 * runWithTenant) fall through to env / 'default'.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<string>();

/** Run `fn` with `tenant` as the ambient tenant for all async work it spawns. */
export function runWithTenant<T>(tenant: string, fn: () => T): T {
  return als.run(tenant, fn);
}

/** The ambient tenant for the current async context, or undefined outside one. */
export function currentTenant(): string | undefined {
  return als.getStore();
}

/**
 * Ambient AUTHOR context — who is producing the writes in the current request.
 * Parallel to the tenant ALS: the sync route / tenantAuth wrap each request in
 * `runWithAuthor({ sub, device }, …)`, and PgStore write methods read
 * `currentAuthor()` at write time to stamp `author_sub` / `author_device` on
 * every row. Read at write time (not captured at store construction) so a
 * reused/cached store can never misattribute a later request's rows.
 *
 * `sub`    = the Keycloak user that owns the syncing device (from the agent
 *            token's `user_sub`), or null for solo/self-host/legacy.
 * `device` = the syncing device id (agent token device_id), or null.
 *
 * A NULL author marks a row as legacy/solo — the team-visibility layer treats
 * NULL as team-visible (status quo), so enabling attribution never retroactively
 * hides pre-attribution data.
 */
export interface AuthorContext {
  sub: string | null;
  device: string | null;
}

const authorAls = new AsyncLocalStorage<AuthorContext>();

/** Run `fn` with `author` as the ambient author for all async work it spawns. */
export function runWithAuthor<T>(author: AuthorContext, fn: () => T): T {
  return authorAls.run(author, fn);
}

/**
 * Run `fn` with NO ambient author — i.e. as the unrestricted worker/system
 * context. currentViewer() then returns `undefined`, so the pool sets
 * `app.viewer='*'` and RLS author_visibility short-circuits to "see the whole
 * tenant". Tenant isolation is UNAFFECTED (app.tenant comes from a separate
 * context), so this stays scoped to the caller's tenant.
 *
 * Used for writes to PROJECT-scoped SHARED tables (code_*), where a member
 * re-indexing a project must be able to upsert the single shared row even when
 * they have no visible session in it — an ON CONFLICT write otherwise fail-closes
 * on the RESTRICTIVE author_visibility SELECT policy (which gates READS only).
 * These tables carry no author-write-guard, so elevating the WRITE leaks nothing;
 * reads keep the member's real viewer and stay gated.
 */
export function runUnrestricted<T>(fn: () => T): T {
  return authorAls.exit(fn);
}

/** The ambient author for the current async context; `{sub:null,device:null}` outside one. */
export function currentAuthor(): AuthorContext {
  return authorAls.getStore() ?? { sub: null, device: null };
}

/**
 * The VIEWER for per-project team visibility (RLS `app.viewer` GUC), derived
 * from the same request author context. The tri-state is deliberate and is the
 * whole fail-closed story:
 *
 *   - `undefined` → NO author context is set. This is a background worker, the
 *     CLI, or a direct-to-pg tool. The pool leaves `app.viewer` UNSET, and the
 *     RLS policy's `current_setting('app.viewer', true) IS NULL` short-circuit
 *     lets it read everything (workers legitimately need the whole tenant).
 *   - a string (a Keycloak sub) → a real multi-user request; RLS filters to
 *     own + shared + legacy(NULL-author) rows.
 *   - `null` → a request ran through auth but the actor has no user id
 *     (self-host `none`/`static-token`, or an agent token minted without a
 *     user). The pool sets `app.viewer=''`; the policy then matches only
 *     NULL-author rows — which is exactly the whole dataset in single-user
 *     self-host (every row is NULL-author), so behaviour is unchanged there.
 *
 * The key property: a request that DID authenticate always sets the GUC, so a
 * forgotten viewer fails CLOSED (sees only NULL-author rows), never open.
 */
export function currentViewer(): string | null | undefined {
  const a = authorAls.getStore();
  return a === undefined ? undefined : a.sub;
}
