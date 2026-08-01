#!/usr/bin/env node
/**
 * Regenerate packages/server/src/services/builtin-rulepack.ts from gitleaks'
 * MIT rule corpus.
 *
 *   node scripts/gen-builtin-rulepack.mjs [--version v8.30.1]
 *
 * Why a generator and not a hand-written list: the value of the pack is that it
 * can be re-ported when upstream adds vendor shapes, and every selection
 * decision below is then re-applied identically instead of being re-argued.
 *
 * Selection, in order:
 *
 *  1. ANCHORED ONLY. A rule must carry a literal vendor marker (>=4 literal
 *     chars outside a character class). gitleaks' entropy-gated generic rules
 *     are dropped wholesale: without its Shannon-entropy thresholds and
 *     per-rule allowlists they match ordinary tokens, and a false positive in a
 *     REDACTOR does not produce a noisy report — it silently destroys the
 *     user's own content.
 *
 *  2. RE2 → JavaScript. gitleaks regexes are RE2; a leading `(?i)` becomes a
 *     flag. Anything using inline flag groups mid-pattern, POSIX classes or
 *     Unicode script classes is refused rather than mistranslated.
 *
 *  3. STRIP THE LEADING `[\w.-]{0,50}?`. This is a performance requirement, not
 *     cosmetics. RE2 is linear; JavaScript backtracks, and that lazy prefix
 *     forces a match attempt at every position. Measured on a 2.1MB real
 *     transcript, 75 rules:
 *         builtins only ............................  62ms   (34 MB/s)
 *         + pack, as written upstream .............. 3732ms  ( 0.6 MB/s)  60x
 *         + pack, leading prefix stripped ..........  123ms  ( 17 MB/s)   2x
 *     Redaction runs on every chunk of every sync, so 0.6 MB/s is not
 *     shippable. The prefix exists only so gitleaks can REPORT the variable
 *     name next to the secret; removing it cannot lose a detection — the
 *     remainder of the pattern is untouched, so every occurrence still matches,
 *     just starting at the vendor literal instead of up to 50 chars earlier.
 *
 *  4. EXCLUDE by hand, with reasons (see EXCLUDE below): public identifiers,
 *     patterns too broad for chat text, and duplicates of an equal-or-broader
 *     compiled-in builtin.
 *
 * trufflehog is deliberately not a source here: AGPL-3.0. We may invoke it; we
 * may not port its detectors into the product.
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'packages', 'server', 'src', 'services', 'builtin-rulepack.ts');

const versionArg = process.argv.indexOf('--version');
const GITLEAKS_VERSION = versionArg > -1 ? process.argv[versionArg + 1] : 'v8.30.1';
const SRC_URL = `https://raw.githubusercontent.com/gitleaks/gitleaks/${GITLEAKS_VERSION}/config/gitleaks.toml`;

/**
 * Rules we deliberately do NOT ship, with the reason. A scanner and a redactor
 * want different things: gitleaks reports anything credential-adjacent, but a
 * rule here REPLACES text in the customer's own searchable history.
 */
const EXCLUDE = {
  // Over-broad on chat text: fires on any Kubernetes manifest with a `data:`
  // block, which in an AI coding session means every helm/kustomize paste.
  'kubernetes-secret-yaml': 'matches any k8s manifest data: block — shreds ordinary config pastes',

  // Public identifiers, not credentials. Redacting them destroys context and
  // prevents nothing: a client id / publishable key is meant to be seen.
  'asana-client-id': 'public identifier, not a credential',
  'bitbucket-client-id': 'public identifier, not a credential',
  'looker-client-id': 'public identifier, not a credential',
  'messagebird-client-id': 'public identifier, not a credential',
  'sendbird-access-id': 'public identifier, not a credential',
  'new-relic-user-api-id': 'public identifier, not a credential',
  'new-relic-browser-api-token': 'shipped in browser bundles — public by design',
  'mailgun-pub-key': 'publishable key — public by design',
  'lob-pub-api-key': 'publishable key — public by design',

  // Already covered by an equal-or-broader builtin in secret-redactor.ts.
  'private-key': 'covered by builtin private-key',
  'anthropic-api-key': 'covered by builtin anthropic-key (broader)',
};

function unquote(s) {
  s = s.trim();
  if (s.startsWith("'''") && s.endsWith("'''")) return s.slice(3, -3);
  if (s.startsWith('"""') && s.endsWith('"""')) return s.slice(3, -3);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  if (s.startsWith('"') && s.endsWith('"')) return JSON.parse(s);
  return s;
}

