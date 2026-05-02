/**
 * Toolkit — config-y memory primitives that span tools (Skills, MCPs).
 *
 * Distinct from the Memory tab which is tool-internal session/plan/notes
 * data. Toolkit is for things you'd want to "promote" between AI tools:
 * a skill you wrote for Claude that should also live in OpenCode, an MCP
 * configured in Gemini that you want in Claude too, etc.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Card, Chip, Input, ToolBadge, Button, SegmentedControl } from './primitives';
import {
  browseToolkit,
  getToolkitItem,
  getToolkitStatus,
  promoteToolkitItem,
  type ToolkitType,
  type ToolkitStatus,
  type MemoryMetadataRow,
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

export default function ToolkitExplorer() {
  const [activeTab, setActiveTab] = useState<ToolkitType>('skill');
  const [toolFilter, setToolFilter] = useState<ToolFilter>('all');
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

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--cr-ink-0)', overflow: 'hidden' }}>
      {/* Title */}
      <div style={{ padding: '20px 32px 12px', background: 'var(--cr-ink-1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Toolkit</h2>
          <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
            Skills, MCPs, and other config-y primitives — cross-tool, promotable.
          </span>
        </div>
      </div>

      {/* Row 1 (primary): Tool filter — same vertical position as in Memory + Activity */}
      <div
        data-testid="toolkit-tool-filter"
        style={{
          padding: '10px 32px',
          borderBottom: '1px solid var(--cr-line-1)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          background: 'var(--cr-ink-1)',
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>Tool</span>
        {(['all', 'claude', 'gemini', 'opencode', 'codex'] as ToolFilter[]).map(t => {
          const on = toolFilter === t;
          const n = t === 'all' ? totalForSelectedTool : totalsByTool[t];
          const label = t === 'all' ? 'All'
            : t === 'claude' ? 'Claude'
            : t === 'gemini' ? 'Gemini'
            : t === 'opencode' ? 'OpenCode'
            : 'Codex';
          return (
            <button
              key={t}
              onClick={() => setToolFilter(t)}
              style={{
                height: 28,
                padding: '0 12px',
                background: on ? 'var(--cr-ink-3)' : 'var(--cr-ink-2)',
                border: `1px solid ${on ? 'var(--cr-line-2)' : 'var(--cr-line-1)'}`,
                borderRadius: 'var(--cr-radius-sm)',
                color: on ? 'var(--cr-fg-1)' : 'var(--cr-fg-2)',
                fontSize: 12,
                fontWeight: on ? 500 : 400,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {t !== 'all' && <ToolBadge tool={t} size="sm" />}
              {t === 'all' && <span>{label}</span>}
              <span style={{ fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)', color: 'var(--cr-fg-3)', fontSize: 11 }}>{n}</span>
            </button>
          );
        })}
      </div>

      {/* Row 2 (secondary): Sub-tabs + search. Sub-tabs hidden when 0 for selected tool. */}
      <div style={{ padding: '12px 32px', borderBottom: '1px solid var(--cr-line-1)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <SegmentedControl
          value={activeTab}
          onChange={(v) => setActiveTab(v as ToolkitType)}
          options={visibleSubTabs.map(t => {
            const c = (status?.counts[t.id] || {}) as Partial<Record<'claude' | 'gemini' | 'opencode' | 'codex', number>>;
            const n = toolFilter === 'all'
              ? (c.claude || 0) + (c.gemini || 0) + (c.opencode || 0) + (c.codex || 0)
              : (c[toolFilter] ?? 0);
            return { value: t.id, label: `${t.label} (${n})` };
          })}
        />
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
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ width: 420, borderRight: '1px solid var(--cr-line-1)', overflowY: 'auto', background: 'var(--cr-ink-1)' }}>
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

        {/* Detail */}
        <div style={{ flex: 1, overflowY: 'auto', background: 'var(--cr-ink-0)', padding: 24 }}>
          {!detail ? (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cr-fg-3)' }}>
              Select an item to view details
            </div>
          ) : (
            <ToolkitDetail item={detail} kind={activeTab} allRows={items} />
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
