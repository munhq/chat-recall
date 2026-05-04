import React, { useState, useMemo } from 'react';
import { Icon, Avatar } from './primitives';
import type { ProjectTreeNode } from '../App';

export interface SidebarSection {
  /** Heading shown above the rows (e.g. "Type", "Window"). */
  heading: string;
  rows: SidebarSectionRow[];
}

export interface SidebarSectionRow {
  id: string;
  label: string;
  count?: number;
  /** Render a small dot or icon to the left of the label. */
  swatch?: React.ReactNode;
  on: boolean;
  onClick: () => void;
  /** Test hook for Playwright. */
  testId?: string;
}

interface SidebarProps {
  tree: ProjectTreeNode[];
  totalCount: number;
  selected: string | null;
  onSelect: (p: string | null) => void;
  toolFilter: string;
  setToolFilter: (t: string) => void;
  /**
   * View-specific filter sections rendered between Source and Projects.
   * Each top-level view (Memory / Toolkit / Activity / Insights) injects
   * its own — e.g. Memory passes "Type" with Plans/Notes/Tasks rows,
   * Activity passes "Window" with 1h/6h/24h/7d rows. The horizontal
   * filter chips that used to live in each view are gone.
   */
  extraSections?: SidebarSection[];
  /**
   * Mobile-only: when the drawer is open we surface the top-level nav
   * (Conversations / Activity / Memory / …) inside the sidebar so the
   * desktop TopBar nav can be hidden on small screens. Hidden on
   * desktop via the `cr-mobile-only` class.
   */
  view?: string;
  setView?: (v: 'search' | 'memory' | 'toolkit' | 'dashboard' | 'activity' | 'settings') => void;
}

const MOBILE_NAV_ITEMS: Array<{ id: 'search' | 'memory' | 'toolkit' | 'dashboard' | 'activity'; label: string; icon: string }> = [
  { id: 'search', label: 'Conversations', icon: 'message' },
  { id: 'activity', label: 'Activity', icon: 'clock' },
  { id: 'memory', label: 'Memory', icon: 'brain' },
  { id: 'toolkit', label: 'Toolkit', icon: 'zap' },
  { id: 'dashboard', label: 'Insights', icon: 'chart' },
];

const TOOL_SOURCES = [
  { id: 'all', label: 'All Messages', icon: 'list' },
  { id: 'claude', label: 'Claude', icon: 'zap', color: 'var(--cr-tool-claude)' },
  { id: 'gemini', label: 'Gemini', icon: 'zap', color: 'var(--cr-tool-gemini)' },
  { id: 'opencode', label: 'OpenCode', icon: 'zap', color: 'var(--cr-tool-opencode)' },
  { id: 'codex', label: 'Codex', icon: 'zap', color: 'var(--cr-tool-codex)' },
];

