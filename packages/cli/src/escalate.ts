/**
 * `chat-recall escalate` — the WRITE half of the Context Engineering loop.
 *
 * The read half already exists: `chat-recall memory wake-up` (SessionStart
 * hook) injects prior knowledge into a new session. This module closes the
 * loop at the other end: at SessionEnd it extracts a finished session's
 * learnings and asserts them into the temporal knowledge graph, so the NEXT
 * wake-up already knows them. Three kinds of learning, three predicates:
 *
 *   - decisions the agent announced  → <project> → decided        → <text>
 *   - corrections the user gave      → <project> → user_corrected → <text>
 *   - how the session ended          → <project> → session_outcome → <status: reason>
 *
 * Sources: decisions + outcome come from the server's own outcome analyzer
 * (`GET /api/conversations/:id/outcome` — the same data recall_summary shows);
 * corrections are extracted client-side from the synced transcript
 * (`GET /api/conversations/:id?limit=0`) with the marker heuristics below.
 * Writes go through `POST /api/kg/add` — the same endpoint recall_kg_add and
 * recall_decision_record use — with `supersede: false` (learnings are
 * multi-valued: a project accumulates many decisions) and `origin: 'asserted'`
 * stamped server-side.
 *
 * Hook safety: this runs from a SessionEnd hook, so every "cannot proceed"
 * condition (not logged in, server down, session not synced yet) is a dim
 * note + a clean return — the CLI command exits 0. A hook must never break
 * session end.
 */

import { basename } from 'node:path';

// ── Wire types (subset of the server responses we read) ─────────────────────

export interface ConvoMessage {
  line?: number;
  role: string;
  content: string;
}

export interface SessionOutcome {
  status?: string;
  reason?: string;
  decisions?: Array<{ text: string }>;
}

