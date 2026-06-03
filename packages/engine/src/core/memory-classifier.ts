/**
 * Memory Type Classifier — classifies text chunks into semantic types.
 *
 * Types: decision, preference, milestone, problem, discovery
 *
 * Pure regex/heuristic approach — no LLM needed.
 * Inspired by MemPalace's general_extractor but adapted for our chunk pipeline.
 */

// ── Types ────────────────────────────────────────────────────────

export type MemoryType = 'decision' | 'preference' | 'milestone' | 'problem' | 'discovery' | 'general';

export interface ClassificationResult {
  memoryType: MemoryType;
  importance: number;  // 0-5 scale
  confidence: number;  // 0-1
}

// ── Marker patterns per type ─────────────────────────────────────

const DECISION_MARKERS = [
  /\b(?:let's|lets)\s+(?:use|go with|try|pick|choose|switch to)\b/i,
  /\bwe\s+(?:should|decided|chose|went with|picked|settled on)\b/i,
  /\b(?:i'm|im) going (?:to|with)\b/i,
  /\bbetter\s+(?:to|than|approach|option|choice)\b/i,
  /\binstead of\b/i,
  /\brather than\b/i,
  /\btrade-?off\b/i,
  /\bpros and cons\b/i,
  /\barchitecture\b/i,
  /\bapproach\b/i,
  /\bstrategy\b/i,
  /\bpattern\b/i,
  /\bstack\b/i,
  /\bframework\b/i,
  /\bconfigure\b/i,
  /\bdefault\b/i,
];

const PREFERENCE_MARKERS = [
  /\bi prefer\b/i,
  /\balways use\b/i,
  /\bnever use\b/i,
  /\bdon'?t\s+(?:ever\s+)?(?:use|do|mock|stub|import)\b/i,
  /\bi (?:like|hate)\s+(?:to|when|how)\b/i,
  /\bplease\s+(?:always|never|don'?t)\b/i,
  /\bmy\s+(?:rule|preference|style|convention)\s+is\b/i,
  /\bwe\s+(?:always|never)\b/i,
  /\bsnake_?case\b/i,
  /\bcamel_?case\b/i,
  /\buse\b.*\binstead of\b/i,
];

const MILESTONE_MARKERS = [
  /\bit works\b/i,
  /\bgot it working\b/i,
  /\bfixed\b/i,
  /\bsolved\b/i,
  /\bbreakthrough\b/i,
  /\bfigured\s+(?:it\s+)?out\b/i,
  /\bnailed it\b/i,
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
  /\bshipped\b/i,
  /\blaunched\b/i,
  /\bdeployed\b/i,
  /\breleased\b/i,
  /\d+x\s+(?:compression|faster|slower|better|improvement|reduction)/i,
  /\d+%\s+(?:reduction|improvement|faster|better|smaller)/i,
];

const PROBLEM_MARKERS = [
  /\b(?:bug|error|crash|fail|broke|broken|issue|problem)\b/i,
  /\bdoesn'?t work\b/i,
  /\bnot working\b/i,
  /\bwon'?t\b.*\bwork\b/i,
  /\bkeeps?\s+(?:failing|crashing|breaking|erroring)\b/i,
  /\broot cause\b/i,
  /\bthe\s+(?:problem|issue|bug)\s+(?:is|was)\b/i,
  /\bthe fix\s+(?:is|was)\b/i,
  /\bworkaround\b/i,
  /\bthat'?s why\b/i,
  /\bfixed\s+(?:it|the|by)\b/i,
  /\bsolution\s+(?:is|was)\b/i,
  /\bresolved\b/i,
  /\bpatched\b/i,
];

const DISCOVERY_MARKERS = [
  /\bfound\s+(?:out|that)\b/i,
  /\bdiscovered\b/i,
  /\bfigured out\b/i,
  /\brealized\b/i,
  /\bnoticed\b/i,
  /\bturned out\b/i,
  /\binteresting\b/i,
  /\bsurprising\b/i,
  /\bunexpected\b/i,
  /\bTIL\b/,
  /\blearned\s+that\b/i,
  /\bnow i (?:understand|see|get it)\b/i,
];

const ALL_MARKERS: Record<MemoryType, RegExp[]> = {
  decision: DECISION_MARKERS,
  preference: PREFERENCE_MARKERS,
  milestone: MILESTONE_MARKERS,
  problem: PROBLEM_MARKERS,
  discovery: DISCOVERY_MARKERS,
  general: [],
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

function scoreMarkers(text: string, markers: RegExp[]): number {
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
 * Classify a text chunk into a memory type with importance score.
 *
 * Returns the best matching type, confidence, and importance (0-5).
 */
export function classifyChunk(text: string): ClassificationResult {
  const prose = extractProse(text);

  // Score against all types
  const scores: Partial<Record<MemoryType, number>> = {};
  for (const [type, markers] of Object.entries(ALL_MARKERS) as [MemoryType, RegExp[]][]) {
    if (markers.length === 0) continue;
    const score = scoreMarkers(prose, markers);
    if (score > 0) scores[type] = score;
  }

  if (Object.keys(scores).length === 0) {
    return { memoryType: 'general', importance: 1, confidence: 0 };
  }

  // Length bonus
  let lengthBonus = 0;
  if (text.length > 500) lengthBonus = 2;
  else if (text.length > 200) lengthBonus = 1;

  // Find best type
  let bestType: MemoryType = 'general';
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores) as [MemoryType, number][]) {
    const adjusted = score + lengthBonus;
    if (adjusted > bestScore) {
      bestScore = adjusted;
      bestType = type;
    }
  }

  // Disambiguate: resolved problems are milestones
  if (bestType === 'problem' && hasResolution(prose)) {
    if (scores.milestone && scores.milestone > 0) {
      bestType = 'milestone';
    }
  }

  const confidence = Math.min(1.0, bestScore / 5.0);

  // Importance scoring (0-5)
  const importance = computeImportance(bestType, bestScore, text);

  return { memoryType: bestType, importance, confidence };
}

// ── Importance scoring ───────────────────────────────────────────

/**
 * Compute importance score (0-5) based on memory type, marker density,
 * and content characteristics.
 *
 * Priority order: decisions (4-5) > milestones (3-5) > problems (3-4)
 * > preferences (3-4) > discoveries (2-4) > general (1)
 */
function computeImportance(
  memoryType: MemoryType,
  markerScore: number,
  text: string
): number {
  const baseScores: Record<MemoryType, number> = {
    decision: 4,
    preference: 3,
    milestone: 3,
    problem: 3,
    discovery: 2,
    general: 1,
  };

  let importance = baseScores[memoryType];

  // Density bonus: more markers = more important
  if (markerScore >= 5) importance += 1;
  else if (markerScore >= 3) importance += 0.5;

  // Length bonus: longer content that matched = more substance
  if (text.length > 500) importance += 0.5;

  // Cap at 5
  return Math.min(5, Math.round(importance));
}
