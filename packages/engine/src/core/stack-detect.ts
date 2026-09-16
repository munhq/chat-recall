/**
 * What a repository's manifests say its stack is.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The decision register is push-only. A triple is written when a human or an
 * agent asserts one, and the candidate extractor guesses from conversation
 * prose. Neither reads a repository, so a project that never had the
 * conversation has no decisions — and the cascade then answers from a broader
 * tier. One production account had eight decisions recorded against the account
 * sentinel from inside a single repository; every other project inherited them,
 * and a Tauri app whose store is `rusqlite` was told its database decision was
 * Postgres. The dependency had been in `src-tauri/Cargo.toml` the whole time
 * and nothing ever opened the file.
 *
 * So this reads the manifests at rest and says which areas the repository
 * already answers, with the line that answers them.
 *
 * ── Evidence, not a decision ────────────────────────────────────────────────
 *
 * A dependency says what is there. It cannot say what was ruled out, or why, or
 * whether the team would choose it again — which is the whole content of a
 * decision. `rusqlite` in a manifest is a fact about the build; "we use SQLite
 * because the app is local-first and has no server" is the decision, and only a
 * person or an agent that asked one can write the second half.
 *
 * So every result here is EVIDENCE with a file and a line attached. The caller
 * proposes it and something with judgement confirms it. Writing these
 * unattended would repeat the original failure with a machine behind it, at the
 * scale of every repository in an account.
 *
 * ── Why exact matches only ──────────────────────────────────────────────────
 *
 * `inferArea` matches on word boundaries so it can find a product name inside a
 * sentence, which is right for prose and wrong for a dependency list: `pg-boss`
 * is a job queue and would read as Postgres, `next-auth` is an auth library and
 * `next` is a framework. A manifest gives an exact token, so an exact table
 * answers it — a name this file does not know produces nothing rather than a
 * guess somebody has to undo.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DecisionArea } from './decision-areas.js';

/** One dependency that answers an area, and where it was read. */
export interface StackEvidence {
  /** The canonical area this dependency answers. */
  area: DecisionArea;
  /** The dependency name, as the manifest spells it. */
  name: string;
  /** The value to record for the area — a product name, not a package name. */
  value: string;
  /** Manifest path, relative to the repository root. */
  file: string;
  /** 1-based line the dependency sits on, so a reader can go and look. */
  line: number;
}

/** A manifest handed to the detector: its path and its full text. */
export interface ManifestFile {
  /** Path relative to the repository root, forward slashes. */
  path: string;
  content: string;
}

/**
 * Dependency name → the area it answers and the value a register should hold.
 *
 * The value is the PRODUCT, not the package: `rusqlite`, `r2d2_sqlite` and
 * `better-sqlite3` are three drivers for one database, and a register that
 * recorded the driver would say three different things about one decision.
 *
 * Only names whose presence really does answer the area. A test runner and a
 * database driver qualify; a utility library does not, and adding one produces
 * a card asking somebody to decide about `lodash`.
 */