export interface Learning {
  kind: 'decision' | 'correction' | 'outcome';
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

/** Minimal server access the runner needs — cli.ts passes its own helpers. */
export interface EscalateDeps {
  get<T>(path: string): Promise<T>;
  getSoft<T>(path: string): Promise<{ status: number; data: T | null; message?: string }>;
  post<T>(path: string, body: unknown): Promise<T>;
  /** Informational output (goes to stdout via the CLI's own styling). */
  log(line: string): void;
}

export interface EscalateOptions {
  /** Explicit session id; wins over `latest`. */
  sessionId?: string;
  /** Resolve the most recent synced session of the cwd's project. */
  latest?: boolean;
  /** KG entity name for the facts. Default: basename of the session's project path, then of cwd. */
  project?: string;
  /** Extract and print without writing. */
  dryRun?: boolean;
  cwd: string;
}

// ── Extraction heuristics ────────────────────────────────────────────────────

/**
 * A user message counts as a correction when it opens with a rejection /
 * redirection marker, or contains an explicit "you got it wrong" phrase.
 * Anchored-at-start patterns keep false positives low ("no" mid-sentence is
 * usually not a correction; "No, use the pooler" is).
 */
const CORRECTION_STARTS = [
  /^no+\b[,.! ]/i,
  /^(nope|wrong|incorrect|not quite|not right)\b/i,
  /^that'?s (wrong|not right|not it|not what)/i,
  /^(don'?t|do not|stop|undo|revert)\b/i,
  /^(actually|instead)[, ]/i,
  /^(why did you|you didn'?t|you did not|you forgot|you missed|you broke)\b/i,
];
const CORRECTION_CONTAINS = [
  /\bthat'?s not what i (asked|meant|wanted|said)\b/i,
  /\byou (misunderstood|misread|ignored my|shouldn'?t have)\b/i,
  /\bi (said|asked for|told you)\b.*\bnot\b/i,
];

/**
 * Transcript noise that must never be mined for corrections: slash-command
 * carriers, caveat banners, interrupt markers, and giant pastes.
 */
function isNoiseUserMessage(content: string): boolean {
  const c = content.trimStart();
  return (
    c.length === 0 ||
    c.length > 4000 ||
    c.startsWith('Caveat:') ||
    c.startsWith('[Request interrupted') ||
    c.includes('<command-name>') ||
    c.includes('<local-command') ||
    c.startsWith('<system-reminder>')
  );
}

/** Collapse whitespace and cut at a word boundary. */
export function clip(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + '…';
}

/**
 * Corrections the user gave, in transcript order. The FIRST user message is
 * skipped (the task statement cannot correct anything), noise carriers are
 * skipped, and the result is deduplicated and capped.
 */
export function extractCorrections(messages: ConvoMessage[], cap = 5): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let userTurns = 0;
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    userTurns++;
    if (userTurns === 1) continue; // the initial prompt is the task, not feedback
    if (isNoiseUserMessage(msg.content)) continue;
    const text = msg.content.trim();
    const hit =
      CORRECTION_STARTS.some((re) => re.test(text)) ||
      CORRECTION_CONTAINS.some((re) => re.test(text));
    if (!hit) continue;
    const clipped = clip(text);
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= cap) break;
  }
  return out;
}

/** Outcome statuses worth remembering. Transient/unknown states are not learnings. */
const TERMINAL_STATUSES = new Set(['shipped', 'interrupted', 'abandoned']);

/**
 * Assemble the full learning set for one session. Confidence 0.8 marks these
 * as auto-extracted — below a deliberate recall_decision_record (1.0), above
 * the KG's auto-mined guesses (0.5).
 */
export function extractLearnings(input: {
  project: string;
  messages: ConvoMessage[];
  outcome: SessionOutcome | null;
}): Learning[] {
  const learnings: Learning[] = [];
  const subject = input.project;

  for (const d of (input.outcome?.decisions ?? []).slice(0, 8)) {
    const text = clip(d.text);
    if (!text) continue;
    learnings.push({ kind: 'decision', subject, predicate: 'decided', object: text, confidence: 0.8 });
  }

  for (const c of extractCorrections(input.messages)) {
    learnings.push({ kind: 'correction', subject, predicate: 'user_corrected', object: c, confidence: 0.8 });
  }

  const status = input.outcome?.status;
  if (status && TERMINAL_STATUSES.has(status)) {
    const reason = input.outcome?.reason ? `: ${clip(input.outcome.reason, 140)}` : '';
    learnings.push({ kind: 'outcome', subject, predicate: 'session_outcome', object: `${status}${reason}`, confidence: 0.8 });
  }

  return learnings;
}

// ── Runner ───────────────────────────────────────────────────────────────────

interface RecentResponse {
  sessions: Array<{ sessionId: string; projectPath: string }>;
}
interface ConvoResponse {
  sessionId: string;
  messages: ConvoMessage[];
  total: number;
}
interface TimelineResponse {
  entries: Array<{ subject: string; predicate: string; object: string; current: boolean }>;
}

export interface EscalateResult {
  sessionId: string;
  written: number;
  skippedExisting: number;
  dryRun: boolean;
}

/**
 * Resolve → extract → dedup → write. Returns null when there is nothing to do
 * (not synced, no learnings) — the caller exits 0 either way.
 */
export async function runEscalate(deps: EscalateDeps, opts: EscalateOptions): Promise<EscalateResult | null> {
  // 1. Resolve the session id (+ the project entity name).
  let sessionId = opts.sessionId;
  let projectName = opts.project;

  if (!sessionId && opts.latest) {
    // The recent endpoint filters by LOGICAL project id (git:… / ws:…), the
    // same resolution every other cwd-scoped command uses.
    const { resolveProjectId } = await import('@chat-recall/engine/core/project-resolver.js');
    const resolved = resolveProjectId(opts.cwd);
    const pid = resolved && resolved.source !== 'ignored' ? resolved.id : '';
    const qs = new URLSearchParams({ limit: '1' });
    if (pid) qs.set('project', pid);
    const recent = await deps.get<RecentResponse>(`/api/conversations/recent?${qs.toString()}`);
    const row = recent.sessions?.[0];
    if (!row) {
      deps.log(`escalate: no synced session found for this project${pid ? ` (${pid})` : ''} — nothing to do.`);
      return null;
    }
    sessionId = row.sessionId;
    if (!projectName && row.projectPath) projectName = basename(row.projectPath);
  }
  if (!sessionId) throw new Error('pass a session id or --latest');
  if (!projectName) projectName = basename(opts.cwd);

  // 2. Fetch the transcript + the server-side outcome analysis.
  const convo = await deps.getSoft<ConvoResponse>(`/api/conversations/${encodeURIComponent(sessionId)}?limit=0`);
  if (!convo.data || convo.data.messages.length === 0) {
    deps.log(`escalate: session ${sessionId} not synced yet${convo.message ? ` (${convo.message})` : ''} — nothing to do.`);
    return null;
  }
  const outcomeSoft = await deps.getSoft<SessionOutcome>(`/api/conversations/${encodeURIComponent(sessionId)}/outcome`);
  const outcome = outcomeSoft.data;

  // 3. Extract.
  const learnings = extractLearnings({ project: projectName, messages: convo.data.messages, outcome });
  if (learnings.length === 0) {
    deps.log(`escalate: no learnings found in session ${sessionId.slice(0, 8)}… — nothing to escalate.`);
    return null;
  }

  // 4. Dedup against facts already in the graph, so a re-run (or a hook firing
  //    twice) does not double-write. The timeline lookup is best-effort: if it
  //    fails we still write (supersede:false tolerates rare duplicates).
  const existing = new Set<string>();
  try {
    const tl = await deps.get<TimelineResponse>(`/api/kg/timeline?entity=${encodeURIComponent(projectName)}&limit=500`);
    for (const e of tl.entries ?? []) {
      if (e.current) existing.add(`${e.predicate} ${e.object}`.toLowerCase());
    }
  } catch { /* best-effort */ }

  const fresh = learnings.filter((l) => !existing.has(`${l.predicate} ${l.object}`.toLowerCase()));
  const skippedExisting = learnings.length - fresh.length;

  // 5. Print (and in dry-run: stop here).
  for (const l of fresh) {
    deps.log(`  [${l.kind}] ${l.subject} → ${l.predicate} → ${l.object}`);
  }
  if (skippedExisting > 0) deps.log(`  (${skippedExisting} already in the knowledge graph — skipped)`);

  if (opts.dryRun) {
    deps.log(`escalate (dry-run): ${fresh.length} learning(s) extracted from ${sessionId.slice(0, 8)}… — nothing written.`);
    return { sessionId, written: 0, skippedExisting, dryRun: true };
  }

  // 6. Write each fresh learning as an asserted, session-attributed triple.
  let written = 0;
  for (const l of fresh) {
    await deps.post<{ id: string }>('/api/kg/add', {
      subject: l.subject,
      predicate: l.predicate,
      object: l.object,
      confidence: l.confidence,
      source_session: sessionId,
      // Learnings are multi-valued: a project accumulates decisions and
      // corrections. Without this, each write would supersede the previous
      // fact with the same (subject, predicate).
      supersede: false,
    });
    written++;
  }
  deps.log(`escalate: wrote ${written} learning(s) from session ${sessionId.slice(0, 8)}… to the knowledge graph.`);
  return { sessionId, written, skippedExisting, dryRun: false };
}
