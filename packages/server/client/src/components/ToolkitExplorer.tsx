/**
 * Toolkit — config-y memory primitives that span tools (Skills, MCPs).
 *
 * Distinct from the Memory tab which is tool-internal session/plan/notes
 * data. Toolkit is for things you'd want to "promote" between AI tools:
 * a skill you wrote for Claude that should also live in OpenCode, an MCP
 * configured in Gemini that you want in Claude too, etc.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Chip, Input, ToolBadge, Button, SegmentedControl, Icon } from './primitives';
import { useSidebarExtrasRegister } from '../context/sidebar-extras';
import {
  browseToolkit,
  getToolkitItem,
  getToolkitStatus,
  promoteToolkitItem,
  getToolkitMatrix,
  removeToolkitItem,
  type ToolkitType,
  type ToolkitStatus,
  type MemoryMetadataRow,
  type ToolkitMatrix,
  type SyncTool,
} from '../services/api';

type ToolFilter = 'all' | 'claude' | 'gemini' | 'opencode' | 'codex';

const SUB_TABS: Array<{ id: ToolkitType; label: string }> = [
  { id: 'skill',   label: 'Skills' },
  { id: 'mcp',     label: 'MCPs' },
  { id: 'command', label: 'Commands' },
  { id: 'agent',   label: 'Subagents' },
  { id: 'hook',    label: 'Hooks' },
  { id: 'plugin',  label: 'Plugins' },
];

function readTool(item: { extra_json?: string }): string {
  try { return JSON.parse(item.extra_json || '{}').tool || ''; } catch { return ''; }
}

function readField<T = unknown>(item: { extra_json?: string }, k: string): T | undefined {
  try { return JSON.parse(item.extra_json || '{}')[k] as T; } catch { return undefined; }
}

interface ToolkitExplorerProps {
  /** Source filter from the global Sidebar. */
  toolFilter?: string;
}

