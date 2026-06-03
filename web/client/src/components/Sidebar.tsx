import React, { useState, useMemo } from 'react';
import { Icon, Avatar } from './primitives';
import type { ProjectTreeNode } from '../App';

export interface SidebarSection {
  heading: string;
  rows: SidebarSectionRow[];
}

export interface SidebarSectionRow {
  id: string;
  label: string;
  count?: number;
  swatch?: React.ReactNode;
  on: boolean;
  onClick: () => void;
  testId?: string;
}

interface SidebarProps {
  tree: ProjectTreeNode[];
  totalCount: number;
  selected: string | null;
  onSelect: (p: string | null) => void;
  toolFilter: string;
  setToolFilter: (t: string) => void;
  extraSections?: SidebarSection[];
  view?: string;
  setView?: (v: 'search' | 'memory' | 'toolkit' | 'dashboard' | 'activity' | 'security' | 'settings') => void;
}

const MOBILE_NAV_ITEMS: Array<{ id: 'search' | 'memory' | 'toolkit' | 'dashboard' | 'activity' | 'security'; label: string; icon: string }> = [
  { id: 'search', label: 'Conversations', icon: 'message' },
  { id: 'activity', label: 'Activity', icon: 'clock' },
  { id: 'memory', label: 'Memory', icon: 'brain' },
  { id: 'toolkit', label: 'Toolkit', icon: 'zap' },
  { id: 'dashboard', label: 'Insights', icon: 'chart' },
  { id: 'security', label: 'Security', icon: 'check' },
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
        {setView && (
          <div className="cr-mobile-only" style={{ padding: '14px 12px 4px' }}>
            <div className="cr-h4" style={{ marginBottom: 10, paddingLeft: 6 }}>Navigate</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {MOBILE_NAV_ITEMS.map((n) => (
                <SidebarRowItem
                  key={n.id}
                  active={view === n.id}
                  onClick={() => setView(n.id)}
                  data-testid={`mobile-nav-${n.id}`}
                  icon={<Icon name={n.icon} size={14} />}
                  label={n.label}
                />
              ))}
            </div>
            <div style={{ height: 1, background: 'var(--cr-line-1)', margin: '10px 0 0' }} />
          </div>
        )}

        <div style={{ padding: '16px 12px 10px' }}>
          <div className="cr-sidebar-section-label">Source</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {TOOL_SOURCES.map((t) => (
              <SidebarRowItem
                key={t.id}
                active={toolFilter === t.id}
                onClick={() => setToolFilter(t.id)}
                data-testid={`tool-filter-${t.id}`}
                icon={
                  t.id === 'all' ? (
                    <Icon name={t.icon} size={14} />
                  ) : (
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.color, flexShrink: 0 }} />
                  )
                }
                label={t.label}
              />
            ))}
          </div>
        </div>

        {(extraSections || []).map((section) => (
          <React.Fragment key={section.heading}>
            <div style={{ height: 1, background: 'var(--cr-line-1)', margin: '6px 12px 0' }} />
            <div style={{ padding: '10px 12px 0' }}>
              <div className="cr-sidebar-section-label">{section.heading}</div>
            </div>
            <div style={{ padding: '2px 12px 6px', display: 'flex', flexDirection: 'column', gap: 1 }}>
              {section.rows.map((row) => (
                <SidebarRowItem
                  key={row.id}
                  active={row.on}
                  onClick={row.onClick}
                  data-testid={row.testId}
                  icon={
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

        <div style={{ height: 1, background: 'var(--cr-line-1)', margin: '6px 12px 0' }} />
        <div style={{ padding: '10px 12px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="cr-sidebar-section-label" style={{ marginBottom: 0 }}>Projects</div>
        </div>
        <div style={{ padding: '4px 12px 16px', display: 'flex', flexDirection: 'column', gap: 1 }}>
          <SidebarRowItem
            active={selected === null}
            onClick={() => onSelect(null)}
            data-testid="project-all"
            icon={<Icon name="database" size={14} />}
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

function TreeRow({
  node, depth, selected, onSelect,
}: {
  node: ProjectTreeNode;
  depth: number;
  selected: string | null;
  onSelect: (p: string | null) => void;
}) {
  const hasChildren = node.children.length > 0;
  // Untracked footer + workspaces default-open=false so they don't dominate
  // the sidebar; real workspaces (auto-detected) open so users see their
  // repos. Anything else with children opens by default.
  const startOpen = node.source !== 'untracked';
  const [open, setOpen] = useState(startOpen);
  const isSelected = selected === node.fullPath;
  const isUntracked = node.source === 'untracked' || node.source === 'path';
  const pl = 8 + depth * 14;

  // Workspace rows are a grouping affordance; clicking still filters
  // to the workspace project_id (rollup), which is desired.
  return (
    <>
      <div
        onClick={() => onSelect(node.fullPath)}
        data-testid={hasChildren ? 'project-folder' : 'project-item'}
        data-path={node.fullPath}
        className={`cr-sidebar-row${isSelected ? ' active' : ''}${depth > 0 ? ' indent' : ''}`}
        title={node.orphan ? `${node.name} (folder no longer exists)` : node.name}
        style={{
          paddingLeft: pl,
          paddingRight: 8,
          height: depth > 0 ? 28 : 32,
          opacity: node.orphan ? 0.55 : 1,
          fontStyle: node.orphan ? 'italic' : undefined,
        }}
      >
        <span className="cr-sidebar-row-icon">
          {hasChildren ? (
            <>
              <button
                type="button"
                data-testid="tree-chevron"
                onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'transparent', border: 'none', padding: 0,
                  cursor: 'pointer', width: 18, height: 18,
                  color: 'inherit', borderRadius: 3,
                }}
              >
                <Icon
                  name="chevronRight"
                  size={11}
                  style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
                />
              </button>
              <Icon
                name={isUntracked ? 'archive' : 'folder'}
                size={13}
                style={{ marginLeft: 2, opacity: isSelected ? 1 : 0.65 }}
              />
            </>
          ) : (
            <Avatar name={(node.name.split('/').pop() || node.name)} size={18} />
          )}
        </span>
        <span className="cr-sidebar-row-label">
          {depth > 0 && !hasChildren ? (node.name.split('/').pop() || node.name) : node.name}
          {node.orphan && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 9,
                padding: '1px 4px',
                borderRadius: 3,
                background: 'var(--cr-ink-2)',
                color: 'var(--cr-fg-3)',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
              title="The original folder for this transcript no longer exists on disk"
            >
              orphan
            </span>
          )}
        </span>
        <span className="cr-sidebar-row-count">{node.totalCount}</span>
      </div>

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

function SidebarRowItem({
  active, onClick, icon, label, count,
  'data-testid': testId,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  'data-testid'?: string;
}) {
  return (
    <div
      onClick={onClick}
      data-testid={testId}
      className={`cr-sidebar-row${active ? ' active' : ''}`}
      title={label}
    >
      <span className="cr-sidebar-row-icon">{icon}</span>
      <span className="cr-sidebar-row-label">{label}</span>
      {count != null && (
        <span className="cr-sidebar-row-count" style={{ opacity: active ? 1 : 0.7 }}>
          {count}
        </span>
      )}
    </div>
  );
}
