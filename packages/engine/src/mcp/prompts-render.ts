/**
 * Selection and text rendering for `recall_user_prompts`.
 *
 * The server returns a session's prompts in line order, oldest first. The tool
 * lists them newest first, so a `limit` keeps the latest ones. Each prompt
 * prints whole up to BODY_LIMIT; a longer one (a paste) prints its first and
 * last EDGE characters and the recall_show call that returns it whole.
 */
import { headTail } from './show-render.js';

export interface PromptRow {
  sessionId: string;
  line: number;
  /** Epoch ms of the prompt, when the transcript recorded one. */
  ts?: number;
  tsIso?: string;
  markers: string[];
  text: string;
}

export interface SelectPromptsOptions {
  limit: number;
  /** Keep only the prompts that contain this text, ignoring case and runs of whitespace. */
  query?: string;
}

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

/** Epoch ms of a prompt, or of its session when the prompt has none. */
function when(p: PromptRow, sessionMs: number): number {
  if (p.ts && p.ts > 0) return p.ts;
  const parsed = p.tsIso ? Date.parse(p.tsIso) : NaN;
  return Number.isFinite(parsed) ? parsed : sessionMs;
}

/** Newest first: by time, then by line inside one session. */
function newestFirst(a: { row: PromptRow; at: number }, b: { row: PromptRow; at: number }): number {
  if (b.at !== a.at) return b.at - a.at;
  if (a.row.sessionId === b.row.sessionId) return b.row.line - a.row.line;
  return 0;
}

function matching(rows: readonly PromptRow[], query?: string): PromptRow[] {
  const q = query ? fold(query.trim()) : '';
  return rows.filter(p => p.text && p.text.trim() && (!q || fold(p.text).includes(q)));
}

/** One session's prompts with text, newest first, filtered by `query`, at most `limit`. */
export function selectPrompts(rows: readonly PromptRow[], opts: SelectPromptsOptions): PromptRow[] {
  return matching(rows, opts.query)
    .map(row => ({ row, at: when(row, 0) }))
    .sort(newestFirst)
    .slice(0, Math.max(0, opts.limit))
    .map(x => x.row);
}

export interface FeedSession {
  sessionId: string;
  /** Epoch ms of the session's last write. The feed is ordered by it, newest first. */
  modifiedMs: number;
}

/**
 * The newest `limit` prompts across sessions, newest first.
 *
 * Sessions overlap in time, so the first session's prompts are not all newer
 * than the second's. The loop reads sessions in feed order and stops only when
 * it holds `limit` prompts and the next session's last write is older than the
 * oldest of them: no prompt in that session, or in any after it, can be newer.
 */
export async function collectAcrossSessions(
  feed: readonly FeedSession[],
  fetchPrompts: (sessionId: string) => Promise<PromptRow[] | null>,
  opts: SelectPromptsOptions,
): Promise<PromptRow[]> {
  const limit = Math.max(0, opts.limit);
  let kept: Array<{ row: PromptRow; at: number }> = [];
  for (const s of feed) {
    if (kept.length >= limit && s.modifiedMs < kept[kept.length - 1].at) break;
    const rows = await fetchPrompts(s.sessionId);
    if (!rows) continue;
    for (const row of matching(rows, opts.query)) kept.push({ row, at: when(row, s.modifiedMs) });
    kept = kept.sort(newestFirst).slice(0, limit);
  }
  return kept.map(x => x.row);
}

export interface RenderPromptsOptions {
  withMarkers: boolean;
  query?: string;
}

export function renderPrompts(rows: readonly PromptRow[], opts: RenderPromptsOptions): string {
  const what = opts.query ? `, containing "${opts.query.trim()}"` : '';
  const lines = [`# User prompts (${rows.length}${what}, newest first)\n`];
  for (const p of rows) {
    const t = p.tsIso?.slice(0, 16).replace('T', ' ') || '';
    const markerSuffix = opts.withMarkers && p.markers.length ? ` _[${p.markers.join(', ')}]_` : '';
    lines.push(`- **${p.sessionId}** L${p.line}${t ? ` · ${t}` : ''}${markerSuffix}`);
    const how = `Call recall_show with session_id "${p.sessionId}" and expand_line ${p.line} for the whole text.`;
    for (const part of headTail(p.text, how)) {
      lines.push(part.split('\n').map(l => `  ${l}`).join('\n'));
    }
  }
  return lines.join('\n');
}
