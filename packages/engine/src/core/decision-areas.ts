/**
 * Decision areas — the key a decision supersedes on.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * `recall_decision_record` already writes `subject → decided → object` and the
 * server already defaults `supersede` to on, so recording a new value for the
 * same subject ALREADY closes the old one. In practice it never fired, because
 * `subject` was free text: "auth", "authentication" and "auth setup" are three
 * different subjects, so nothing ever superseded anything.
 *
 * The production graph shows both halves of that. `decided`, which only the
 * explicit tool writes, has one subject with more than one live value. `chose`,
 * which the regex extractor writes, has fifty — one of them with 227 distinct
 * live objects, because a project accumulates every unrelated choice it ever
 * made under a single subject.
 *
 * So the fix is not more machinery. It is a canonical key, and then the
 * supersede that already exists starts being correct:
 *
 *     project X + area `auth`  →  BetterAuth      (Keycloak gets an end date)
 *     project X + area `database`  →  Postgres    (untouched by the above)
 *
 * ── Why a fixed vocabulary, not free text ───────────────────────────────────
 *
 * Free text fragments, which is the bug. A closed enum is rigid — nobody can
 * predict every area a team decides about. So: a canonical set with an alias
 * table for the ways people actually write those names, and a slug fallback so
 * an unlisted area is still usable and still collapses its own variants
 * ("Package Pinning" and "package-pinning" become one key).
 *
 * Areas are NOT limited to code. `pricing`, `licensing` and `positioning` are
 * decisions a team reverses at least as often as an auth library, and they are
 * exactly the ones nobody can find six months later.
 */

/**
 * The canonical areas. Additions are cheap; renames are not — an existing
 * decision keyed on the old name stops resolving, so add an ALIAS instead of
 * renaming anything here.
 */
export const DECISION_AREAS = [
  'auth',
  'database',
  'payments',
  'api',
  'frontend',
  'deploy',
  'testing',
  'observability',
  'security',
  'pricing',
  'licensing',
  'positioning',
] as const;

export type DecisionArea = (typeof DECISION_AREAS)[number];

const AREA_SET: ReadonlySet<string> = new Set(DECISION_AREAS);

/**
 * Alias → canonical. Deliberately generous: every entry here is a variant seen
 * in real transcripts or the obvious synonym someone reaches for first. A miss
 * costs a split key, which is the whole failure this module exists to stop.
 */
const AREA_ALIASES: Record<string, DecisionArea> = {
  // auth
  authentication: 'auth',
  authn: 'auth',
  authz: 'auth',
  authorisation: 'auth',
  authorization: 'auth',
  login: 'auth',
  'sign-in': 'auth',
  signin: 'auth',
  sso: 'auth',
  identity: 'auth',
  // database
  db: 'database',
  datastore: 'database',
  storage: 'database',
  persistence: 'database',
  orm: 'database',
  migrations: 'database',
  // payments
  billing: 'payments',
  payment: 'payments',
  checkout: 'payments',
  subscriptions: 'payments',
  // api
  backend: 'api',
  server: 'api',
  rpc: 'api',
  // frontend
  ui: 'frontend',
  client: 'frontend',
  web: 'frontend',
  styling: 'frontend',
  css: 'frontend',
  // deploy
  deployment: 'deploy',
  infra: 'deploy',
  infrastructure: 'deploy',
  hosting: 'deploy',
  ci: 'deploy',
  cd: 'deploy',
  'ci-cd': 'deploy',
  release: 'deploy',
  // testing
  tests: 'testing',
  test: 'testing',
  qa: 'testing',
  e2e: 'testing',
  // observability
  monitoring: 'observability',
  logging: 'observability',
  metrics: 'observability',
  alerting: 'observability',
  tracing: 'observability',
  // security
  secrets: 'security',
  compliance: 'security',
  privacy: 'security',
  // pricing
  price: 'pricing',
  plans: 'pricing',
  tiers: 'pricing',
  // licensing
  licence: 'licensing',
  license: 'licensing',
  // positioning
  marketing: 'positioning',
  branding: 'positioning',
  messaging: 'positioning',
};

/**
 * Reduce an area to a stable key.
 *
 * Returns a canonical area when the input names one, otherwise a slug of the
 * input so an unlisted area still collapses its own spellings. Empty or
 * punctuation-only input returns null — a decision with no area is a decision
 * that cannot supersede anything, and the caller must decide what to do about
 * that rather than have a silent `""` key invented here.
 */
