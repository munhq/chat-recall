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
  mysql: 'database', mongodb: 'database', mongo: 'database', redis: 'database',
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
