import React, { useState, useMemo } from 'react';
import { Icon, Avatar } from './primitives';
import type { ProjectTreeNode } from '../App';

interface SidebarProps {
  tree: ProjectTreeNode[];
  totalCount: number;
  selected: string | null;
  onSelect: (p: string | null) => void;
  toolFilter: string;
  setToolFilter: (t: string) => void;
}

const TOOL_SOURCES = [
  { id: 'all', label: 'All Messages', icon: 'list' },
  { id: 'claude', label: 'Claude', icon: 'zap', color: 'var(--cr-tool-claude)' },
  { id: 'gemini', label: 'Gemini', icon: 'zap', color: 'var(--cr-tool-gemini)' },
  { id: 'opencode', label: 'OpenCode', icon: 'zap', color: 'var(--cr-tool-opencode)' },
];

export default function Sidebar({ tree, totalCount, selected, onSelect, toolFilter, setToolFilter }: SidebarProps) {
  return (
    <aside
      data-testid="project-sidebar"
      style={{
        flex: '0 0 var(--cr-sidebar-w)',
        background: 'var(--cr-ink-1)',
        borderRight: '1px solid var(--cr-line-1)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Source filters */}
      <div style={{ padding: '16px 12px 10px' }}>
        <div className="cr-h4" style={{ marginBottom: 10, paddingLeft: 6 }}>Source</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {TOOL_SOURCES.map((t) => (
            <SidebarRow
              key={t.id}
              on={toolFilter === t.id}
              onClick={() => setToolFilter(t.id)}
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

      <div style={{ height: 1, background: 'var(--cr-line-1)', margin: '6px 12px' }} />

      <div style={{ padding: '10px 12px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="cr-h4" style={{ paddingLeft: 6 }}>Projects</div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 16px', display: 'flex', flexDirection: 'column', gap: 1 }}>
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