export function canonArea(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lowered = raw.trim().toLowerCase();
  if (!lowered) return null;

  // Collapse separators before the alias lookup so "Sign In", "sign_in" and
  // "sign-in" all reach the same entry.
  const slug = lowered
    .replace(/[\s_/]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return null;

  if (AREA_SET.has(slug)) return slug;
  if (AREA_ALIASES[slug]) return AREA_ALIASES[slug];

  // Unlisted, but still worth keying consistently. Trimmed so a pasted
  // sentence cannot become a key nothing else will ever match.
  return slug.slice(0, 40);
}

/** True when the key names one of the canonical areas rather than a slug. */
export function isKnownArea(key: string | null | undefined): key is DecisionArea {
  return !!key && AREA_SET.has(key);
}

/**
 * The knowledge-graph subject a decision is recorded against.
 *
 * `<project>:<area>` rather than the area alone, because the same question gets
 * different answers per repository — one client mandating Keycloak must not
 * close the account-wide BetterAuth decision. Account-scope decisions use the
 * sentinel project so they share one namespace and still supersede each other.
 */
export const ACCOUNT_SCOPE = '*';

export function decisionSubject(project: string | null | undefined, area: string): string {
  const p = (project || '').trim() || ACCOUNT_SCOPE;
  return `${p}:${area}`;
}

/** Split a subject back into its parts; null when it is not area-keyed. */
export function parseDecisionSubject(subject: string): { project: string; area: string } | null {
  const i = subject.lastIndexOf(':');
  if (i <= 0 || i === subject.length - 1) return null;
  return { project: subject.slice(0, i), area: subject.slice(i + 1) };
}

/* ---------------------------------------------------------------------------
 * Scopes
 *
 * Four of them, and the middle one is the reason this section exists. An
 * account-wide decision and a per-repository one are the two ends of a range,
 * and most real decisions sit between: everything under `~/code/personal`
 * shares a stack, and none of it binds a client repository.
 *
 * The group key is the WORKSPACE id the resolver already uses for the sidebar
 * (`ws:<name>`, core/project-resolver.ts), so a folder group has one name
 * across the product. It is derived from the folder above the repository,
 * which makes it machine-independent: `/home/user/code/personal/example-app` and
 * `/Users/alice/code/personal/other-app` are both `ws:personal`, so a decision
 * recorded on one machine still resolves on the other.
 *
 * Precedence, most specific first:
 *
 *   project  >  workspace  >  account  >  user
 *
 * User sits LAST, unchanged: a personal preference fills a gap nobody has
 * decided and never overrules a team decision.
 * ------------------------------------------------------------------------- */

export const WORKSPACE_SCOPE_PREFIX = 'ws:';
export const USER_SCOPE_PREFIX = 'user:';

export type DecisionScopeKind = 'project' | 'workspace' | 'account' | 'user';

/** Which tier a scope key belongs to. */
export function scopeKind(key: string): DecisionScopeKind {
  if (key === ACCOUNT_SCOPE) return 'account';
  if (key.startsWith(WORKSPACE_SCOPE_PREFIX)) return 'workspace';
  if (key.startsWith(USER_SCOPE_PREFIX)) return 'user';
  return 'project';
}

/** The scope key for a folder group. */
export function workspaceScope(name: string): string {
  const n = (name || '').trim().replace(/^ws:/, '');
  return n ? `${WORKSPACE_SCOPE_PREFIX}${n}` : '';
}

/** The scope key for one person's own preferences. */
export function userScope(userId: string): string {
  const u = (userId || '').trim().replace(/^user:/, '');
  return u ? `${USER_SCOPE_PREFIX}${u}` : '';
}

/**
 * Tails that name a throwaway checkout rather than the repository itself.
 * Without this every worktree reports the group `worktrees`, and a decision
 * recorded from one lands in a group no other session ever resolves to.
 */
const WORKTREE_TAIL = /\/\.[^/]+\/worktrees\/[^/]+$/;

/** A path with any worktree tail removed, so a checkout reads as its repository. */
function repoPath(p: string): string {
  let out = p;
  while (WORKTREE_TAIL.test(out)) out = out.replace(WORKTREE_TAIL, '');
  return out;
}

/** Path segments that hold repositories but are not a group anybody decides for. */
const NOT_A_GROUP = new Set(['', '/', 'home', 'Users', 'tmp', 'var', 'mnt', 'opt']);

/**
 * The folder group a repository path belongs to — the directory ABOVE the
 * repository, as `ws:<name>`.
 *
 * Returns null when the path has no such folder (a repository directly under
 * `/` or a home directory belongs to no group), so the caller falls through to
 * the account tier rather than inventing one.
 */
export function workspaceFromPath(projectPath: string | null | undefined): string | null {
  let p = (projectPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!p || !p.startsWith('/')) return null;

  // A worktree lives inside the repository it belongs to, so cutting the tail
  // leaves the repository path and the group resolves the same as a normal
  // checkout of it.
  p = repoPath(p);

  const segs = p.split('/').filter(Boolean);
  if (segs.length < 2) return null;              // the repository has no parent folder
  const group = segs[segs.length - 2];
  if (NOT_A_GROUP.has(group)) return null;
  // `/home/<user>/repo` and `/Users/<user>/repo`: the parent is the person, not
  // a group. Two segments before the repository is what a group needs.
  if (segs.length === 3 && (segs[0] === 'home' || segs[0] === 'Users')) return null;
  return workspaceScope(group);
}

/**
 * The key a project's decisions live under.
 *
 * It must be the SAME string on every machine and for every teammate, or one
 * repository grows two registers and each half looks complete. A project_id is
 * not that string: without a git remote it is a sha1 of the absolute path
 * (project-resolver.ts), so one repository checked out on two machines has two
 * ids. That is not hypothetical — a repo can already appear as both
 * `git:github.com/owner/repo` and `git-local:<sha1>` in one account.
 *
 * So: the remote when there is one, because it is identical everywhere. When
 * there is none, the folder name inside its group, because two folders of one
 * name cannot exist in one folder. Neither is a new naming scheme; both are
 * built from the ids the resolver already assigns.
 *
 * Where it degrades, visibly rather than silently: a remoteless repository kept
 * in a different group on each machine resolves to two keys, and renaming a
 * repository on its host changes its remote and orphans its decisions until
 * someone re-points them.
 */
export function decisionProjectKey(projectId: string | null | undefined, projectPath?: string | null): string {
  const id = (projectId || '').trim();

  // A remote-backed id is already stable everywhere. So is a user-declared one:
  // the person chose that name, so it does not move when a checkout does.
  if (id.startsWith('git:') || id.startsWith('user:') || id.startsWith(WORKSPACE_SCOPE_PREFIX)) return id;

  const path = (projectPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (path) {
    const repo = repoPath(path);
    const base = repo.split('/').filter(Boolean).pop();
    if (base) {
      const group = workspaceFromPath(repo);
      return group ? `${group}/${base}` : base;
    }
  }

  // Nothing but a name to go on — the agent passed one, and it is already the
  // stable half of the fallback key.
  return id;
}

/**
 * Older spellings the same project's decisions may already sit under.
 *
 * Canonicalising without this would orphan every decision recorded before it,
 * silently, for every existing user. The register reads these AFTER the
 * canonical key and writes only ever go to the canonical one, so a legacy row
 * keeps answering until something replaces it.
 */
export function decisionProjectAliases(
  projectId: string | null | undefined,
  projectPath?: string | null,
  asked?: string | null,
): string[] {
  const canonical = decisionProjectKey(projectId, projectPath);
  const out: string[] = [canonical];
  const add = (v: string | null | undefined) => {
    const t = (v || '').trim();
    if (t && !out.includes(t)) out.push(t);
  };
  add(asked);                 // what the caller typed, which is what old writes used
  add(projectId);
  const repo = projectPath ? repoPath(projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '')) : '';
  add(repo.split('/').filter(Boolean).pop());
  return out;
}

/**
 * The scope keys to resolve against, most specific first.
 *
 * The caller passes what it knows; every absent tier is skipped rather than
 * filled with a placeholder, so a request with no project still answers from
 * the account tier.
 */
export function scopeChain(opts: {
  /** One key, or the canonical key followed by older spellings of it. */
  project?: string | string[] | null;
  workspace?: string | null;
  userId?: string | null;
}): string[] {
  const chain: string[] = [];
  const projects = (Array.isArray(opts.project) ? opts.project : [opts.project])
    .map((p) => (p || '').trim())
    .filter((p, i, a) => p && a.indexOf(p) === i);
  chain.push(...projects);
  const ws = opts.workspace ? workspaceScope(opts.workspace) : '';
  if (ws && !chain.includes(ws)) chain.push(ws);
  chain.push(ACCOUNT_SCOPE);
  const user = opts.userId ? userScope(opts.userId) : '';
  if (user) chain.push(user);
  return chain;
}

/**
 * Guess which area a decision VALUE belongs to.
 *
 * Only used to pre-fill the area when confirming a candidate the extractor
 * guessed — never to record one unattended. A wrong guess a human corrects in
 * one click costs nothing; a wrong guess written silently splits the key this
 * whole module exists to keep whole.
 *
 * Returns null rather than guessing wildly. "We chose the second option" names
 * no area, and an area invented for it would be worse than asking.
 */
const VALUE_AREA: Record<string, DecisionArea> = {
  // auth
  keycloak: 'auth', auth0: 'auth', betterauth: 'auth', 'better-auth': 'auth',
  clerk: 'auth', supertokens: 'auth', okta: 'auth', firebase: 'auth',
  nextauth: 'auth', 'next-auth': 'auth', passkeys: 'auth', oidc: 'auth',
  saml: 'auth', jwt: 'auth', lucia: 'auth', workos: 'auth',
  // database
  postgres: 'database', postgresql: 'database', sqlite: 'database',
  mysql: 'database', mysql2: 'database', mongodb: 'database', mongo: 'database',
  redis: 'database', ioredis: 'database', pg: 'database', 'better-sqlite3': 'database',
  dragonfly: 'database', cockroachdb: 'database', planetscale: 'database',
  supabase: 'database', dynamodb: 'database', lancedb: 'database',
  chromadb: 'database', pgvector: 'database', prisma: 'database',
  drizzle: 'database', sqlalchemy: 'database', typeorm: 'database',
  // payments
  stripe: 'payments', paddle: 'payments', lemonsqueezy: 'payments',
  braintree: 'payments', adyen: 'payments', paypal: 'payments',
  // frontend
  react: 'frontend', vue: 'frontend', svelte: 'frontend', angular: 'frontend',
  solid: 'frontend', htmx: 'frontend', tailwind: 'frontend', shadcn: 'frontend',
  'next.js': 'frontend', nextjs: 'frontend', remix: 'frontend', astro: 'frontend',
  vite: 'frontend', webpack: 'frontend',
  // api
  trpc: 'api', graphql: 'api', rest: 'api', grpc: 'api', openapi: 'api',
  express: 'api', fastify: 'api', hono: 'api', fastapi: 'api', django: 'api',
  // testing
  vitest: 'testing', jest: 'testing', playwright: 'testing', cypress: 'testing',
  mocha: 'testing', pytest: 'testing', 'testing-library': 'testing',
  // observability
  grafana: 'observability', loki: 'observability', prometheus: 'observability',
  datadog: 'observability', sentry: 'observability', glitchtip: 'observability',
  opentelemetry: 'observability', otel: 'observability', jaeger: 'observability',
  // deploy
  docker: 'deploy', kubernetes: 'deploy', k8s: 'deploy', k3s: 'deploy',
  terraform: 'deploy', ansible: 'deploy', argocd: 'deploy', keel: 'deploy',
  vercel: 'deploy', netlify: 'deploy', fly: 'deploy', railway: 'deploy',
  'github-actions': 'deploy', nginx: 'deploy', caddy: 'deploy', traefik: 'deploy',
  // security
  vault: 'security', 'external-secrets': 'security', 'sealed-secrets': 'security',
  // licensing
  mit: 'licensing', apache: 'licensing', bsl: 'licensing', agpl: 'licensing',
  gpl: 'licensing', 'elastic-license': 'licensing', elv2: 'licensing',
};

export function inferArea(value: string | null | undefined): DecisionArea | null {
  if (!value) return null;
  const v = value.toLowerCase();

  // Exact first — "postgres" should not match on a substring rule.
  const exact = VALUE_AREA[v.trim().replace(/[\s_]+/g, '-')];
  if (exact) return exact;

  // Then word-boundary containment, so "moved the writer off the transaction
  // pooler to postgres" still resolves. Longest key first, or "auth" inside
  // "betterauth" would win over the real entry.
  const keys = Object.keys(VALUE_AREA).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    if (re.test(v)) return VALUE_AREA[k];
  }
  return null;
}
