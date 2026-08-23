/**
 * Single source of truth for the AI tools chat-recall tracks.
 *
 * Every component that renders a tool list — sidebar source filter,
 * conversation row rail/label, toolkit explorer, activity timeline,
 * analytics, settings — imports from here. Adding a new tool means
 * adding one entry to `TOOLS` (and a CSS `--cr-tool-<id>` pair in
 * index.css); no component edits needed.
 *
 * Order in this array = order in the sidebar. Antigravity (agy) sits
 * above Gemini because agy is Google's current agentic tool; Gemini
 * CLI is kept for legacy sessions but demoted.
 */

export type ToolId = 'claude' | 'agy' | 'gemini' | 'opencode' | 'codex' | 'cursor';

export interface ToolDef {
  id: ToolId;
  /** Human-readable name shown in the sidebar, badges, analytics. */
  label: string;
  /** CSS var for the tool's accent color (rail, dot, badge fg). */
  color: string;
  /** CSS var for the tool's surface tint (badge background). */
  surf: string;
  /** Primitives icon name. */
  icon: string;
}

export const TOOLS: ToolDef[] = [
  { id: 'claude',   label: 'Claude',       color: 'var(--cr-tool-claude)',   surf: 'var(--cr-tool-claude-surf)',   icon: 'zap' },
  { id: 'agy',      label: 'Antigravity',  color: 'var(--cr-tool-agy)',      surf: 'var(--cr-tool-agy-surf)',      icon: 'zap' },
  { id: 'gemini',   label: 'Gemini',       color: 'var(--cr-tool-gemini)',   surf: 'var(--cr-tool-gemini-surf)',   icon: 'zap' },
  { id: 'opencode', label: 'OpenCode',     color: 'var(--cr-tool-opencode)', surf: 'var(--cr-tool-opencode-surf)', icon: 'zap' },
  { id: 'codex',    label: 'Codex',        color: 'var(--cr-tool-codex)',    surf: 'var(--cr-tool-codex-surf)',    icon: 'zap' },
  { id: 'cursor',   label: 'Cursor',       color: 'var(--cr-tool-cursor)',   surf: 'var(--cr-tool-cursor-surf)',   icon: 'zap' },
];

/** Tool id → definition, for O(1) lookups in row renderers. */
export const TOOL_MAP: Record<ToolId, ToolDef> = Object.fromEntries(
  TOOLS.map((t) => [t.id, t]),
) as Record<ToolId, ToolDef>;

/** Ordered list of tool ids (for iteration in filters, counts, etc). */
export const TOOL_IDS: ToolId[] = TOOLS.map((t) => t.id);

/** "All" pseudo-tool — prepended to the sidebar source list. */
export const ALL_SOURCE = { id: 'all', label: 'All Messages', icon: 'list' } as const;

/** Full source list including the "All" entry — what the sidebar renders. */
export const TOOL_SOURCES = [ALL_SOURCE, ...TOOLS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, color: t.color, surf: t.surf }))];

/** Validation set — coerce unknown strings from URL params / props. */
export const VALID_TOOL_FILTERS: ReadonlySet<string> = new Set(['all', ...TOOL_IDS]);

/** ToolId for a raw session id, by prefix. Falls back to 'claude' (no prefix). */
export function toolFromSessionId(sessionId: string): ToolId {
  for (const t of TOOL_IDS) {
    if (t === 'claude') continue;
    if (sessionId.startsWith(t + '_')) return t;
  }
  return 'claude';
}

/** Strip the tool prefix from a session id for display (short hash). */
export function stripToolPrefix(sessionId: string): string {
  for (const t of TOOL_IDS) {
    if (t === 'claude') continue;
    const prefix = t + '_';
    if (sessionId.startsWith(prefix)) return sessionId.slice(prefix.length);
  }
  return sessionId;
}