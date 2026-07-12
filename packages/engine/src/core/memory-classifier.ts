/**
 * Memory Type Classifier — classifies text chunks into semantic types.
 *
 * Types: decision, preference, milestone, problem, discovery
 *
 * Pure regex/heuristic approach — no LLM. Because it's regexes, precision is
 * everything: a type label is only assigned when the text contains a STRONG
 * marker (an explicit multi-word phrasing of that type — "we decided to",
 * "i prefer", "root cause"). Topical single words ("architecture", "bug",
 * "fixed") are WEAK markers: they add supporting density to an established
 * type but can never assign one on their own. The first version of this file
 * let bare nouns like "approach"/"framework" mint importance-4 "decisions" —
 * confident numbers with no basis, surfaced as facts in recall_wake_up.
 *
 * importance (0-5) is an EVIDENCE-STRENGTH score, not a semantic judgement:
 *   ≥4 (the wake-up bar) requires explicit strong-marker evidence;
 *   weak-only text is always 'general' importance 1.
 */

// ── Types ────────────────────────────────────────────────────────

export type MemoryType = 'decision' | 'preference' | 'milestone' | 'problem' | 'discovery' | 'general';

/**
 * Bump this whenever the classifier's rules change. Chunks are stamped with the
 * version they were classified under; the reclassify sweep re-runs the current
 * classifier over anything below the current version so improvements reach
 * already-indexed data instead of only new syncs.
 */
export const CLASSIFIER_VERSION = 2;

const CLASSIFICATION_SUFFIX = /:(?:decision|preference|milestone|problem|discovery):imp[0-9]$/;

/**
 * Re-derive a chunk's classification tag under the CURRENT rules.
 *
 * Strips any existing `:type:impN` suffix to recover the base chunk_type
 * (e.g. `assistant`, `user_context`, `plan_section`), then re-applies the
 * classifier. Subagent transcripts and raw tool output are never classified,
 * so their chunk_type is returned unchanged. Idempotent — running it twice is
 * a no-op once the tag matches current rules.
 */
export function reclassifyChunkType(chunkType: string, text: string): string {
  const base = chunkType.replace(CLASSIFICATION_SUFFIX, '');
  if (base.startsWith('subagent') || base === 'tool_result') return chunkType;
  const cls = classifyChunk(text);
  return cls.memoryType !== 'general' ? `${base}:${cls.memoryType}:imp${cls.importance}` : base;
}

export interface ClassificationResult {
  memoryType: MemoryType;
  /** Evidence strength on a 0-5 scale (regex-derived; ≥4 needs explicit phrasing). */
  importance: number;
  confidence: number;  // 0-1
}

// ── Marker patterns per type ─────────────────────────────────────
// STRONG = explicit phrasing that on its own justifies the label.
// WEAK   = topical hint; only counts once a strong marker set the type.