const PACKAGE_STACK: Record<string, { area: DecisionArea; value: string }> = {
  // ── database ──────────────────────────────────────────────────────────────
  pg: { area: 'database', value: 'Postgres' },
  postgres: { area: 'database', value: 'Postgres' },
  'node-postgres': { area: 'database', value: 'Postgres' },
  psycopg2: { area: 'database', value: 'Postgres' },
  'psycopg2-binary': { area: 'database', value: 'Postgres' },
  psycopg: { area: 'database', value: 'Postgres' },
  asyncpg: { area: 'database', value: 'Postgres' },
  pgvector: { area: 'database', value: 'Postgres (pgvector)' },
  'tokio-postgres': { area: 'database', value: 'Postgres' },
  pq: { area: 'database', value: 'Postgres' },
  pgx: { area: 'database', value: 'Postgres' },
  sqlite3: { area: 'database', value: 'SQLite' },
  'better-sqlite3': { area: 'database', value: 'SQLite' },
  rusqlite: { area: 'database', value: 'SQLite' },
  r2d2_sqlite: { area: 'database', value: 'SQLite' },
  libsql: { area: 'database', value: 'SQLite (libSQL)' },
  'libsql-client': { area: 'database', value: 'SQLite (libSQL)' },
  turso: { area: 'database', value: 'SQLite (Turso)' },
  mysql: { area: 'database', value: 'MySQL' },
  mysql2: { area: 'database', value: 'MySQL' },
  mongodb: { area: 'database', value: 'MongoDB' },
  mongoose: { area: 'database', value: 'MongoDB' },
  pymongo: { area: 'database', value: 'MongoDB' },
  redis: { area: 'database', value: 'Redis' },
  ioredis: { area: 'database', value: 'Redis' },
  duckdb: { area: 'database', value: 'DuckDB' },
  lancedb: { area: 'database', value: 'LanceDB' },
  chromadb: { area: 'database', value: 'ChromaDB' },
  qdrant: { area: 'database', value: 'Qdrant' },
  'qdrant-client': { area: 'database', value: 'Qdrant' },
  // ORMs answer the area too — the store they front is named by the driver
  // beside them, and when there is no driver the ORM is all there is.
  prisma: { area: 'database', value: 'Prisma' },
  '@prisma/client': { area: 'database', value: 'Prisma' },
  'drizzle-orm': { area: 'database', value: 'Drizzle' },
  typeorm: { area: 'database', value: 'TypeORM' },
  sequelize: { area: 'database', value: 'Sequelize' },
  sqlalchemy: { area: 'database', value: 'SQLAlchemy' },
  diesel: { area: 'database', value: 'Diesel' },
  sqlx: { area: 'database', value: 'SQLx' },
  'sea-orm': { area: 'database', value: 'SeaORM' },
  gorm: { area: 'database', value: 'GORM' },

  // ── auth ──────────────────────────────────────────────────────────────────
  'better-auth': { area: 'auth', value: 'BetterAuth' },
  'next-auth': { area: 'auth', value: 'NextAuth' },
  '@auth/core': { area: 'auth', value: 'Auth.js' },
  'passport': { area: 'auth', value: 'Passport' },
  lucia: { area: 'auth', value: 'Lucia' },
  '@clerk/nextjs': { area: 'auth', value: 'Clerk' },
  '@clerk/clerk-sdk-node': { area: 'auth', value: 'Clerk' },
  'supertokens-node': { area: 'auth', value: 'SuperTokens' },
  '@workos-inc/node': { area: 'auth', value: 'WorkOS' },
  'keycloak-connect': { area: 'auth', value: 'Keycloak' },
  'python-keycloak': { area: 'auth', value: 'Keycloak' },
  auth0: { area: 'auth', value: 'Auth0' },
  'express-jwt': { area: 'auth', value: 'JWT' },
  jsonwebtoken: { area: 'auth', value: 'JWT' },
  jose: { area: 'auth', value: 'JWT' },
  authlib: { area: 'auth', value: 'Authlib' },

  // ── payments ──────────────────────────────────────────────────────────────
  stripe: { area: 'payments', value: 'Stripe' },
  '@stripe/stripe-js': { area: 'payments', value: 'Stripe' },
  braintree: { area: 'payments', value: 'Braintree' },
  '@paddle/paddle-node-sdk': { area: 'payments', value: 'Paddle' },
  '@paypal/checkout-server-sdk': { area: 'payments', value: 'PayPal' },
  'async-stripe': { area: 'payments', value: 'Stripe' },

  // ── api ───────────────────────────────────────────────────────────────────
  express: { area: 'api', value: 'Express' },
  fastify: { area: 'api', value: 'Fastify' },
  hono: { area: 'api', value: 'Hono' },
  koa: { area: 'api', value: 'Koa' },
  '@nestjs/core': { area: 'api', value: 'NestJS' },
  '@trpc/server': { area: 'api', value: 'tRPC' },
  graphql: { area: 'api', value: 'GraphQL' },
  '@apollo/server': { area: 'api', value: 'Apollo GraphQL' },
  fastapi: { area: 'api', value: 'FastAPI' },
  flask: { area: 'api', value: 'Flask' },
  django: { area: 'api', value: 'Django' },
  starlette: { area: 'api', value: 'Starlette' },
  axum: { area: 'api', value: 'Axum' },
  'actix-web': { area: 'api', value: 'Actix Web' },
  rocket: { area: 'api', value: 'Rocket' },
  warp: { area: 'api', value: 'Warp' },
  tonic: { area: 'api', value: 'gRPC (tonic)' },
  'github.com/gin-gonic/gin': { area: 'api', value: 'Gin' },
  'github.com/labstack/echo': { area: 'api', value: 'Echo' },
  'github.com/gofiber/fiber': { area: 'api', value: 'Fiber' },

  // ── frontend ──────────────────────────────────────────────────────────────
  react: { area: 'frontend', value: 'React' },
  vue: { area: 'frontend', value: 'Vue' },
  svelte: { area: 'frontend', value: 'Svelte' },
  '@angular/core': { area: 'frontend', value: 'Angular' },
  'solid-js': { area: 'frontend', value: 'SolidJS' },
  preact: { area: 'frontend', value: 'Preact' },
  next: { area: 'frontend', value: 'Next.js' },
  nuxt: { area: 'frontend', value: 'Nuxt' },
  '@remix-run/react': { area: 'frontend', value: 'Remix' },
  astro: { area: 'frontend', value: 'Astro' },
  htmx: { area: 'frontend', value: 'htmx' },
  'htmx.org': { area: 'frontend', value: 'htmx' },
  tailwindcss: { area: 'frontend', value: 'Tailwind' },
  vite: { area: 'frontend', value: 'Vite' },
  webpack: { area: 'frontend', value: 'Webpack' },
  tauri: { area: 'frontend', value: 'Tauri' },
  '@tauri-apps/api': { area: 'frontend', value: 'Tauri' },
  electron: { area: 'frontend', value: 'Electron' },
  leptos: { area: 'frontend', value: 'Leptos' },
  dioxus: { area: 'frontend', value: 'Dioxus' },

  // ── testing ───────────────────────────────────────────────────────────────
  vitest: { area: 'testing', value: 'Vitest' },
  jest: { area: 'testing', value: 'Jest' },
  mocha: { area: 'testing', value: 'Mocha' },
  '@playwright/test': { area: 'testing', value: 'Playwright' },
  playwright: { area: 'testing', value: 'Playwright' },
  cypress: { area: 'testing', value: 'Cypress' },
  '@testing-library/react': { area: 'testing', value: 'Testing Library' },
  pytest: { area: 'testing', value: 'pytest' },
  unittest2: { area: 'testing', value: 'unittest' },
  rspec: { area: 'testing', value: 'RSpec' },
  phpunit: { area: 'testing', value: 'PHPUnit' },
  'phpunit/phpunit': { area: 'testing', value: 'PHPUnit' },
  proptest: { area: 'testing', value: 'proptest' },
  'github.com/stretchr/testify': { area: 'testing', value: 'testify' },

  // ── observability ─────────────────────────────────────────────────────────
  '@sentry/node': { area: 'observability', value: 'Sentry' },
  '@sentry/react': { area: 'observability', value: 'Sentry' },
  '@sentry/browser': { area: 'observability', value: 'Sentry' },
  'sentry-sdk': { area: 'observability', value: 'Sentry' },
  '@opentelemetry/sdk-node': { area: 'observability', value: 'OpenTelemetry' },
  '@opentelemetry/api': { area: 'observability', value: 'OpenTelemetry' },
  'opentelemetry-sdk': { area: 'observability', value: 'OpenTelemetry' },
  'opentelemetry-api': { area: 'observability', value: 'OpenTelemetry' },
  tracing: { area: 'observability', value: 'tracing' },
  'tracing-subscriber': { area: 'observability', value: 'tracing' },
  pino: { area: 'observability', value: 'pino' },
  winston: { area: 'observability', value: 'winston' },
  'prom-client': { area: 'observability', value: 'Prometheus' },
  'datadog-api-client': { area: 'observability', value: 'Datadog' },
  'dd-trace': { area: 'observability', value: 'Datadog' },

  // ── security ──────────────────────────────────────────────────────────────
  'node-vault': { area: 'security', value: 'HashiCorp Vault' },
  hvac: { area: 'security', value: 'HashiCorp Vault' },
  helmet: { area: 'security', value: 'helmet' },
  bcrypt: { area: 'security', value: 'bcrypt' },
  argon2: { area: 'security', value: 'argon2' },
};