/** Go RE2 → JavaScript. Returns null for anything we will not translate blind. */
function toJs(goRe) {
  let flags = '';
  let src = goRe;
  const inline = src.match(/^\(\?([ims]+)\)/);
  if (inline) { flags = inline[1]; src = src.slice(inline[0].length); }
  if (/\(\?[ims]+\)/.test(src)) return null;       // scoped inline flags differ from JS
  // RE2 flag-scoping groups: `(?-i:A)` (turn a flag OFF for a subexpression) and
  // `(?i:...)`. JavaScript has no such construct and throws "Invalid group" at
  // compile time. telegram-bot-api-token shipped through this hole once — it
  // reached production and was silently dropped by every consumer, which is the
  // exact "coverage you don't actually have" failure the pack is supposed to
  // make impossible.
  if (/\(\?[a-z]*-[a-z]+[:)]|\(\?[ims]+:/.test(src)) return null;
  if (/\\p\{|\[\[:/.test(src)) return null;        // Unicode script / POSIX classes
  return { src, flags };
}

/** Longest literal run outside a character class — our proxy for "anchored". */
function anchorScore(src) {
  const stripped = src.replace(/\[(?:[^\]\\]|\\.)*\]/g, '·').replace(/\\[dwsSWD]/g, '·');
  return (stripped.match(/[A-Za-z0-9_-]{3,}/g) || []).reduce((m, l) => Math.max(m, l.length), 0);
}

const res = await fetch(SRC_URL);
if (!res.ok) throw new Error(`could not fetch ${SRC_URL}: ${res.status}`);
const toml = await res.text();

const parsed = [];
for (const b of toml.split(/^\[\[rules\]\]$/m).slice(1)) {
  const head = b.split(/^\[rules\./m)[0];   // stop before allowlist sub-tables
  const id = head.match(/^\s*id\s*=\s*(.+)$/m);
  const re = head.match(/^\s*regex\s*=\s*(.+)$/m);
  if (!id || !re) continue;
  const entropy = head.match(/^\s*entropy\s*=\s*([\d.]+)/m);
  parsed.push({
    id: unquote(id[1]),
    regex: unquote(re[1]),
    entropy: entropy ? parseFloat(entropy[1]) : null,
  });
}

const kept = [];
const dropped = { entropy: 0, untranslatable: 0, weakAnchor: 0, excluded: 0 };
for (const r of parsed) {
  if (r.id in EXCLUDE) { dropped.excluded++; continue; }
  if (r.entropy !== null) { dropped.entropy++; continue; }
  const js = toJs(r.regex);
  if (!js) { dropped.untranslatable++; continue; }
  if (anchorScore(js.src) < 4) { dropped.weakAnchor++; continue; }
  // See (3) above — performance, detection-preserving.
  const src = js.src.replace(/^\[\\w\.-\]\{0,50\}\?/, '');
  kept.push({ id: r.id, regex: src, flags: js.flags });
}
kept.sort((a, b) => a.id.localeCompare(b.id));

const severityFor = (id) => (/(secret|private)/.test(id) ? 'high' : 'medium');
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const body = kept.map((c) =>
  `  { name: '${c.id}', regex: '${esc(c.regex)}'${c.flags ? `, flags: '${c.flags}'` : ''}, severity: '${severityFor(c.id)}' },`,
).join('\n');

const excludedDoc = Object.entries(EXCLUDE)
  .map(([id, why]) => ` *   ${id.padEnd(30)} ${why}`).join('\n');

const out = `/**
 * The curated redaction rule pack chat-recall ships to every tenant.
 *
 * GENERATED FILE — regenerate with \`node scripts/gen-builtin-rulepack.mjs\`.
 * Do not hand-edit the rule list; change the generator's selection rules instead.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * Detection has to run on the CLIENT: the server only ever receives text that
 * has already been redacted, so it cannot find what the client missed. But the
 * RULES do not have to ship with the client. They are served from here, pulled
 * at the start of every sync, and compiled in-process — so a shape discovered
 * on a Tuesday protects every customer on that Tuesday, with no CLI release, no
 * install, and no dependence on what the user happens to have on their PATH.
 *
 * Until this existed the mechanism was real but empty: a fresh tenant's rule
 * pack was literally \`version: "empty"\`, and improving coverage meant asking
 * each customer to hand-write regex in the dashboard. That is not a product.
 *
 * ── Provenance ───────────────────────────────────────────────────────────
 * Ported from the gitleaks default rule corpus (${GITLEAKS_VERSION}, MIT,
 * Copyright (c) 2019 Zachary Rice — https://github.com/gitleaks/gitleaks).
 * Upstream rule ids are preserved so \`pack:twitter-api-key\` can be looked up
 * against the upstream definition. MIT permits this; trufflehog's detectors are
 * AGPL-3.0 and are deliberately NOT represented here.
 *
 * Only VENDOR-ANCHORED rules were taken. gitleaks' entropy-gated generic rules
 * (${dropped.entropy} of them) were dropped wholesale: without its Shannon-entropy
 * thresholds and per-rule allowlists they match ordinary tokens, and a false
 * positive in a redactor does not produce a noisy report — it silently destroys
 * the user's own content.
 *
 * Each pattern also has gitleaks' leading \`[\\w.-]{0,50}?\` removed. RE2 is
 * linear; JavaScript backtracks, and that lazy prefix forces a match attempt at
 * every position — measured at 60x the builtin cost (0.6 MB/s) with it, 2x
 * (17 MB/s) without, on a 2.1MB real transcript. It only existed so gitleaks
 * could report the variable name beside the secret; removing it cannot lose a
 * detection.
 *
 * Also excluded, deliberately:
${excludedDoc}
 *
 * ── Contract ─────────────────────────────────────────────────────────────
 * ADD-ONLY relative to the client's compiled-in builtins: a pack can make a
 * client redact more, never less (see installServerRulePack). Every rule is
 * validated on both ends — here at serve time, and again on the client, which
 * drops any individual rule that fails and logs it.
 */

import { validateRedactionRule } from '@chat-recall/engine/core/secret-redactor.js';
import { createHash } from 'node:crypto';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('builtin-rulepack');

export interface BuiltinPackRule {
  name: string;
  regex: string;
  flags?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

/** Human-readable revision of this list. The wire version clients see is a
 *  content hash that also folds in the tenant's own redact rules. */
export const BUILTIN_RULEPACK_REVISION = '${new Date().toISOString().slice(0, 10)}';

/** Upstream corpus this was ported from — for attribution, and for diffing on
 *  the next re-port. */
export const BUILTIN_RULEPACK_SOURCE = 'gitleaks ${GITLEAKS_VERSION} (MIT)';

const RULES: BuiltinPackRule[] = [
${body}
];

/** The list as generated, BEFORE serve-time validation. Exposed so a test can
 *  assert that validation drops nothing: comparing against the filtered list
 *  would be a tautology, and that is precisely how a rule using RE2-only syntax
 *  once reached production and was dropped by every consumer. */
export function _rawBuiltinPackRules(): BuiltinPackRule[] { return RULES; }

let validated: BuiltinPackRule[] | null = null;

/**
 * The pack as served — every rule re-validated through the SAME check the
 * client applies. A rule that the client would drop must not be advertised
 * here: that reads as coverage the operator does not actually have. A rejection
 * is logged at error level because it means this file is wrong.
 */
export function builtinPackRules(): BuiltinPackRule[] {
  if (validated) return validated;
  const ok: BuiltinPackRule[] = [];
  for (const r of RULES) {
    const v = validateRedactionRule({ name: r.name, regex: r.regex, flags: r.flags });
    if (v.ok) ok.push(r);
    else log.error({ rule: r.name, reason: v.reason }, 'builtin pack rule rejected — it will not be served');
  }
  validated = ok;
  return ok;
}

/** Content hash of the served pack, so a client can skip an unchanged pack and
 *  an operator can answer "which rules was that device running?". */
export function builtinPackHash(): string {
  const material = builtinPackRules()
    .map((r) => \`\${r.name} \${r.regex} \${r.flags || ''}\`)
    .sort()
    .join('\\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

/** Test seam. */
export function _resetBuiltinPackCache(): void { validated = null; }
`;

writeFileSync(OUT, out);
console.log(`wrote ${kept.length} rules to ${OUT}`);
console.log(`  dropped: ${dropped.entropy} entropy-gated, ${dropped.untranslatable} untranslatable, ` +
            `${dropped.weakAnchor} weakly anchored, ${dropped.excluded} excluded by hand`);