// COMMITTED decisions — the user actually landed on something. These reach the
// wake-up bar (importance 4). "we chose Postgres", "decided to drop Redux".
const DECISION_COMMIT = [
  /\bwe\s+(?:decided|chose|went with|picked|settled on)\b/i,
  /\b(?:i'm|im|i am)\s+going\s+(?:to use|with)\b/i,
  /\bdecided\s+(?:to|on|against)\b/i,
  /\bwe(?:'ll| will)\s+(?:use|go with|stick with)\b/i,
  /\bchose\s+\S+\s+over\b/i,
];
// TENTATIVE decisions — a proposal in flight, not a landed call. Still tagged
// 'decision' so they're findable, but capped BELOW the wake-up bar (importance
// 3) so "we should rename this" / "let's try X" / "switch to branch main" never
// masquerade as high-importance decisions in recall_wake_up. Corroboration can
// still lift a tentative marker to 4 (that's a decision being argued, with
// substance behind it).
const DECISION_TENTATIVE = [
  /\b(?:let's|lets)\s+(?:use|go with|try|pick|choose|switch to)\b/i,
  /\bwe\s+should\b/i,
  /\bswitch(?:ed|ing)?\s+(?:to|from)\b/i,
];
const DECISION_STRONG = [...DECISION_COMMIT, ...DECISION_TENTATIVE];

// A committed decision only earns the wake-up tier (imp4) when it names a
// concrete OBJECT — otherwise "we decided to add a log line" (a chore) would
// rank as a high-importance decision. Two signals count as an object:
//   1. a known tech / `backtick` token / dotted-hyphenated identifier, or
//   2. a proper noun that is NOT sentence-initial (so "Redux"/"Zustand"/
//      "Postgres" count, but a sentence-leading "We"/"The" does not).
const DECISION_OBJECT_TECH = /`[^`]+`|\b\w+[._-]\w+|\b(postgres\w*|mysql|redis|sqlite|mongo\w*|dynamo\w*|react|next\w*|vue|svelte|angular|docker|k8s|kubernetes|rust|typescript|javascript|python|golang|express|fastapi|django|flask|rails|tailwind|zod|vite|webpack|esbuild|graphql|grpc|kafka|rabbitmq|terraform|ansible|nginx|caddy|pgvector|ollama|lancedb)\b/i;
// Capitalized words that are common sentence-starters/pronouns, not objects.
const DECISION_OBJECT_STOP = new Set([
  'i', 'we', 'the', 'this', 'that', 'it', 'let', 'our', 'my', 'a', 'an',
  'but', 'and', 'so', 'now', 'then', 'yes', 'no', 'please', 'here', 'there',
  'if', 'when', 'why', 'how', 'ok', 'okay',
]);
function hasDecisionObject(prose: string): boolean {
  if (DECISION_OBJECT_TECH.test(prose)) return true;
  // A capitalized token preceded by a lowercase char/comma → mid-sentence
  // proper noun (e.g. "…drop Redux", "use Zustand", "chose Postgres").
  const re = /[a-z0-9,)]\s+([A-Z][A-Za-z0-9.+_-]{2,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prose)) !== null) {
    if (!DECISION_OBJECT_STOP.has(m[1].toLowerCase())) return true;
  }
  return false;
}

const DECISION_WEAK = [
  /\binstead of\b/i,
  /\brather than\b/i,
  /\btrade-?off\b/i,
  /\bpros and cons\b/i,
  /\bbetter\s+(?:to|than|approach|option|choice)\b/i,
  /\barchitecture\b/i,
  /\bapproach\b/i,
  /\bstrategy\b/i,
  /\bpattern\b/i,
  /\bstack\b/i,
  /\bframework\b/i,
  /\bconfigure\b/i,
  /\bdefault\b/i,
];

const PREFERENCE_STRONG = [
  /\bi prefer\b/i,
  /\balways use\b/i,
  /\bnever use\b/i,
  /\bdon'?t\s+ever\s+(?:use|do|mock|stub|import)\b/i,
  /\bplease\s+(?:always|never|don'?t)\b/i,
  /\bmy\s+(?:rule|preference|style|convention)\s+is\b/i,
  /\bwe\s+(?:always|never)\b/i,
];

const PREFERENCE_WEAK = [
  /\bi (?:like|hate)\s+(?:to|when|how)\b/i,
  /\bdon'?t\s+(?:use|do|mock|stub|import)\b/i,
  /\bsnake_?case\b/i,
  /\bcamel_?case\b/i,
  /\buse\b.*\binstead of\b/i,
];

const MILESTONE_STRONG = [
  /\bit works\b/i,
  /\bgot it working\b/i,
  /\bbreakthrough\b/i,
  /\bfigured\s+(?:it\s+)?out\b/i,
  /\bnailed it\b/i,
  /\bshipped\b/i,
  /\blaunched\b/i,
  /\bdeployed\b/i,
  /\breleased\b/i,
  /\d+x\s+(?:compression|faster|slower|better|improvement|reduction)/i,
  /\d+%\s+(?:reduction|improvement|faster|better|smaller)/i,
];

const MILESTONE_WEAK = [
  /\bfixed\b/i,
  /\bsolved\b/i,
  /\bfinally\b/i,
  /\bfirst time\b/i,
  /\bdiscovered\b/i,
  /\brealized\b/i,
  /\bturns out\b/i,
  /\bthe key\s+(?:is|was|insight)\b/i,
  /\bthe trick\s+(?:is|was)\b/i,
  /\bbuilt\b/i,
  /\bcreated\b/i,
  /\bimplemented\b/i,
];

const PROBLEM_STRONG = [
  /\broot cause\b/i,
  /\bthe\s+(?:problem|issue|bug)\s+(?:is|was)\b/i,
  /\bthe fix\s+(?:is|was)\b/i,
  /\bkeeps?\s+(?:failing|crashing|breaking|erroring)\b/i,
  /\bdoesn'?t work\b/i,
  /\bnot working\b/i,
  /\bwon'?t\b.*\bwork\b/i,
];

const PROBLEM_WEAK = [
  /\b(?:bug|error|crash|fail|broke|broken|issue|problem)\b/i,
  /\bworkaround\b/i,
  /\bthat'?s why\b/i,
  /\bfixed\s+(?:it|the|by)\b/i,
  /\bsolution\s+(?:is|was)\b/i,
  /\bresolved\b/i,
  /\bpatched\b/i,
];

const DISCOVERY_STRONG = [
  /\bfound\s+(?:out|that)\b/i,
  /\bTIL\b/,
  /\blearned\s+that\b/i,
  /\bnow i (?:understand|see|get it)\b/i,
  /\bturned out\b/i,
  /\bsurprising\b/i,
  /\bunexpected\b/i,
];

const DISCOVERY_WEAK = [
  /\bdiscovered\b/i,
  /\bfigured out\b/i,
  /\brealized\b/i,
  /\bnoticed\b/i,
  /\binteresting\b/i,
];

const MARKERS: Record<Exclude<MemoryType, 'general'>, { strong: RegExp[]; weak: RegExp[] }> = {
  decision: { strong: DECISION_STRONG, weak: DECISION_WEAK },
  preference: { strong: PREFERENCE_STRONG, weak: PREFERENCE_WEAK },
  milestone: { strong: MILESTONE_STRONG, weak: MILESTONE_WEAK },
  problem: { strong: PROBLEM_STRONG, weak: PROBLEM_WEAK },
  discovery: { strong: DISCOVERY_STRONG, weak: DISCOVERY_WEAK },
};

// ── Resolution detection (problem → milestone disambiguation) ────

const RESOLUTION_PATTERNS = [
  /\bfixed\b/i,
  /\bsolved\b/i,
  /\bresolved\b/i,
  /\bgot it working\b/i,
  /\bit works\b/i,
  /\bnailed it\b/i,
  /\bfigured\s+(?:it\s+)?out\b/i,
  /\bthe\s+(?:fix|answer|solution)\b/i,
];

function hasResolution(text: string): boolean {
  return RESOLUTION_PATTERNS.some(p => p.test(text));
}

// ── Scoring ──────────────────────────────────────────────────────

function countMatches(text: string, markers: RegExp[]): number {
  let score = 0;
  for (const marker of markers) {
    const matches = text.match(new RegExp(marker.source, marker.flags + 'g'));
    if (matches) score += matches.length;
  }
  return score;
}

// ── Code line filtering ──────────────────────────────────────────

const CODE_LINE_PATTERNS = [
  /^\s*[$#]\s/,
  /^\s*(?:cd|source|echo|export|pip|npm|git|python|bash|curl|wget|mkdir|rm|cp|mv|ls|cat|grep|find|chmod|sudo|brew|docker)\s/,
  /^\s*```/,
  /^\s*(?:import|from|def|class|function|const|let|var|return)\s/,
  /^\s*[A-Z_]{2,}=/,
  /^\s*\|/,
  /^\s*[-]{2,}/,
  /^\s*[{}[\]]\s*$/,
  /^\s*(?:if|for|while|try|except|elif|else:)\b/,
];

function extractProse(text: string): string {
  const lines = text.split('\n');
  const prose: string[] = [];
  let inCode = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;

    const isCode = CODE_LINE_PATTERNS.some(p => p.test(line));
    if (!isCode) prose.push(line);
  }

  const result = prose.join('\n').trim();
  return result || text;
}