/** Manifest basenames worth opening, by how their dependencies are written. */
const MANIFEST_KIND: Record<string, 'json' | 'toml' | 'lines' | 'gomod' | 'gemfile'> = {
  'package.json': 'json',
  'composer.json': 'json',
  'cargo.toml': 'toml',
  'pyproject.toml': 'toml',
  'requirements.txt': 'lines',
  'go.mod': 'gomod',
  'gemfile': 'gemfile',
};

/** Every manifest name this detector understands, for a caller that collects files. */
export const MANIFEST_NAMES: readonly string[] = Object.keys(MANIFEST_KIND);

/** True when a path is a manifest the detector reads. */
export function isManifest(path: string): boolean {
  return !!MANIFEST_KIND[basename(path).toLowerCase()];
}

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p;
}

/**
 * Reduce a dependency token to the key the table is written in.
 *
 * Go module paths keep their full path where the table lists one and otherwise
 * fall back to the last segment, because `github.com/owner/gin` and `gin` are
 * the same dependency and only one of them is worth listing twice.
 */
function lookup(raw: string): { area: DecisionArea; value: string } | null {
  const name = raw.trim().toLowerCase().replace(/_/g, '_');
  if (!name) return null;
  const direct = PACKAGE_STACK[name];
  if (direct) return direct;

  // A versioned go module path: `github.com/owner/pkg/v5`.
  if (name.includes('/')) {
    const noVersion = name.replace(/\/v\d+$/, '');
    if (PACKAGE_STACK[noVersion]) return PACKAGE_STACK[noVersion];
    const tail = noVersion.split('/').filter(Boolean).pop();
    // Only an unscoped tail: `@scope/name` must not match bare `name`, or
    // `@acme/react` — somebody's internal fork — reads as React.
    if (tail && !name.startsWith('@') && PACKAGE_STACK[tail]) return PACKAGE_STACK[tail];
  }
  return null;
}

