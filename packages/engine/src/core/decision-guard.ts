/**
 * What is this tool call about to introduce?
 *
 * The decision register only becomes enforcement if something reads it BEFORE
 * the agent acts. A skill cannot do that — a skill is context, and an agent that
 * does not consult it proceeds unimpeded. Every tool chat-recall indexes has a
 * pre-execution hook that can, so this file answers the one question those hooks
 * need: which named things is this call adding to the codebase?
 *
 * ── Why only installs, imports and manifests ────────────────────────────────
 *
 * Prose is not a signal. "We could use Auth0" in a sentence must never stop
 * anything, or the guard becomes a thing people disable — and a disabled guard
 * protects nothing, which is worse than the honest absence of one.
 *
 * What IS a signal is a command or an edit that makes a dependency real:
 *
 *   npm install auth0 · pip install · cargo add · go get · gem install
 *   a new import/require/use line in an edit
 *   a name added to package.json, Cargo.toml, requirements.txt, go.mod
 *
 * Those three are close to unambiguous, and each is a moment where stopping is
 * still cheap. After the install it is a revert; before it, it is a sentence.
 *
 * ── What this file deliberately does NOT do ─────────────────────────────────
 *
 * It never decides. It extracts names; the server resolves them against the
 * register and returns a verdict. Putting the lookup here would mean every hook
 * carried its own copy of the cascade, and the whole point of resolving
 * server-side is that the answer cannot differ per caller.
 */

/** A tool call, flattened to the parts any of the five tools can supply. */
export interface GuardInput {
  /** The tool being invoked, in that harness's own vocabulary (Bash, Edit, …). */
  tool?: string | null;
  /** A shell command, when the call is one. */
  command?: string | null;
  /** Text being written or inserted — an edit's new content, a patch body. */
  content?: string | null;
  /** Path being written, so a manifest edit is recognisable as one. */
  path?: string | null;
}

export interface Introduced {
  /** Package or module names this call adds. Lowercased, de-duplicated. */
  names: string[];
  /** Which rule matched, for a message that can explain itself. */
  via: 'install' | 'import' | 'manifest' | null;
}

/**
 * Package managers whose install verb names packages positionally.
 *
 * Deliberately not exhaustive: a manager nobody here uses adds false-positive
 * surface for no benefit. Adding one is a line, and the tests name the shape.
 */
const INSTALL_PATTERNS: Array<{ re: RegExp; via: 'install' }> = [
  // npm/pnpm/yarn/bun. `add` and `install`, global or not.
  { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\b([^\n;&|]*)/gi, via: 'install' },
  // pip / pipx / uv
  { re: /\b(?:pip3?|pipx|uv\s+pip)\s+install\b([^\n;&|]*)/gi, via: 'install' },
  // cargo
  { re: /\bcargo\s+add\b([^\n;&|]*)/gi, via: 'install' },
  // go
  { re: /\bgo\s+get\b([^\n;&|]*)/gi, via: 'install' },
  // ruby
  { re: /\b(?:gem\s+install|bundle\s+add)\b([^\n;&|]*)/gi, via: 'install' },
  // php
  { re: /\bcomposer\s+require\b([^\n;&|]*)/gi, via: 'install' },
];

/** Flags and values that are not package names. */
const NOT_A_PACKAGE = new Set([
  '-g', '--global', '-d', '-D', '--save', '--save-dev', '--save-exact', '--dev',
  '-e', '--editable', '--user', '--upgrade', '-U', '--force', '-f', '--yes', '-y',
  '--prefix', '--no-save', '--legacy-peer-deps', '--frozen-lockfile', '-r',
  '--requirement', '--quiet', '-q', '--silent', '.', '..', '*',
]);

/** Manifest files where a new dependency line is as good as an install. */
const MANIFESTS = [
  'package.json', 'cargo.toml', 'requirements.txt', 'pyproject.toml',
  'go.mod', 'gemfile', 'composer.json', 'build.gradle', 'pom.xml',
];

/**
 * Reduce a raw token to a comparable package name.
 *
 * Strips a version specifier, a scope's leading @, quotes and trailing commas,
 * so `"@scope/keycloak-js@^3.1.0",` and `keycloak-js` compare equal. Returns
 * null for anything that is not name-shaped — a path, a URL, a flag's value.
 */
