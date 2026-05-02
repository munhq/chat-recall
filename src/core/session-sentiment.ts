/**
 * Sentiment & corrective-interrupt markers on user prompts.
 *
 * Pure heuristic (regex + token checks). The point isn't to do "real" sentiment
 * analysis — it's to surface the four signals that actually matter when
 * reviewing a session after the fact:
 *
 *   1. Was this prompt an interrupt? (the user hit ESC mid-response)
 *   2. Was the user frustrated? (caps, profanity, "wtf")
 *   3. Was this a course correction? (negating something the agent just did)
 *   4. Was this an approval? (green-lighting an agent proposal)
 *
 * These four together let "bad sessions" be spotted at a glance — frustration
 * + corrections clustered near the end is the signature of a session that
 * went sideways before the user gave up.
 */

export type PromptMarker =
  | 'interrupt'
  | 'frustrated'
  | 'correction'
  | 'approval'
  | 'question'
  | 'directive'
  | 'clarification_request';

export interface MarkedPrompt {
  text: string;
  markers: PromptMarker[];
  /** Confidence in [0,1] for the strongest signal — currently a coarse heuristic. */
  intensity: number;
}

const PROFANITY = /\b(fuck(?:ing|er|ed)?|shit|ffs|wtf|bullshit|crap|damn(?:it)?|hell)\b/i;
// "fuck" with typos common in chat: "fucj", "fukc", "fuking"
const PROFANITY_LOOSE = /\b(fu[ckj]+(?:ing|er|ed|c?k)?|fukc|fucj|sht|fk|wt[ft])\b/i;

const APPROVAL_HEAD = /^(?:yes|y|ok(?:ay)?|sure|alright|fine|i\s*approve|approved|go\s*(?:on|ahead)|do\s*it|continue|please\s*do|sounds?\s*good|let'?s\s*go|ship\s*it|👍|✓+)\b/i;
const NEG_HEAD = /^(?:no(?!t\b)|nope|stop|don'?t|never|wrong|incorrect|nah)\b/i;
const QUESTION_HEAD = /^(?:why|what|how|where|when|who|which|wdym|whats|wtf\s+is)\b/i;
const DIRECTIVE_HEAD = /^(?:please\s+)?(?:use|implement|build|make|add|create|fix|remove|delete|update|refactor|run|deploy|push|merge|test|check|investigate|find|search|show|list|generate|set\s+up|ensure)\b/i;
const CLARIFY_PHRASES = /\b(?:wdym|what do you mean|explain|clarify|what is|what's|huh\??|i don'?t understand)\b/i;
const FRUSTRATED_PHRASES = /\b(?:why (?:the )?(?:fuck|hell)|wtf|are you (?:kidding|serious)|stop slacking|stop making|why did you|why didn'?t you|i (?:fucking )?(?:asked|told you)|are you (?:listening|even)|come\s*on|just\s+do)\b/i;

function countAllCapsTokens(text: string): number {
  let n = 0;
  for (const tok of text.split(/\s+/)) {
    if (tok.length < 3) continue;
    if (/^[A-Z]{3,}[!?.,]?$/.test(tok)) n++;
  }
  return n;
}

function hasInterrupt(text: string): boolean {
  return /\[Request interrupted by user\]/.test(text)
    || /\[Request interrupted/i.test(text);
}

/**
 * Tag a single prompt. The text we expect here is *already* stripped of
 * injected status banners — leave the chunk-level cleaner upstream of us.
 */
export function markPrompt(text: string): MarkedPrompt {
  const markers: PromptMarker[] = [];
  let intensity = 0;
  const trimmed = text.trim();
  const head = trimmed.slice(0, 80);

  if (hasInterrupt(trimmed)) {
    markers.push('interrupt');
    intensity = Math.max(intensity, 1);
  }

  const profanity = PROFANITY.test(trimmed) || PROFANITY_LOOSE.test(trimmed);
  const allCapsTokens = countAllCapsTokens(trimmed);
  const frustratedPhrase = FRUSTRATED_PHRASES.test(trimmed);
  const exclamationRun = /!{2,}/.test(trimmed) || /\?{2,}/.test(trimmed);

  if (profanity || allCapsTokens >= 2 || frustratedPhrase || exclamationRun) {
    markers.push('frustrated');
    let f = 0.4;
    if (profanity) f += 0.4;
    if (allCapsTokens >= 2) f += 0.2;
    if (frustratedPhrase) f += 0.2;
    if (exclamationRun) f += 0.1;
    intensity = Math.max(intensity, Math.min(f, 1));
  }

  if (NEG_HEAD.test(head) || /\b(?:remove|undo|revert|that'?s wrong|not (?:that|like that)|don'?t do)\b/i.test(trimmed)) {
    markers.push('correction');
    intensity = Math.max(intensity, 0.7);
  }

  if (APPROVAL_HEAD.test(head)) {
    markers.push('approval');
    intensity = Math.max(intensity, 0.6);
  }

  if (QUESTION_HEAD.test(head) || trimmed.endsWith('?')) {
    markers.push('question');
    intensity = Math.max(intensity, 0.4);
  }

  if (CLARIFY_PHRASES.test(trimmed)) {
    markers.push('clarification_request');
    intensity = Math.max(intensity, 0.5);
  }

  if (DIRECTIVE_HEAD.test(head)) {
    markers.push('directive');
    intensity = Math.max(intensity, 0.5);
  }

  // Dedupe while preserving insertion order.
  const seen = new Set<PromptMarker>();
  const finalMarkers: PromptMarker[] = [];
  for (const m of markers) if (!seen.has(m)) { seen.add(m); finalMarkers.push(m); }

  return { text: trimmed, markers: finalMarkers, intensity };
}

/**
 * Aggregate counts across a session's prompts — useful for the conversation
 * list badge ("⏸ 3 · ⚠ 2") without having to re-mark on the client.
 */
export interface SessionMarkerCounts {
  total: number;
  interrupt: number;
  frustrated: number;
  correction: number;
  approval: number;
  question: number;
  directive: number;
  clarification_request: number;
  /** Highest-intensity marker seen, for at-a-glance triage. */
  peakIntensity: number;
}

export function summarizeMarkers(marked: MarkedPrompt[]): SessionMarkerCounts {
  const counts: SessionMarkerCounts = {
    total: marked.length,
    interrupt: 0, frustrated: 0, correction: 0, approval: 0,
    question: 0, directive: 0, clarification_request: 0,
    peakIntensity: 0,
  };
  for (const m of marked) {
    if (m.intensity > counts.peakIntensity) counts.peakIntensity = m.intensity;
    for (const marker of m.markers) {
      // narrowing the union — TS happy
      counts[marker]++;
    }
  }
  return counts;
}
