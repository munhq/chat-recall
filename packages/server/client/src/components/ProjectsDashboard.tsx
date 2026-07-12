import React, { useState, useEffect, useMemo } from 'react';
import { Card, Chip, Input, Button, Icon, SegmentedControl } from './primitives';
import type { ProjectTreeNode } from '../App';
import { getCodeProjects, type CodeProject } from '../services/api';
import ActivityTimeline from './ActivityTimeline';
import CodeExplorer from './CodeExplorer';

interface ProjectsDashboardProps {
  tree: ProjectTreeNode[];
  loaded?: boolean;
  onPick: (id: string) => void;
  toolFilter: string;
  onSessionClick: (sessionId: string) => void;
  onActiveProjects?: (byProject: Record<string, number>) => void;
}

type TabId = 'repos' | 'activity' | 'code';

export default function ProjectsDashboard({
  tree,
  loaded,
  onPick,
  toolFilter,
  onSessionClick,
  onActiveProjects,
}: ProjectsDashboardProps) {
  const [activeTab, setActiveTab] = useState<TabId>('repos');
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

  // Filter based on search query
  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const q = searchQuery.toLowerCase().trim();
    return projects.filter(
      p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    );
  }, [projects, searchQuery]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header */}
      <div style={{ padding: '24px 28px 12px', flexShrink: 0 }}>
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
            { value: 'activity', label: 'Global Activity' },
            { value: 'code', label: 'System Code Map' },
          ]}
        />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {activeTab === 'repos' && (
          <div style={{ padding: '20px 28px 40px' }}>
            <div style={{ display: 'flex', gap: 12, marginBottom: 18, maxWidth: 480 }}>
              <Input
                placeholder="Filter repositories..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onClear={searchQuery ? () => setSearchQuery('') : undefined}
                inputSize="md"
                style={{ width: '100%' }}
              />
            </div>

            {filteredProjects.length === 0 ? (
              <div style={{ color: 'var(--cr-fg-3)', padding: '12px 0' }}>
                {loaded === false ? 'Loading active projects…' : 'No matching repositories found.'}
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
                {filteredProjects.map((p) => {
                  const healthScore = p.details?.health?.score;
                  const label = p.details?.label;
                  const fileCount = p.details?.fileCount || 0;
                  const symbolCount = p.details?.symbolCount || 0;
                  
                  return (
                    <Card
                      key={p.id}
                      interactive
                      onClick={() => onPick(p.id)}
                      style={{ padding: 18, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 12 }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                        <div style={{ overflow: 'hidden' }}>
                          <div
                            className="mono"
                            style={{
                              fontSize: 14,
                              fontWeight: 600,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              color: 'var(--cr-fg-1)'
                            }}
                            title={p.name}
                          >
                            {p.name}
                          </div>
                          <div
                            style={{
                              color: 'var(--cr-fg-3)',
                              fontSize: 11,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              marginTop: 2
                            }}
                            title={p.id}
                          >
                            {p.id}
                          </div>
                        </div>

                        {healthScore != null && (
                          <Chip
                            kind={healthScore >= 70 ? 'ok' : healthScore >= 40 ? 'warn' : 'err'}
                            size="sm"
                          >
                            {healthScore}
                          </Chip>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: 16, borderTop: '1px solid var(--cr-line-1)', paddingTop: 12 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cr-fg-1)' }}>{p.count}</div>
                          <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>sessions</div>
                        </div>
                        {fileCount > 0 && (
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cr-fg-1)' }}>{fileCount}</div>
                            <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>files</div>
                          </div>
                        )}
                        {symbolCount > 0 && (
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cr-fg-1)' }}>{symbolCount}</div>
                            <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>symbols</div>
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto', paddingTop: 4 }}>
                        {label ? (
                          <Chip kind="brand" size="sm">{label.toUpperCase()}</Chip>
                        ) : (
                          <div />
                        )}
                        {p.lastMtime && (
                          <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>
                            Active {fmtAgo(p.lastMtime)}
                          </span>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
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
