import React, { useState, useEffect, useMemo } from 'react';
import { Card, Chip, Input, Button, Icon, SegmentedControl, Schedule } from './primitives';
import type { ProjectTreeNode } from '../App';
import { getCodeProjects, type CodeProject } from '../services/api';
import ActivityTimeline from './ActivityTimeline';
import CodeExplorer from './CodeExplorer';
import FindingsPanel from './FindingsPanel';

interface ProjectsDashboardProps {
  tree: ProjectTreeNode[];
  loaded?: boolean;
  onPick: (id: string) => void;
  toolFilter: string;
  onSessionClick: (sessionId: string) => void;
  onActiveProjects?: (byProject: Record<string, number>) => void;
  /** Surface repos with the most critical findings / hotspots first — carries
   *  the intent of a Command Center metric click. */
  emphasis?: 'critical' | 'hotspots' | null;
  onClearEmphasis?: () => void;
}

type TabId = 'repos' | 'findings' | 'activity' | 'code';

export default function ProjectsDashboard({
  tree,
  loaded,
  onPick,
  toolFilter,
  onSessionClick,
  onActiveProjects,
  emphasis,
  onClearEmphasis,
}: ProjectsDashboardProps) {
  const [activeTab, setActiveTab] = useState<TabId>('repos');
  // A metric click lands on the surface that answers it: "critical findings"
  // opens the cross-project Findings worklist; "hotspots" sorts the repo grid.
  useEffect(() => {
    if (emphasis === 'critical') setActiveTab('findings');
    else if (emphasis === 'hotspots') setActiveTab('repos');
  }, [emphasis]);
  const [searchQuery, setSearchQuery] = useState('');
  const [codeProjects, setCodeProjects] = useState<CodeProject[]>([]);
  const [loadingCodeProjects, setLoadingCodeProjects] = useState(false);

  // Fetch project health details (file count, symbol count, score)
  useEffect(() => {
    if (activeTab === 'repos') {
      setLoadingCodeProjects(true);
      getCodeProjects()
        .then(setCodeProjects)
        .catch(console.error)
        .finally(() => setLoadingCodeProjects(false));
    }
  }, [activeTab]);

  // Flatten sidebar project tree to leaves
  const flatTree = useMemo(() => {
    const flat: Array<{ name: string; id: string; count: number; lastMtime?: number; source?: string }> = [];
    const walk = (nodes: ProjectTreeNode[]) => {
      for (const n of nodes) {
        const isGroup = n.source === 'untracked' || n.source === 'automation' || n.fullPath.endsWith(':all');
        if (!isGroup && n.count > 0) {
          flat.push({
            name: n.name,
            id: n.fullPath,
            count: n.count,
            lastMtime: n.lastMtime,
            source: n.source,
          });
        }
        if (n.children?.length) walk(n.children);
      }
    };
    walk(tree);
    return flat;
  }, [tree]);

  // Friendly name for a project_id — prefer the tree's display name, else strip
  // the git:host/owner/ prefix so a finding reads "munbot", not the full id.
  const projectNameOf = useMemo(() => {
    const map = new Map(flatTree.map((p) => [p.id, p.name]));
    return (id: string) => map.get(id) || id.replace(/^git:[^/]+\/[^/]+\//, '').replace(/^(git|path|ws):/, '');
  }, [flatTree]);

  // Combine flatTree items with rich CodeProject details
  const projects = useMemo(() => {
    const codeMap = new Map(codeProjects.map(p => [p.projectId, p]));
    return flatTree.map(item => {
      // Find matching code project by checking project ID or matching paths
      const projectDetails = codeMap.get(item.id) || codeProjects.find(p => p.rootPath.includes(item.name) || item.id.includes(p.projectId));
      return {
        ...item,
        details: projectDetails,
      };
    });
  }, [flatTree, codeProjects]);

  // Filter based on search query, then (when a metric was clicked) sort the
  // relevant metric to the top so the intent of the click is honored.
  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const base = q
      ? projects.filter(p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      : projects;
    if (!emphasis) return base;
    const metric = (p: typeof base[number]) =>
      emphasis === 'critical' ? (p.details?.health?.critical ?? 0) : (p.details?.health?.hotspots ?? 0);
    return [...base].sort((a, b) => metric(b) - metric(a));
  }, [projects, searchQuery, emphasis]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header */}
      <div className="cr-pad-mobile" style={{ padding: '24px 28px 12px', flexShrink: 0 }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          Projects &amp; Activity
        </h2>
        <div style={{ color: 'var(--cr-fg-2)', fontSize: 13, marginTop: 4 }}>
          Browse repo workspaces, overall code outlines, file edits timelines and project insights.
        </div>
      </div>

      {/* Tabs */}
      <div style={{ padding: '0 28px 12px', flexShrink: 0, borderBottom: '1px solid var(--cr-line-1)' }}>
        <SegmentedControl
          value={activeTab}
          onChange={(v) => setActiveTab(v as TabId)}
          options={[
            { value: 'repos', label: 'Active Repositories' },
            { value: 'findings', label: 'Findings' },
            { value: 'activity', label: 'Global Activity' },
            { value: 'code', label: 'System Code Map' },
          ]}
        />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {activeTab === 'repos' && (
          <div className="cr-pad-mobile" style={{ padding: '20px 28px 40px' }}>
            {emphasis && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '8px 12px', fontSize: 13, color: 'var(--cr-fg-1)', background: 'var(--cr-brand-surf)', border: '1px solid var(--cr-brand-line)', borderRadius: 0 }}>
                <span>Sorted by <b>{emphasis === 'critical' ? 'critical findings' : 'hotspots'}</b> — repos with the most appear first.</span>
                <span style={{ flex: 1 }} />
                <button onClick={onClearEmphasis} style={{ background: 'none', border: 'none', color: 'var(--cr-brand-500)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Clear</button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 12, marginBottom: 18, maxWidth: 480 }}>
              <Input
                icon="search"
          placeholder="Filter repositories..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onClear={searchQuery ? () => setSearchQuery('') : undefined}
                inputSize="md"
                style={{ width: '100%' }}
              />
            </div>

            {/* NOT A CARD GRID. This was a gapped 3-across grid of framed boxes,
                each carrying a name, a path, a big number and a timestamp — the
                shape this whole world replaced, and the ink frame only made it
                louder. A schedule ranks the same repositories, aligns every
                number into a column you can compare down, and reads the same at
                five rows or fifty. */}
            <Schedule
              scroll
              caption="Active repositories"
              cols={[
                { key: 'name', kind: 'pn', head: 'Repository' },
                { key: 'health', head: 'Health', kind: 'rt' },
                { key: 'sessions', kind: 'val', head: 'Sessions' },
                { key: 'files', kind: 'val', head: 'Files', optional: true },
                { key: 'symbols', kind: 'val', head: 'Symbols', optional: true },
                { key: 'active', kind: 'cmd', head: 'Last active', optional: true },
              ]}
              empty={loaded === false ? 'Loading active projects…' : 'No matching repositories found.'}
              rows={filteredProjects.map((p) => {
                const healthScore = p.details?.health?.score;
                const label = p.details?.label;
                const fileCount = p.details?.fileCount || 0;
                const symbolCount = p.details?.symbolCount || 0;
                return {
                  id: p.id,
                  onSelect: () => onPick(p.id),
                  cells: {
                    name: (
                      <>
                        <span className="mono" style={{ fontSize: 13.5, fontWeight: 600 }} title={p.name}>{p.name}</span>
                        <span className="pn-sub" title={p.id}>{p.id}</span>
                      </>
                    ),
                    health: healthScore != null
                      ? <Chip kind={healthScore >= 70 ? 'ok' : healthScore >= 40 ? 'warn' : 'err'} size="sm">{healthScore}</Chip>
                      : label ? <Chip kind="brand" size="sm">{label}</Chip> : null,
                    sessions: p.count,
                    files: fileCount || <span className="val-q">—</span>,
                    symbols: symbolCount || <span className="val-q">—</span>,
                    active: p.lastMtime ? fmtAgo(p.lastMtime) : '—',
                  },
                };
              })}
            />
          </div>
        )}

        {activeTab === 'findings' && (
          <FindingsPanel
            onOpenProject={onPick}
            projectNameOf={projectNameOf}
            initialSeverity={emphasis === 'critical' ? 'critical' : null}
          />
        )}

        {activeTab === 'activity' && (
          <ActivityTimeline
            onSessionClick={onSessionClick}
            toolFilter={toolFilter}
            projectFilter={null}
            onActiveProjects={onActiveProjects}
          />
        )}

        {activeTab === 'code' && (
          <CodeExplorer projectFilter={null} onSessionClick={onSessionClick} />
        )}
      </div>
    </div>
  );
}

function fmtAgo(ms?: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}
