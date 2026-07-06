import React, { useState } from 'react';
import { Icon } from './primitives';
import { TOOL_SOURCES } from '../services/tools';
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
  setView?: (v: 'home' | 'projects' | 'search' | 'memory' | 'toolkit' | 'dashboard' | 'activity' | 'security' | 'code' | 'settings' | 'account') => void;
  /** Views this deployment supports (/api/capabilities). Absent = all. */
  enabledViews?: Set<string>;
}

// Single source of truth for primary navigation — kept in sync with TopBar.
const MOBILE_NAV_ITEMS: Array<{ id: 'home' | 'projects' | 'search' | 'memory' | 'toolkit' | 'dashboard'; label: string; icon: string }> = [
  { id: 'home', label: 'Overview', icon: 'home' },
  { id: 'projects', label: 'Projects', icon: 'folder' },
  { id: 'search', label: 'Conversations', icon: 'message' },
  { id: 'memory', label: 'Memory', icon: 'brain' },
  { id: 'toolkit', label: 'Toolkit', icon: 'terminal' },
  { id: 'dashboard', label: 'Insights', icon: 'chart' },
];

// Tool source list comes from the central tools module — adding a tool
// there automatically appears here. See services/tools.ts.

export default function Sidebar({
  tree, totalCount, selected, onSelect,
  toolFilter, setToolFilter,
  extraSections,
  view, setView,
  enabledViews,
}: SidebarProps) {
  const navItems = MOBILE_NAV_ITEMS.filter((n) => !enabledViews || enabledViews.has(n.id));
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
              {navItems.map((n) => (
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

        {/* Recent: the leaf projects you touched most recently, so the thing
            you're likely to want is at the top instead of buried in a workspace
            sorted by lifetime count. Excludes grouping/automation/untracked. */}
        {(() => {
          const recent = recentProjects(tree, 5);
          if (recent.length === 0) return null;
          return (
            <>
              <div style={{ height: 1, background: 'var(--cr-line-1)', margin: '6px 12px 0' }} />
              <div style={{ padding: '10px 12px 2px' }}>
                <div className="cr-sidebar-section-label" style={{ marginBottom: 0 }}>Recent</div>
              </div>
              <div style={{ padding: '2px 12px 4px', display: 'flex', flexDirection: 'column', gap: 1 }}>
                {recent.map((node) => (
                  <ProjectRow key={`recent-${node.fullPath}`} node={node} depth={0}
                    selected={selected} onSelect={onSelect} showRecency />
                ))}
              </div>
            </>
          );
        })()}

        <div style={{ height: 1, background: 'var(--cr-line-1)', margin: '6px 12px 0' }} />
        <div style={{ padding: '10px 12px 4px' }}>
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

/** Newest-first leaf projects (real repos/paths, not workspace/automation/
 *  untracked group rows) — the "Recent" shortcut list. */
function recentProjects(tree: ProjectTreeNode[], limit: number): ProjectTreeNode[] {
  const leaves: ProjectTreeNode[] = [];
  const walk = (nodes: ProjectTreeNode[]) => {
    for (const n of nodes) {
      const isGroup = n.source === 'automation' || n.source === 'untracked' || n.fullPath.endsWith(':all');
      if (isGroup) continue;                       // skip group rows + their children
      if (n.children.length > 0) { walk(n.children); continue; }  // workspace → descend
      if (n.lastMtime && !n.orphan) leaves.push(n);
    }
  };
  walk(tree);
  return leaves.sort((a, b) => (b.lastMtime ?? 0) - (a.lastMtime ?? 0)).slice(0, limit);
}

/** Compact relative time: "now", "3h", "2d", "5w". */
function relTime(ms?: number): string {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'now';
  const m = s / 60; if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60; if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24; if (d < 7) return `${Math.round(d)}d`;
  const w = d / 7; if (w < 52) return `${Math.round(w)}w`;
  return `${Math.round(d / 365)}y`;
}

/** A single leaf project — name, optional recency, right-aligned tabular
 *  count. No avatar tile (it encoded nothing); the count + recency carry the
 *  signal. Selected state gets the accent bar via the shared .active class. */
function ProjectRow({
  node, depth, selected, onSelect, showRecency, muted,
}: {
  node: ProjectTreeNode;
  depth: number;
  selected: string | null;
  onSelect: (p: string | null) => void;
  showRecency?: boolean;
  muted?: boolean;
}) {
  const isSelected = selected === node.fullPath;
  const label = depth > 0 ? (node.name.split('/').pop() || node.name) : node.name;
  return (
    <div
      onClick={() => onSelect(node.fullPath)}
      data-testid="project-item"
      data-path={node.fullPath}
      className={`cr-sidebar-row${isSelected ? ' active' : ''}${depth > 0 ? ' indent' : ''}`}
      title={node.orphan ? `${node.name} (folder no longer exists)` : node.name}
      style={{
        paddingLeft: 8 + depth * 14, paddingRight: 8, height: 30,
        opacity: node.orphan ? 0.5 : muted ? 0.75 : 1,
        fontStyle: node.orphan ? 'italic' : undefined,
      }}
    >
      <span className="cr-sidebar-row-label" style={{ fontSize: 13 }}>{label}</span>
      {node.orphan && (
        <span style={{ marginLeft: 6, fontSize: 9, padding: '1px 4px', borderRadius: 3,
          background: 'var(--cr-ink-2)', color: 'var(--cr-fg-3)', letterSpacing: '0.04em', textTransform: 'uppercase' }}
          title="The original folder for this transcript no longer exists on disk">orphan</span>
      )}
      {showRecency && node.lastMtime && (
        <span style={{ fontSize: 10.5, color: 'var(--cr-fg-3)', fontFamily: 'var(--cr-font-mono)', marginLeft: 8 }}>
          {relTime(node.lastMtime)}
        </span>
      )}
      <span className="cr-sidebar-row-count"
        style={{ fontFamily: 'var(--cr-font-mono)', fontVariantNumeric: 'tabular-nums', marginLeft: 8 }}>
        {node.totalCount.toLocaleString()}
      </span>
    </div>
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
  const isAutomation = node.source === 'automation';
  const isUntracked = node.source === 'untracked';
  const muted = isAutomation || isUntracked;
  // Automation + untracked start collapsed (noise, kept out of the way);
  // real workspaces open so you see your repos.
  const [open, setOpen] = useState(!muted);
  const isSelected = selected === node.fullPath;

  // Leaf project → clean ProjectRow.
  if (!hasChildren) {
    return <ProjectRow node={node} depth={depth} selected={selected} onSelect={onSelect} muted={muted} />;
  }

  // Group row (workspace / automation / untracked): chevron + folder/archive.
  return (
    <>
      <div
        onClick={() => onSelect(node.fullPath)}
        data-testid="project-folder"
        data-path={node.fullPath}
        className={`cr-sidebar-row${isSelected ? ' active' : ''}${depth > 0 ? ' indent' : ''}`}
        title={node.name}
        style={{
          paddingLeft: 8 + depth * 14, paddingRight: 8, height: 32,
          opacity: muted ? 0.7 : 1,
          color: muted ? 'var(--cr-fg-2)' : undefined,
        }}
      >
        <span className="cr-sidebar-row-icon">
          <button
            type="button"
            data-testid="tree-chevron"
            onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent',
              border: 'none', padding: 0, cursor: 'pointer', width: 18, height: 18, color: 'inherit', borderRadius: 3 }}
          >
            <Icon name="chevronRight" size={11}
              style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
          </button>
          <Icon name={muted ? 'archive' : 'folder'} size={13}
            style={{ marginLeft: 2, opacity: isSelected ? 1 : 0.6 }} />
        </span>
        <span className="cr-sidebar-row-label" style={{ fontWeight: muted ? 400 : 600 }}>{node.name}</span>
        <span className="cr-sidebar-row-count"
          style={{ fontFamily: 'var(--cr-font-mono)', fontVariantNumeric: 'tabular-nums' }}>
          {node.totalCount.toLocaleString()}
        </span>
      </div>

      {open && node.children.map((c) => (
        <TreeRow key={c.fullPath} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
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