export default function Sidebar({
  tree, totalCount, selected, onSelect,
  toolFilter, setToolFilter,
  extraSections,
  view, setView,
}: SidebarProps) {
  return (
    <aside
      id="cr-sidebar-drawer"
      className="cr-sidebar"
      data-testid="project-sidebar"
      aria-label="Navigation and filters"
      style={{
        flex: '0 0 var(--cr-sidebar-w)',
        background: 'var(--cr-ink-1)',
        borderRight: '1px solid var(--cr-line-1)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* Mobile-only nav (the desktop TopBar nav is hidden under 768px). */}
        {setView && (
          <div className="cr-mobile-only" style={{ padding: '14px 12px 4px' }}>
            <div className="cr-h4" style={{ marginBottom: 10, paddingLeft: 6 }}>Navigate</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {MOBILE_NAV_ITEMS.map((n) => (
                <SidebarRow
                  key={n.id}
                  on={view === n.id}
                  onClick={() => setView(n.id)}
                  data-testid={`mobile-nav-${n.id}`}
                  left={<Icon name={n.icon} size={14} style={{ color: view === n.id ? 'var(--cr-brand-500)' : 'var(--cr-fg-3)' }} />}
                  label={n.label}
                />
              ))}
            </div>
            <div style={{ height: 1, background: 'var(--cr-line-1)', margin: '10px 0 0' }} />
          </div>
        )}

        {/* Source filter — shared by every view. */}
        <div style={{ padding: '16px 12px 10px' }}>
          <div className="cr-h4" style={{ marginBottom: 10, paddingLeft: 6 }}>Source</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {TOOL_SOURCES.map((t) => (
              <SidebarRow
                key={t.id}
                on={toolFilter === t.id}
                onClick={() => setToolFilter(t.id)}
                data-testid={`tool-filter-${t.id}`}
                left={
                  t.id === 'all' ? (
                    <Icon name={t.icon} size={14} style={{ color: toolFilter === t.id ? 'var(--cr-brand-500)' : 'var(--cr-fg-3)' }} />
                  ) : (
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.color, flexShrink: 0 }} />
                  )
                }
                label={t.label}
              />
            ))}
          </div>
        </div>

        {/* View-specific sections (Type / Window / etc.) */}
        {(extraSections || []).map((section) => (
          <React.Fragment key={section.heading}>
            <div style={{ height: 1, background: 'var(--cr-line-1)', margin: '6px 12px' }} />
            <div style={{ padding: '10px 12px 4px' }}>
              <div className="cr-h4" style={{ paddingLeft: 6 }}>{section.heading}</div>
            </div>
            <div style={{ padding: '4px 12px 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
              {section.rows.map((row) => (
                <SidebarRow
                  key={row.id}
                  on={row.on}
                  onClick={row.onClick}
                  data-testid={row.testId}
                  left={
                    row.swatch ?? (
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: row.on ? 'var(--cr-brand-500)' : 'var(--cr-fg-3)',
                        opacity: row.on ? 1 : 0.4, flexShrink: 0,
                      }} />
                    )
                  }
                  label={row.label}
                  count={row.count}
                />
              ))}
            </div>
          </React.Fragment>
        ))}

        {/* Projects tree — shown for all views; clicking still scopes to a path. */}
        <div style={{ height: 1, background: 'var(--cr-line-1)', margin: '6px 12px' }} />
        <div style={{ padding: '10px 12px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="cr-h4" style={{ paddingLeft: 6 }}>Projects</div>
        </div>
        <div style={{ padding: '4px 12px 16px', display: 'flex', flexDirection: 'column', gap: 1 }}>
          <SidebarRow
            on={selected === null}
            onClick={() => onSelect(null)}
            data-testid="project-all"
            left={<Icon name="database" size={14} style={{ color: selected === null ? 'var(--cr-brand-500)' : 'var(--cr-fg-3)' }} />}
            label="All Projects"
            count={totalCount}
          />
          {tree.map((node) => (
            <TreeRow
              key={node.fullPath}
              node={node}
              depth={0}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

/**
 * Recursive row. If the node has children it renders as a folder:
 * the chevron toggles expansion; the rest of the row filters by path.
 * A node is always rendered once — a folder never duplicates as a
 * leaf inside its own parent.
 */
function TreeRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: ProjectTreeNode;
  depth: number;
  selected: string | null;
  onSelect: (p: string | null) => void;
}) {
  const hasChildren = node.children.length > 0;
  const [open, setOpen] = useState(true);
  const isSelected = selected === node.fullPath;

  return (
    <>
      <SidebarRow
        on={isSelected}
        onClick={() => onSelect(node.fullPath)}
        data-testid={hasChildren ? 'project-folder' : 'project-item'}
        data-path={node.fullPath}
        depth={depth}
        left={
          hasChildren ? (
            <ChevronButton open={open} onToggle={() => setOpen(!open)} />
          ) : (
            <Avatar name={node.name.split('/').pop() || node.name} size={18} />
          )
        }
        label={node.name}
        count={node.totalCount}
        indent={depth > 0}
      />

      {hasChildren && open &&
        node.children.map((c) => (
          <TreeRow
            key={c.fullPath}
            node={c}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

function ChevronButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-testid="tree-chevron"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        width: 18,
        height: 18,
        color: 'var(--cr-fg-3)',
      }}
    >
      <Icon
        name="chevronRight"
        size={12}
        style={{
          transform: open ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.15s',
        }}
      />
    </button>
  );
}

function SidebarRow({
  on,
  onClick,
  left,
  label,
  count,
  indent,
  depth = 0,
  'data-testid': testId,
  'data-path': dataPath,
}: {
  on: boolean;
  onClick: () => void;
  left: React.ReactNode;
  label: string;
  count?: number;
  indent?: boolean;
  depth?: number;
  'data-testid'?: string;
  'data-path'?: string;
}) {
  const [hov, setHov] = useState(false);

  // Long path labels (from collapsed transparent chains) show the last
  // two segments with an ellipsis prefix so they stay one line.
  const displayLabel = useMemo(() => {
    if (!indent) return label;
    const parts = label.split('/');
    if (parts.length > 2) return `…/${parts.slice(-2).join('/')}`;
    return label;
  }, [label, indent]);

  const paddingLeft = 8 + depth * 14;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      data-testid={testId}
      data-path={dataPath}
      aria-current={on ? 'true' : undefined}
      title={label}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingLeft,
        paddingRight: 8,
        paddingTop: indent ? 4 : 6,
        paddingBottom: indent ? 4 : 6,
        height: indent ? 28 : 32,
        borderRadius: 6,
        cursor: 'pointer',
        background: on ? 'var(--cr-ink-3)' : hov ? 'var(--cr-ink-2)' : 'transparent',
        color: on ? 'var(--cr-fg-1)' : 'var(--cr-fg-2)',
        transition: 'background var(--cr-dur-fast), color var(--cr-dur-fast)',
      }}
    >
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {left}
      </div>
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 13,
          fontWeight: on ? 500 : 400,
          letterSpacing: '-0.005em',
        }}
      >
        {displayLabel}
      </span>
      {count != null && (
        <span style={{ fontSize: 11, color: 'var(--cr-fg-3)', fontVariantNumeric: 'tabular-nums', opacity: on ? 1 : 0.7 }}>
          {count}
        </span>
      )}
    </div>
  );
}