export function normaliseName(raw: string): string | null {
  let t = raw.trim().replace(/^["'`]|["'`,;]+$/g, '').trim();
  if (!t || NOT_A_PACKAGE.has(t)) return null;
  if (t.startsWith('-')) return null;
  // A local path or a URL is not a registry name.
  if (/^(?:\.{1,2}\/|\/|~\/|[a-z]+:\/\/)/i.test(t)) return null;
  if (/\.(?:tgz|tar\.gz|whl|zip)$/i.test(t)) return null;
  // Scoped npm: @scope/name → name, because a decision names the library, not
  // its publisher, and both spellings turn up in real transcripts.
  if (t.startsWith('@')) {
    const slash = t.indexOf('/');
    t = slash > 0 ? t.slice(slash + 1) : t.slice(1);
  }
  // Drop a version specifier: name@1.2.3, name==1.2.3, name>=1, name~=1
  t = t.split('@')[0];
  t = t.split(/[=<>~!^]/)[0];
  t = t.replace(/\[[^\]]*\]$/, ''); // pip extras: package[extra]
  t = t.trim().toLowerCase();
  if (!t || t.length < 2) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(t)) return null;
  return t;
}

/** Names introduced by a shell command's install verbs. */
function fromCommand(command: string): string[] {
  const out: string[] = [];
  for (const { re } of INSTALL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null) {
      for (const tok of (m[1] ?? '').split(/\s+/)) {
        const n = normaliseName(tok);
        if (n) out.push(n);
      }
    }
  }
  return out;
}

/**
 * Names introduced by new import lines.
 *
 * Matches the module SPECIFIER, not the binding, so `import Keycloak from
 * "keycloak-js"` yields keycloak-js. A relative specifier is skipped by
 * normaliseName — importing your own file decides nothing.
 */
const IMPORT_PATTERNS: RegExp[] = [
  /\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g,   // ES
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,                   // CJS
  // Python. The bare `import X` form must END there: without the anchor it also
  // matched the `import Keycloak` half of `import Keycloak from "keycloak-js"`,
  // so one JS line yielded both `keycloak` and `keycloak-js` and the guard
  // would have reported a library nobody named.
  /^\s*from\s+([\w.]+)\s+import\b/gm,
  /^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?\s*$/gm,
  /^\s*use\s+([a-z0-9_]+)\s*(?:::|;)/gmi,                      // Rust
];

function fromContent(content: string): string[] {
  const out: string[] = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      // Python and Rust give dotted/pathed roots; the first segment is the crate
      // or top-level package, which is what a decision names.
      const root = spec.split(/[./]/)[0];
      const n = normaliseName(spec.startsWith('@') ? spec : root);
      if (n) out.push(n);
    }
  }
  return out;
}

/** Bare names added to a dependency manifest. */
function fromManifest(content: string): string[] {
  const out: string[] = [];
  // JSON manifests: "name": "^1.0.0" — the key is the package. NOT anchored to
  // the line start: a one-line manifest edit is still a manifest edit, and this
  // only ever runs on a path already known to be one.
  for (const m of content.matchAll(/"([^"]+)"\s*:\s*"[^"]*"/g)) {
    const n = normaliseName(m[1]);
    if (n) out.push(n);
  }
  // TOML / requirements: name = "1.0" · name==1.0 · name
  for (const m of content.matchAll(/^\s*([A-Za-z][\w.-]*)\s*(?:=|==|>=|$)/gm)) {
    const n = normaliseName(m[1]);
    if (n) out.push(n);
  }
  return out;
}

const isManifest = (p: string | null | undefined): boolean => {
  if (!p) return false;
  const base = p.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return MANIFESTS.includes(base);
};

/**
 * Everything this call introduces, ready to check against the register.
 *
 * Empty means "nothing to check", which is the overwhelmingly common answer and
 * the reason this is cheap enough to run on every tool call.
 */
export function introducedBy(input: GuardInput): Introduced {
  const names = new Set<string>();
  let via: Introduced['via'] = null;

  if (input.command) {
    for (const n of fromCommand(input.command)) { names.add(n); via = 'install'; }
  }
  if (input.content) {
    if (isManifest(input.path)) {
      for (const n of fromManifest(input.content)) { names.add(n); via = via ?? 'manifest'; }
    }
    for (const n of fromContent(input.content)) { names.add(n); via = via ?? 'import'; }
  }
  return { names: [...names], via };
}