// ── Main classifier ──────────────────────────────────────────────

/**
 * Classify a text chunk into a memory type with an evidence-strength score.
 *
 * A type is assigned ONLY when a strong marker for it matches; weak markers
 * add density to a strong-established candidate but never assign a type by
 * themselves. Text with weak-only hints is 'general' (importance 1) — a
 * paragraph mentioning "architecture" and "framework" is a paragraph about
 * software, not a decision record.
 */
export function classifyChunk(text: string): ClassificationResult {
  const prose = extractProse(text);

  let bestType: MemoryType = 'general';
  let bestStrong = 0;
  let bestWeak = 0;
  let bestScore = 0;
  for (const [type, m] of Object.entries(MARKERS) as [Exclude<MemoryType, 'general'>, { strong: RegExp[]; weak: RegExp[] }][]) {
    const strong = countMatches(prose, m.strong);
    if (strong === 0) continue; // no explicit evidence → this type is not in play
    const weak = countMatches(prose, m.weak);
    // Strong evidence dominates; weak matches are half-weight support.
    const score = strong * 2 + weak * 0.5;
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
      bestStrong = strong;
      bestWeak = weak;
    }
  }

  if (bestType === 'general') {
    return { memoryType: 'general', importance: 1, confidence: 0 };
  }

  // Disambiguate: resolved problems read as milestones when milestone
  // evidence is also present.
  if (bestType === 'problem' && hasResolution(prose) && countMatches(prose, MILESTONE_STRONG) > 0) {
    bestType = 'milestone';
  }

  const confidence = Math.min(1.0, bestScore / 5.0);
  // A decision only earns the base-4 (wake-up) tier when it's COMMITTED phrasing
  // AND names a concrete object (CL3); tentative or object-less decisions stay
  // base-3 unless corroborated.
  const committed = bestType === 'decision'
    && countMatches(prose, DECISION_COMMIT) > 0
    && hasDecisionObject(prose);
  let importance = computeImportance(bestType, bestStrong, bestWeak, committed);
  // Hard-cap non-committed decisions at 3 so an object-less "we decided to …"
  // can't reach the wake-up bar via corroboration (overlapping decision markers
  // like "we decided" + "decided to" would otherwise double-count to imp4).
  if (bestType === 'decision' && !committed) importance = Math.min(importance, 3);

  return { memoryType: bestType, importance, confidence };
}