/**
 * The 1-based line a dependency sits on.
 *
 * Bare containment is the last resort, not the first: `"vite"` is a substring of
 * a package called `vite-plugin-example`, and pointing a reader at the wrong
 * line is the same as pointing them nowhere. A quoted token, then a line that
 * assigns it, then containment.
 */
function lineOf(content: string, token: string): number {
  const lines = content.split('\n');
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assigns = new RegExp(`^["']?${esc}["']?\\s*(?:[=:]|$|[<>!~;[]|\\s)`);

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`"${token}"`) || lines[i].includes(`'${token}'`)) return i + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    if (assigns.test(lines[i].trim())) return i + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(token)) return i + 1;
  }
  return 1;
}

/** Dependency names in a JSON manifest, from every dependency map it carries. */
function fromJson(content: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return []; }
  if (!parsed || typeof parsed !== 'object') return [];
  const o = parsed as Record<string, unknown>;
  const maps = [
    'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies',
    'require', 'require-dev',
  ];
  const out: string[] = [];
  for (const key of maps) {
    const m = o[key];
    if (m && typeof m === 'object' && !Array.isArray(m)) out.push(...Object.keys(m));
  }
  return out;
}

/**
 * Dependency names in a TOML manifest.
 *
 * A line scanner rather than a parser: the only shape that matters is a `name`
 * at the start of a line inside a dependency table, and every real Cargo.toml
 * and pyproject.toml writes it that way. A parser would add a dependency to
 * read dependencies.
 */