export default function ToolkitExplorer({ toolFilter: toolFilterProp = 'all' }: ToolkitExplorerProps) {
  const [activeTab, setActiveTab] = useState<ToolkitType>('skill');
  // Sidebar drives the filter; coerce 'unknown' values back to 'all'.
  const toolFilter = (['all', 'claude', 'gemini', 'opencode', 'codex'] as const).includes(toolFilterProp as any)
    ? (toolFilterProp as ToolFilter)
    : 'all';
  const [items, setItems] = useState<MemoryMetadataRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryMetadataRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ToolkitStatus | null>(null);

  useEffect(() => {
    getToolkitStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    setLoading(true);
    setSelectedId(null);
    setDetail(null);
    browseToolkit(activeTab, { limit: 1000 })
      .then(setItems)
      .finally(() => setLoading(false));
  }, [activeTab]);

  // Tool filter persists across sub-tab changes — that's the user's
  // mental model: "show me Codex stuff", then browse the sub-tabs to find
  // empty ones to import into. Auto-resetting was hostile.

  // Lazy-load detail on row click — keeps the list snappy.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    getToolkitItem(activeTab, selectedId)
      .then(d => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) setDetail(null); });
    return () => { cancelled = true; };
  }, [selectedId, activeTab]);

  const filtered = useMemo(() => {
    let rows = items;
    if (toolFilter !== 'all') rows = rows.filter(i => readTool(i) === toolFilter);
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      rows = rows.filter(i =>
        i.title.toLowerCase().includes(needle) ||
        (i.content_preview || '').toLowerCase().includes(needle)
      );
    }
    return rows;
  }, [items, toolFilter, search]);

  const counts = useMemo(() => {
    const c = { claude: 0, gemini: 0, opencode: 0, codex: 0 } as Record<string, number>;
    for (const i of items) {
      const t = readTool(i);
      if (t in c) c[t]++;
    }
    return c as { claude: number; gemini: number; opencode: number; codex: number };
  }, [items]);

  // Always show all sub-tabs — even when 0 rows for the selected tool.
  // The count badge already signals empty, and clicking an empty sub-tab
  // surfaces the import-from-another-tool UI in EmptyListState.
  const visibleSubTabs = SUB_TABS;

  /** Total across (every type, selected tool) — drives the "All N" chip. */
  const totalForSelectedTool = useMemo(() => {
    if (!status) return 0;
    if (toolFilter === 'all') {
      let n = 0;
      for (const t of SUB_TABS) {
        const m = status.counts[t.id] || {};
        n += (m.claude || 0) + (m.gemini || 0) + (m.opencode || 0) + (m.codex || 0);
      }
      return n;
    }
    let n = 0;
    for (const t of SUB_TABS) n += status.counts[t.id]?.[toolFilter] ?? 0;
    return n;
  }, [status, toolFilter]);

  /** Total per tool across all sub-tabs — drives the per-chip count. */
  const totalsByTool = useMemo(() => {
    const out = { claude: 0, gemini: 0, opencode: 0, codex: 0 } as Record<string, number>;
    if (!status) return out;
    for (const t of SUB_TABS) {
      const m = status.counts[t.id] || {};
      out.claude += m.claude || 0;
      out.gemini += m.gemini || 0;
      out.opencode += m.opencode || 0;
      out.codex += m.codex || 0;
    }
    return out as { claude: number; gemini: number; opencode: number; codex: number };
  }, [status]);

  // Cross-tool grouping: when a skill is named the same in claude and
  // opencode, show one row with both tool badges. Drives "promote to other
  // tool" and "this is already mirrored" UX.
  const groupedByName = useMemo(() => {
    if (activeTab !== 'skill') return null;
    const m = new Map<string, MemoryMetadataRow[]>();
    for (const it of filtered) {
      const skillName = (readField<string>(it, 'skillName') || it.title).toLowerCase();
      if (!m.has(skillName)) m.set(skillName, []);
      m.get(skillName)!.push(it);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [activeTab, filtered]);

  const [matrixOpen, setMatrixOpen] = useState(false);

  const refreshAfterMutation = () => {
    getToolkitStatus().then(setStatus).catch(() => {});
    browseToolkit(activeTab, { limit: 1000 }).then(setItems).catch(() => {});
  };

  // Push toolkit type rows (Skills/MCPs/Commands/Subagents/Hooks/Plugins)
  // into the global Sidebar so the horizontal SegmentedControl can go.
  useSidebarExtrasRegister(() => ([{
    heading: 'Type',
    rows: visibleSubTabs.map(t => {
      const c = (status?.counts[t.id] || {}) as Partial<Record<'claude' | 'gemini' | 'opencode' | 'codex', number>>;
      const n = toolFilter === 'all'
        ? (c.claude || 0) + (c.gemini || 0) + (c.opencode || 0) + (c.codex || 0)
        : (c[toolFilter as keyof typeof c] ?? 0);
      return {
        id: `toolkit-type-${t.id}`,
        label: t.label,
        count: n,
        on: activeTab === t.id,
        onClick: () => setActiveTab(t.id),
        testId: `toolkit-type-${t.id}`,
      };
    }),
  }]), [visibleSubTabs, activeTab, toolFilter, status]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--cr-ink-0)', overflow: 'hidden' }}>
      {/* Title */}
      <div className="cr-page-header" style={{ padding: '20px 32px 12px', background: 'var(--cr-ink-1)' }}>
        <div className="cr-page-header-row" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Toolkit</h2>
          <span className="cr-page-header-lead" style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
            Skills, MCPs, and other config-y primitives — cross-tool, promotable.
          </span>
          <div className="cr-page-header-spacer" style={{ flex: 1 }} />
          <Button
            data-testid="toolkit-sync-all"
            variant="primary"
            size="sm"
            onClick={() => setMatrixOpen(true)}
          >
            Sync across tools
          </Button>
        </div>
      </div>

      {matrixOpen && (
        <SyncMatrix
          onClose={() => setMatrixOpen(false)}
          onMutated={refreshAfterMutation}
        />
      )}

      {/* Tool + sub-tab filters live in the global Sidebar. Just the
          search box and detail panel ride here. */}
      <div style={{ padding: '12px 32px', borderBottom: '1px solid var(--cr-line-1)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <Input
            placeholder={`Filter ${activeTab}s…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={search ? () => setSearch('') : undefined}
            inputSize="sm"
          />
        </div>
      </div>

      {/* List + detail */}
      <div
        className="cr-split"
        data-has-selection={selectedId ? 'true' : undefined}
        style={{ flex: 1, display: 'flex', overflow: 'hidden' }}
      >
        <div className="cr-split-list" style={{ width: 420, borderRight: '1px solid var(--cr-line-1)', overflowY: 'auto', background: 'var(--cr-ink-1)' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <EmptyListState
              kind={activeTab}
              tool={toolFilter}
              search={search}
              allRows={items}
              onAfterCopy={() => browseToolkit(activeTab, { limit: 1000 }).then(setItems)}
            />
          ) : activeTab === 'skill' && groupedByName ? (
            // Skills: group by skillName so cross-tool mirrors collapse to 1 row.
            groupedByName.map(([name, group]) => {
              const tools = [...new Set(group.map(g => readTool(g)).filter(Boolean))];
              const head = group[0];
              const description = readField<string>(head, 'description') || head.content_preview || '';
              const id = head.id;
              return (
                <div
                  key={name}
                  onClick={() => setSelectedId(id)}
                  style={{
                    padding: '14px 20px',
                    cursor: 'pointer',
                    borderBottom: '1px solid var(--cr-line-1)',
                    background: selectedId === id ? 'var(--cr-ink-2)' : 'transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                    {tools.map(t => <ToolBadge key={t} tool={t} size="sm" />)}
                    {tools.length === 1 && (
                      <Chip kind="warn" size="sm">only in {tools[0]}</Chip>
                    )}
                    {tools.length > 1 && (
                      <Chip kind="ok" size="sm">mirrored ({tools.length})</Chip>
                    )}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--cr-fg-1)', marginBottom: 4 }}>
                    {readField<string>(head, 'skillName') || head.title}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.4 }}>
                    {description.slice(0, 200)}
                  </div>
                </div>
              );
            })
          ) : (
            // MCPs: flat list.
            filtered.map(item => {
              const tool = readTool(item);
              const cmd = readField<string>(item, 'command') || item.content_preview || '';
              const allow = readField<string[]>(item, 'alwaysAllow') || [];
              return (
                <div
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  style={{
                    padding: '14px 20px',
                    cursor: 'pointer',
                    borderBottom: '1px solid var(--cr-line-1)',
                    background: selectedId === item.id ? 'var(--cr-ink-2)' : 'transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    {tool && <ToolBadge tool={tool} size="sm" />}
                    <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>
                      {readField<string>(item, 'scope') || ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--cr-fg-1)', marginBottom: 4 }}>
                    {item.title}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {cmd.slice(0, 120)}
                  </div>
                  {allow.length > 0 && (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--cr-fg-3)' }}>
                      Allow: {allow.slice(0, 4).join(', ')}{allow.length > 4 ? `… +${allow.length - 4}` : ''}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Detail — wrapper has no padding so the mobile sticky back
            button can sit edge-to-edge; padding lives on the inner
            empty-state and ToolkitDetail. */}
        <div className="cr-split-detail" style={{ flex: 1, overflowY: 'auto', background: 'var(--cr-ink-0)' }}>
          {!detail ? (
            <div style={{ height: '100%', padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cr-fg-3)' }}>
              Select an item to view details
            </div>
          ) : (
            <>
              <button
                type="button"
                className="cr-mobile-only cr-split-back"
                onClick={() => setSelectedId(null)}
                aria-label="Back to list"
              >
                <Icon name="chevronLeft" size={14} /> Back
              </button>
              <div style={{ padding: 24 }}>
                <ToolkitDetail item={detail} kind={activeTab} allRows={items} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Detail pane for a Skill or MCP. For skills, lists every tool that has a
 * mirror of this skill (by name) — and notes the ones that don't, so the
 * user can see at a glance "this skill is in claude+opencode but not gemini".
 */
function ToolkitDetail({ item, kind, allRows }: { item: MemoryMetadataRow; kind: ToolkitType; allRows: MemoryMetadataRow[] }) {
  const tool = readTool(item);
  const description = readField<string>(item, 'description') || '';
  const command = readField<string>(item, 'command') || '';
  const allow = readField<string[]>(item, 'alwaysAllow') || [];
  const scope = readField<string>(item, 'scope') || '';
  const skillName = readField<string>(item, 'skillName') || '';
  const subdirs = readField<Record<string, number>>(item, 'subdirs') || {};

  // For skills — find peers by matching skillName across tools.
  const peers = useMemo(() => {
    if (kind !== 'skill' || !skillName) return [];
    const me = skillName.toLowerCase();
    return allRows
      .filter(r => (readField<string>(r, 'skillName') || '').toLowerCase() === me && r.id !== item.id)
      .map(r => readTool(r))
      .filter(Boolean);
  }, [kind, skillName, allRows, item.id]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        {tool && <ToolBadge tool={tool} />}
        {peers.length > 0 && (
          <Chip kind="ok">also in: {peers.join(', ')}</Chip>
        )}
        {kind === 'skill' && peers.length === 0 && (
          <Chip kind="warn">only in {tool}</Chip>
        )}
        {scope && <Chip kind="neutral">{scope}</Chip>}
      </div>
      <h3 style={{ margin: '0 0 8px 0', fontSize: 22, fontWeight: 600 }}>{skillName || item.title}</h3>
      {description && (
        <p style={{ color: 'var(--cr-fg-2)', fontSize: 14, lineHeight: 1.5, marginTop: 4 }}>
          {description}
        </p>
      )}

      {kind === 'mcp' && (
        <Card style={{ padding: 16, marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginBottom: 6 }}>Command</div>
          <pre style={{ margin: 0, fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--cr-fg-1)' }}>
            {command || '(none)'}
          </pre>
          {allow.length > 0 && (
            <>
              <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', margin: '12px 0 6px' }}>Always allow</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {allow.map(a => <Chip key={a} kind="neutral" size="sm">{a}</Chip>)}
              </div>
            </>
          )}
        </Card>
      )}

      {kind === 'skill' && Object.keys(subdirs).length > 0 && (
        <Card style={{ padding: 16, marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginBottom: 6 }}>Skill assets</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(subdirs).map(([name, count]) => (
              <Chip key={name} kind="neutral" size="sm">{name}: {count}</Chip>
            ))}
          </div>
        </Card>
      )}

      <Card style={{ padding: 16, marginTop: 16 }}>
        <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginBottom: 6 }}>Source file</div>
        <code style={{ fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)', fontSize: 12, color: 'var(--cr-fg-2)', wordBreak: 'break-all' }}>
          {item.file_path}
        </code>
      </Card>

      <PromoteRow item={item} kind={kind} fromTool={tool} allRows={allRows} />
    </div>
  );
}

/** Per-primitive: which AI tools natively expose this surface today. */
const TOOL_SUPPORT: Record<ToolkitType, ReadonlySet<AiToolName>> = {
  // Skills: Claude (~/.claude/skills), OpenCode (~/.config/opencode/skill),
  // Codex (~/.codex/skills/.system). Gemini uses Extensions instead.
  skill:   new Set(['claude', 'opencode', 'codex']),
  // MCPs: 4-way (cross-format JSON ↔ TOML).
  mcp:     new Set(['claude', 'gemini', 'opencode', 'codex']),
  // Plugins: Claude marketplace, Gemini extensions, Codex plugin packs —
  // different on-disk shapes, but each tool has a "plugin"-flavored slot.
  plugin:  new Set(['claude', 'gemini', 'codex']),
  // Commands / Agents / Hooks: only Claude has a documented user-editable
  // surface today. Listed honestly — the matrix shows other tools as N/A.
  command: new Set(['claude']),
  agent:   new Set(['claude']),
  hook:    new Set(['claude']),
};

type AiToolName = 'claude' | 'gemini' | 'opencode' | 'codex';
const ALL_AI_TOOLS: AiToolName[] = ['claude', 'gemini', 'opencode', 'codex'];

/** Build the per-tool presence map for a primitive (by display name). */
function computePresence(
  kind: ToolkitType,
  primaryName: string,
  allRows: MemoryMetadataRow[],
): Record<AiToolName, MemoryMetadataRow | null> {
  const out: Record<AiToolName, MemoryMetadataRow | null> = {
    claude: null, gemini: null, opencode: null, codex: null,
  };
  const me = primaryName.toLowerCase();
  // Match by the natural identity field for each kind.
  const idField =
      kind === 'skill'  ? 'skillName'
    : kind === 'mcp'    ? 'mcpName'
    : kind === 'plugin' ? 'pluginName'
    : kind === 'agent'  ? 'agentName'
    : kind === 'command'? 'commandName'
    :                     null;
  for (const r of allRows) {
    const t = readTool(r) as AiToolName;
    if (!t || !(t in out)) continue;
    const candidate = idField
      ? (readField<string>(r, idField) || r.title)
      : r.title;
    if (candidate.toLowerCase() === me && !out[t]) out[t] = r;
  }
  return out;
}

function PromoteRow({
  item, kind, fromTool, allRows,
}: { item: MemoryMetadataRow; kind: ToolkitType; fromTool: string; allRows: MemoryMetadataRow[] }) {
  const [busy, setBusy] = useState<AiToolName | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const primaryName = (
    kind === 'skill' ? readField<string>(item, 'skillName')
    : kind === 'mcp' ? readField<string>(item, 'mcpName')
    : kind === 'plugin' ? readField<string>(item, 'pluginName')
    : kind === 'agent' ? readField<string>(item, 'agentName')
    : kind === 'command' ? readField<string>(item, 'commandName')
    : null
  ) || item.title;

  const presence = useMemo(
    () => computePresence(kind, primaryName, allRows),
    [kind, primaryName, allRows],
  );
  const supportedTools = TOOL_SUPPORT[kind];

  const handle = async (toTool: AiToolName) => {
    if (!confirm(`Copy ${primaryName} from ${fromTool} → ${toTool}?`)) return;
    setBusy(toTool);
    setMsg(null);
    const r = await promoteToolkitItem(kind, item.id, toTool);
    setBusy(null);
    if (r.ok) setMsg({ kind: 'ok', text: `Copied to ${r.targetPath || toTool}` });
    else setMsg({ kind: 'err', text: r.error || 'failed' });
  };

  // Cross-tool availability matrix — one row per AI tool, with explicit state.
  return (
    <Card style={{ padding: 16, marginTop: 16 }}>
      <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginBottom: 10 }}>
        Cross-tool availability
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {ALL_AI_TOOLS.map(t => {
          const has = !!presence[t];
          const supports = supportedTools.has(t);
          let action: React.ReactNode;
          if (has) {
            action = <Chip kind="ok" size="sm">installed</Chip>;
          } else if (!supports) {
            action = <Chip kind="neutral" size="sm">not supported in {t}</Chip>;
          } else if (t === fromTool) {
            // We're viewing this row's own tool — should be `has=true`. Defensive.
            action = <Chip kind="neutral" size="sm">source</Chip>;
          } else {
            action = (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => handle(t)}
              >
                {busy === t ? 'Copying…' : `Copy to ${t === 'opencode' ? 'OpenCode' : t[0].toUpperCase() + t.slice(1)}`}
              </Button>
            );
          }
          return (
            <div
              key={t}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 10px',
                background: 'var(--cr-ink-1)',
                border: '1px solid var(--cr-line-1)',
                borderRadius: 'var(--cr-radius-sm)',
              }}
            >
              <ToolBadge tool={t} size="sm" />
              {action}
            </div>
          );
        })}
      </div>
      {msg && (
        <div style={{
          marginTop: 12,
          padding: 10,
          fontSize: 12,
          borderRadius: 'var(--cr-radius-sm)',
          background: msg.kind === 'ok' ? 'var(--cr-ok-surf)' : 'var(--cr-err-surf)',
          color: msg.kind === 'ok' ? 'var(--cr-ok-500)' : 'var(--cr-err-500)',
          border: `1px solid ${msg.kind === 'ok' ? 'var(--cr-ok-line)' : 'var(--cr-err-line)'}`,
        }}>
          {msg.text}
        </div>
      )}
    </Card>
  );
}

/**
 * Empty-state for when a (sub-tab, tool) combo has no rows. Lists rows
 * that exist in *other* tools and lets you copy them into the selected
 * one with a single click — turning "Codex hooks: empty" into "import
 * from Claude" with explicit per-row buttons.
 */
function EmptyListState({
  kind, tool, search, allRows, onAfterCopy,
}: {
  kind: ToolkitType;
  tool: ToolFilter;
  search: string;
  allRows: MemoryMetadataRow[];
  onAfterCopy: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  // Search-empty is its own thing — show "no matches" and bail.
  if (search) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>
        No matches for "{search}"
      </div>
    );
  }

  // What's available in OTHER tools that we could import?
  const importable = useMemo(() => {
    if (tool === 'all') return [];
    return allRows.filter(r => readTool(r) !== tool);
  }, [allRows, tool]);

  const targetTool = tool === 'all' ? null : (tool as AiToolName);
  const supports = targetTool ? TOOL_SUPPORT[kind].has(targetTool) : true;

  // Tool isn't supposed to have this primitive at all — be honest about it.
  if (targetTool && !supports) {
    return (
      <div style={{ padding: 40, color: 'var(--cr-fg-3)' }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--cr-fg-2)', marginBottom: 6 }}>
          {targetTool} doesn't natively support {kind}s.
        </div>
        <div style={{ fontSize: 12 }}>
          {kind === 'skill' && targetTool === 'gemini' && 'Gemini uses Extensions instead — see the Plugins tab.'}
          {kind === 'hook'  && 'Hooks live in Claude Code\'s settings.json. Other tools have their own event mechanisms.'}
          {kind === 'command' && 'Slash commands are a Claude Code feature today.'}
          {kind === 'agent' && 'User-definable subagent files live under ~/.claude/agents/. Other tools spawn agents differently.'}
        </div>
      </div>
    );
  }

  if (importable.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>
        No {kind}s indexed yet.
      </div>
    );
  }

  const handleImport = async (row: MemoryMetadataRow) => {
    if (!targetTool) return;
    setBusyId(row.id);
    const r = await promoteToolkitItem(kind, row.id, targetTool);
    setBusyId(null);
    if (r.ok) onAfterCopy();
    else alert(`Copy failed: ${r.error || 'unknown error'}`);
  };

  return (
    <div style={{ padding: '20px 16px' }}>
      <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--cr-fg-2)' }}>
        No {kind}s in {targetTool}. Import from another tool:
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {importable.slice(0, 30).map(row => {
          const fromTool = readTool(row);
          return (
            <div
              key={row.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                background: 'var(--cr-ink-2)',
                border: '1px solid var(--cr-line-1)',
                borderRadius: 'var(--cr-radius-sm)',
              }}
            >
              {fromTool && <ToolBadge tool={fromTool} size="sm" />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 12, fontWeight: 500, color: 'var(--cr-fg-1)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {row.title}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busyId !== null}
                onClick={() => handleImport(row)}
              >
                {busyId === row.id ? 'Copying…' : `Copy →`}
              </Button>
            </div>
          );
        })}
      </div>
      {importable.length > 30 && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--cr-fg-3)' }}>
          …and {importable.length - 30} more
        </div>
      )}
    </div>
  );
}

// ───────────── Sync Matrix ─────────────────────────────────────────
//
// Modal-style overlay: rows = (type, name), columns = AI tools, cells
// show presence and accept clicks to queue add/remove. Apply runs all
// queued mutations in parallel and refreshes the matrix.

const ALL_TOOLS_ORDERED: SyncTool[] = ['claude', 'opencode', 'codex', 'gemini'];
const TOOL_LABEL: Record<SyncTool, string> = {
  claude: 'Claude', opencode: 'OpenCode', codex: 'Codex', gemini: 'Gemini',
};

type CellAction = 'add' | 'remove';
type PendingMap = Map<string, CellAction>; // key = "<type>:<name>:<tool>"
const cellKey = (type: 'skill' | 'mcp', name: string, tool: SyncTool) => `${type}:${name}:${tool}`;

function SyncMatrix({ onClose, onMutated }: { onClose: () => void; onMutated: () => void }) {
  const [matrix, setMatrix] = useState<ToolkitMatrix | null>(null);
  const [activeType, setActiveType] = useState<'skill' | 'mcp'>('skill');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'incomplete'>('incomplete');
  const [pending, setPending] = useState<PendingMap>(new Map());
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [errors, setErrors] = useState<{ key: string; error: string }[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const m = await getToolkitMatrix();
      setMatrix(m);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'failed to load matrix');
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const togglePending = useCallback((type: 'skill' | 'mcp', name: string, tool: SyncTool, currentlyPresent: boolean) => {
    setPending((prev) => {
      const next = new Map(prev);
      const k = cellKey(type, name, tool);
      const existing = next.get(k);
      const desired: CellAction = currentlyPresent ? 'remove' : 'add';
      if (existing === desired) {
        next.delete(k); // un-mark
      } else {
        next.set(k, desired);
      }
      return next;
    });
  }, []);

  const apply = useCallback(async () => {
    if (!matrix || pending.size === 0) return;
    const ops = [...pending.entries()].map(([k, action]) => {
      const [type, name, tool] = k.split(':') as ['skill' | 'mcp', string, SyncTool];
      return { k, type, name, tool, action };
    });
    setApplying(true);
    setErrors([]);
    setProgress({ done: 0, total: ops.length });

    const errorList: { key: string; error: string }[] = [];
    let done = 0;
    // Sequential to keep file I/O safe and surface clear progress.
    for (const op of ops) {
      try {
        if (op.action === 'add') {
          // Find a source tool that has it.
          const slot = matrix[op.type][op.name] || {};
          const source = (Object.keys(slot) as SyncTool[]).find(t => slot[t]);
          if (!source) {
            errorList.push({ key: op.k, error: `no source tool has ${op.name}` });
          } else {
            // Build a synthetic id: <tool>_<typePrefix>_<name>
            const prefix = op.type === 'skill' ? 'skill' : 'mcp';
            const sourceId = `${source}_${prefix}_${op.name}`;
            const r = await promoteToolkitItem(op.type, sourceId, op.tool);
            if (!r.ok) errorList.push({ key: op.k, error: r.error || 'failed' });
          }
        } else {
          const r = await removeToolkitItem(op.type, op.name, op.tool);
          if (!r.ok) errorList.push({ key: op.k, error: r.error || 'failed' });
        }
      } catch (e) {
        errorList.push({ key: op.k, error: e instanceof Error ? e.message : 'failed' });
      }
      done++;
      setProgress({ done, total: ops.length });
    }
    setErrors(errorList);
    setApplying(false);
    setPending(new Map());
    onMutated();
    await reload();
  }, [matrix, pending, onMutated, reload]);

  // Build the visible row list.
  const rows = useMemo(() => {
    if (!matrix) return [];
    const data = matrix[activeType];
    const supported = new Set(matrix.supportedTargets[activeType]);
    const supportedCount = supported.size;
    const needle = search.trim().toLowerCase();
    return Object.keys(data)
      .filter(name => !needle || name.toLowerCase().includes(needle))
      .map(name => {
        const presence = data[name] || {};
        const presentCount = ALL_TOOLS_ORDERED.filter(t => supported.has(t) && presence[t]).length;
        const incomplete = presentCount > 0 && presentCount < supportedCount;
        return { name, presence, incomplete, presentCount, supportedCount };
      })
      .filter(r => filter === 'all' || r.incomplete)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [matrix, activeType, search, filter]);

  const supportedTools = matrix ? matrix.supportedTargets[activeType] : ALL_TOOLS_ORDERED;
  const adds = [...pending.values()].filter(v => v === 'add').length;
  const removes = [...pending.values()].filter(v => v === 'remove').length;

  // Lock body scroll while modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div
      data-testid="toolkit-sync-matrix"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 'min(1100px, 96vw)', maxHeight: '92vh',
          background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-2)',
          borderRadius: 'var(--cr-radius-md)', display: 'flex', flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
        }}
      >
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--cr-line-1)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Sync across tools</h2>
          <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
            Click a cell to queue a change. Filled = present; ring = pending add; X = pending remove.
          </span>
          <div style={{ flex: 1 }} />
          <Button
            data-testid="toolkit-sync-apply"
            variant="primary"
            size="sm"
            disabled={pending.size === 0 || applying}
            onClick={apply}
          >
            {applying ? `Applying… ${progress.done}/${progress.total}`
             : pending.size === 0 ? 'No changes'
             : `Apply ${pending.size} change${pending.size === 1 ? '' : 's'}` +
               (adds && removes ? ` (${adds}+/${removes}−)` : adds ? ` (${adds}+)` : ` (${removes}−)`)
            }
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>

        {/* Toolbar: type tabs, search, filter */}
        <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--cr-line-1)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <SegmentedControl
            value={activeType}
            onChange={(v) => setActiveType(v as 'skill' | 'mcp')}
            options={[
              { value: 'skill', label: matrix ? `Skills (${Object.keys(matrix.skill).length})` : 'Skills' },
              { value: 'mcp',   label: matrix ? `MCPs (${Object.keys(matrix.mcp).length})`     : 'MCPs' },
            ]}
            size="sm"
          />
          <div style={{ flex: 1, maxWidth: 320 }}>
            <Input
              placeholder={`Filter ${activeType === 'skill' ? 'skills' : 'MCPs'}…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClear={search ? () => setSearch('') : undefined}
              inputSize="sm"
            />
          </div>
          <SegmentedControl
            value={filter}
            onChange={(v) => setFilter(v as 'all' | 'incomplete')}
            options={[
              { value: 'incomplete', label: 'Needs sync' },
              { value: 'all',        label: 'All' },
            ]}
            size="sm"
          />
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 18px' }}>
          {loadErr && <div style={{ color: 'var(--cr-err-500)', fontSize: 13 }}>{loadErr}</div>}
          {!matrix && !loadErr && (
            <div style={{ color: 'var(--cr-fg-3)', fontSize: 13, padding: 30, textAlign: 'center' }}>Loading matrix…</div>
          )}
          {matrix && rows.length === 0 && (
            <div style={{ color: 'var(--cr-fg-3)', fontSize: 13, padding: 30, textAlign: 'center' }}>
              {filter === 'incomplete' ? 'Everything is in sync. Switch to "All" to view installed items.' : 'No items match.'}
            </div>
          )}
          {matrix && rows.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--cr-ink-1)', zIndex: 1 }}>
                <tr>
                  <th style={thStyle('left')}>Name</th>
                  {ALL_TOOLS_ORDERED.map(t => (
                    <th key={t} style={thStyle('center')}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <ToolBadge tool={t} size="sm" />
                        <span>{TOOL_LABEL[t]}</span>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.name} style={{ borderTop: '1px solid var(--cr-line-1)' }}>
                    <td style={tdStyle('left')}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <code style={{ color: 'var(--cr-fg-1)' }}>{row.name}</code>
                        {row.incomplete && <Chip kind="warn" size="sm">{row.presentCount}/{row.supportedCount}</Chip>}
                      </div>
                    </td>
                    {ALL_TOOLS_ORDERED.map(t => {
                      const supported = supportedTools.includes(t);
                      const present = !!row.presence[t];
                      const queued = pending.get(cellKey(activeType, row.name, t));
                      return (
                        <td key={t} style={tdStyle('center')}>
                          <CellButton
                            supported={supported}
                            present={present}
                            queued={queued}
                            onClick={() => togglePending(activeType, row.name, t, present)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {errors.length > 0 && (
            <div style={{ marginTop: 14, padding: 12, background: 'var(--cr-err-surf)', border: '1px solid var(--cr-err-line)', borderRadius: 'var(--cr-radius-sm)' }}>
              <div style={{ fontSize: 12, color: 'var(--cr-err-500)', fontWeight: 500, marginBottom: 4 }}>
                {errors.length} change{errors.length === 1 ? '' : 's'} failed:
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--cr-err-500)' }}>
                {errors.slice(0, 12).map(e => <li key={e.key}><code>{e.key}</code>: {e.error}</li>)}
                {errors.length > 12 && <li>…and {errors.length - 12} more</li>}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function thStyle(align: 'left' | 'center'): React.CSSProperties {
  return {
    textAlign: align, padding: '8px 6px',
    fontSize: 11, fontWeight: 500, color: 'var(--cr-fg-3)',
    textTransform: 'uppercase', letterSpacing: '0.04em',
    borderBottom: '1px solid var(--cr-line-1)',
  };
}
function tdStyle(align: 'left' | 'center'): React.CSSProperties {
  return { padding: '6px', textAlign: align, verticalAlign: 'middle' };
}

/**
 * One cell of the sync matrix. Visual state cheat-sheet:
 *   • supported && present  → solid filled dot (tool-color); click queues 'remove'
 *   • supported && missing  → empty ring;        click queues 'add'
 *   • !supported            → em-dash, not interactive
 *   • queued 'add'          → dashed ring with a + glyph
 *   • queued 'remove'       → solid dot with an × overlay
 */
function CellButton({
  supported, present, queued, onClick,
}: {
  supported: boolean;
  present: boolean;
  queued: CellAction | undefined;
  onClick: () => void;
}) {
  if (!supported) {
    return <span style={{ color: 'var(--cr-fg-3)', fontSize: 14 }} title="Not supported in this tool">—</span>;
  }

  let icon: React.ReactNode;
  let title: string;

  if (queued === 'add') {
    title = 'Pending: add';
    icon = (
      <svg viewBox="0 0 16 16" width={18} height={18}>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--cr-ok-500)" strokeWidth="1.5" strokeDasharray="2.5 2" />
        <path d="M8 5 V 11 M5 8 H 11" stroke="var(--cr-ok-500)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  } else if (queued === 'remove') {
    title = 'Pending: remove';
    icon = (
      <svg viewBox="0 0 16 16" width={18} height={18}>
        <circle cx="8" cy="8" r="6.5" fill="var(--cr-err-surf)" stroke="var(--cr-err-500)" strokeWidth="1.5" />
        <path d="M5.5 5.5 L 10.5 10.5 M 10.5 5.5 L 5.5 10.5" stroke="var(--cr-err-500)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  } else if (present) {
    title = 'Installed — click to remove';
    icon = (
      <svg viewBox="0 0 16 16" width={18} height={18}>
        <circle cx="8" cy="8" r="6" fill="var(--cr-brand-500)" />
        <path d="M5 8 L 7 10 L 11 6" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    );
  } else {
    title = 'Not installed — click to add';
    icon = (
      <svg viewBox="0 0 16 16" width={18} height={18}>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--cr-line-2)" strokeWidth="1.5" />
      </svg>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-testid="sync-matrix-cell"
      data-present={present ? 'true' : 'false'}
      data-queued={queued || ''}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, padding: 0, border: 'none',
        background: 'transparent', cursor: 'pointer', borderRadius: 6,
      }}
    >
      {icon}
    </button>
  );
}