// ── Importance scoring ───────────────────────────────────────────

/**
 * Evidence-strength score (0-5). The ≥4 band — what recall_wake_up surfaces
 * as "high-importance facts" — is reachable only through explicit strong
 * evidence, never through topical-word density or text length (both of which
 * the original implementation counted, minting importance-5 "decisions" out
 * of ordinary engineering prose).
 *
 *   decision:   4 base (explicit "we chose/decided" is the highest-value
 *               memory the product captures), 5 with corroboration
 *   preference: 3 base, 4-5 with repeated/multiple explicit rules
 *   milestone/problem: 3 base, 4 with corroboration
 *   discovery:  2 base, 3 with corroboration
 *   general:    1
 */
function computeImportance(
  memoryType: MemoryType,
  strongMatches: number,
  weakMatches: number,
  decisionCommitted = false,
): number {
  const base: Record<MemoryType, number> = {
    // A committed decision ("we chose X") is the highest-value memory; a
    // tentative one ("we should", "let's try") is base-3 — below the wake-up
    // bar — so proposals-in-flight don't surface as settled facts.
    decision: decisionCommitted ? 4 : 3,
    preference: 3,
    milestone: 3,
    problem: 3,
    discovery: 2,
    general: 1,
  };

  let importance = base[memoryType];
  // Corroboration: multiple explicit markers, or one explicit marker backed
  // by substantial topical support.
  if (strongMatches >= 2 || (strongMatches >= 1 && weakMatches >= 3)) importance += 1;

  return Math.min(5, importance);
}