function fromToml(content: string): string[] {
  const out: string[] = [];
  /** The table header the scanner is inside, brackets stripped. */
  let table = '';
  /** Inside a `dependencies = [ … ]` list that has not closed yet. */
  let inList = false;

  /** `[dependencies]`, `[dev-dependencies]`, `[tool.poetry.dependencies]`. */
  const isDepTable = (t: string) => /(^|\.)((dev|build|optional)-)?dependencies$/.test(t);
  /** `[dependencies.serde]` names the dependency in its own header. */
  const nestedDep = (t: string) => t.match(/(?:^|\.)(?:(?:dev|build)-)?dependencies\.([A-Za-z0-9_.@/-]+)$/);
  /** Quoted requirement strings: "flask>=3", "psycopg[binary]", "pytest". */
  const fromList = (line: string) => {
    for (const q of line.matchAll(/["']([A-Za-z0-9_.-]+)(?:\s*[<>=!~;[][^"']*)?["']/g)) out.push(q[1]);
  };

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (inList) {
      fromList(line);
      if (line.includes(']')) inList = false;
      continue;
    }

    if (line.startsWith('[')) {
      const inner = line.replace(/^\[+/, '').replace(/\]+\s*$/, '');
      const nested = nestedDep(inner);
      if (nested) {
        out.push(nested[1]);
        // Its body is `version = …`, not more dependency names.
        table = '';
      } else {
        table = inner;
      }
      continue;
    }

    // A list of requirement strings. PEP 621 writes `dependencies = [...]`
    // under `[project]`, and an optional-dependencies table writes one list per
    // group. Anchored on the KEY: a Cargo dependency carries its own array in
    // `rusqlite = { version = "0.32", features = ["bundled"] }`, and reading
    // that as a list yields `bundled` and loses `rusqlite`.
    const listStart = line.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*=\s*\[/);
    if (listStart && (/dependencies$/i.test(listStart[1]) || /optional-dependencies$/.test(table))) {
      fromList(line);
      if (!line.includes(']')) inList = true;
      continue;
    }

    if (!isDepTable(table)) continue;
    // `name = "1.0"`, `name = { version = "1" }`, `name.workspace = true`.
    const m = line.match(/^["']?([A-Za-z0-9_.@/-]+)["']?(?:\.[A-Za-z0-9_-]+)?\s*=/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Dependency names in a requirements.txt. */
function fromLines(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Module paths in a go.mod. */
function fromGoMod(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('module ')) continue;
    const m = line.match(/^(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Gem names in a Gemfile. */
function fromGemfile(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) out.push(m[1]);
  return out;
}

/**
 * What a repository's manifests say about each area.
 *
 * Takes the files rather than a directory, so the mapping is testable without a
 * filesystem and the caller decides what a repository is — a monorepo hands
 * over several manifests and gets evidence from all of them.
 *
 * One result per (area, value): the same product named by three packages is one
 * piece of evidence, carrying the first place it was found. Results are ordered
 * by area so a caller's output does not move between runs.
 */
export function detectStack(files: ManifestFile[]): StackEvidence[] {
  const byKey = new Map<string, StackEvidence>();

  for (const file of files) {
    const kind = MANIFEST_KIND[basename(file.path).toLowerCase()];
    if (!kind || !file.content) continue;

    const names =
      kind === 'json' ? fromJson(file.content)
      : kind === 'toml' ? fromToml(file.content)
      : kind === 'lines' ? fromLines(file.content)
      : kind === 'gomod' ? fromGoMod(file.content)
      : fromGemfile(file.content);

    for (const name of names) {
      const hit = lookup(name);
      if (!hit) continue;
      const key = `${hit.area}\u0000${hit.value}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        area: hit.area,
        name,
        value: hit.value,
        file: file.path,
        line: lineOf(file.content, name),
      });
    }
  }

  return [...byKey.values()].sort((a, b) =>
    a.area.localeCompare(b.area) || a.value.localeCompare(b.value));
}

/**
 * The evidence for one area, as a sentence a register can hold as its reason.
 *
 * Names the file and the line, because a rationale a reader cannot check is
 * indistinguishable from one somebody made up.
 */
export function evidenceLine(e: StackEvidence): string {
  return `${e.name} in ${e.file}:${e.line}`;
}

/* ---------------------------------------------------------------------------
 * Reading them off a disk
 *
 * Everything above is pure — files in, evidence out — so the table and the
 * parsers are tested without a filesystem. This part is the one piece that
 * needs a real repository, and it runs where the repository is: on the
 * machine with the checkout, never on the server.
 * ------------------------------------------------------------------------- */

/** Directories that hold other people's manifests, never this repository's. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.venv', 'venv',
  '__pycache__', '.next', '.nuxt', 'coverage', '.cache', 'tmp', '.worktrees',
]);

/** A manifest bigger than this is generated or vendored, not hand-written. */
const MAX_MANIFEST_BYTES = 512 * 1024;

/**
 * Collect a repository's manifests, to a bounded depth.
 *
 * Depth 3 by default so a monorepo's `packages/<name>/package.json` and a Tauri
 * app's `src-tauri/Cargo.toml` are both reached, and a deep tree still costs a
 * bounded number of `readdir` calls.
 */
export function readManifests(
  root: string,
  opts: { maxDepth?: number; maxFiles?: number } = {},
): ManifestFile[] {
  const maxDepth = opts.maxDepth ?? 3;
  const maxFiles = opts.maxFiles ?? 40;
  const out: ManifestFile[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!MANIFEST_KIND[entry.name.toLowerCase()]) continue;
      try {
        if (fs.statSync(full).size > MAX_MANIFEST_BYTES) continue;
        out.push({
          path: path.relative(root, full).replace(/\\/g, '/'),
          content: fs.readFileSync(full, 'utf8'),
        });
      } catch { /* unreadable manifest — the rest of the repository still answers */ }
    }
  };

  walk(root, 0);
  return out;
}

/** The evidence a repository on disk gives, in one call. */
export function detectStackAt(root: string, opts?: { maxDepth?: number; maxFiles?: number }): StackEvidence[] {
  return detectStack(readManifests(root, opts));
}
