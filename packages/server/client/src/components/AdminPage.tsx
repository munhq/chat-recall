import React, { useState, useEffect } from 'react';
import { Card, MetricCard, Icon, Button, Input, Chip } from './primitives';
import { getAdminMetrics, getCodeProjects, type AdminMetricsResponse, type CodeProject } from '../services/api';

interface AdminPageProps {
  onClose?: () => void;
}

function fmtBytes(n?: number): string {
  if (n == null || isNaN(n) || n === 0) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtTokens(n?: number): string {
  if (n == null || isNaN(n) || n === 0) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function relTime(ms?: number): string {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'now';
  const m = s / 60; if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24; if (d < 7) return `${Math.round(d)}d ago`;
  return new Date(ms).toLocaleDateString();
}

export default function AdminPage({ onClose }: AdminPageProps) {
  const [adminKeyInput, setAdminKeyInput] = useState(() => localStorage.getItem('cr-admin-key') || '');
  const [isAuthed, setIsAuthed] = useState(false);
  const [metrics, setMetrics] = useState<AdminMetricsResponse | null>(null);
  const [projects, setProjects] = useState<CodeProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      // First load metrics which confirms admin status
      const m = await getAdminMetrics();
      setMetrics(m);
      setIsAuthed(true);

      // Then load indexed code projects to display companion details
      const p = await getCodeProjects();
      setProjects(p);
    } catch (err: any) {
      setError(err.message || 'Authentication or query failed.');
      if (err.message?.includes('401') || err.message?.includes('403') || err.message?.includes('key')) {
        setIsAuthed(false);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSaveKey = () => {
    localStorage.setItem('cr-admin-key', adminKeyInput.trim());
    loadData();
  };

  const handleClearKey = () => {
    localStorage.removeItem('cr-admin-key');
    setAdminKeyInput('');
    setIsAuthed(false);
    setMetrics(null);
  };

  if (!isAuthed && !loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--cr-ink-0)', padding: 20 }}>
        <Card style={{ maxWidth: 440, width: '100%', padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <span style={{ color: 'var(--cr-warn-500)', background: 'var(--cr-warn-surf)', display: 'inline-flex', padding: 8, borderRadius: '50%' }}>
              <Icon name="shield" size={24} />
            </span>
            <h3 style={{ margin: 0 }}>Admin Key Required</h3>
          </div>
          <p style={{ fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.5, marginBottom: 20 }}>
            This panel is restricted to platform operators. Please provide the server's <code>ADMIN_KEY</code> to authenticate and view cross-tenant system intelligence.
          </p>
          {error && (
            <div style={{ padding: '8px 12px', background: 'var(--cr-err-surf)', border: '1px solid var(--cr-err-line)', borderRadius: 'var(--cr-radius-sm)', color: 'var(--cr-err-500)', fontSize: 12.5, marginBottom: 16 }}>
              {error}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Input
              type="password"
              placeholder="Enter ADMIN_KEY"
              value={adminKeyInput}
              onChange={(e) => setAdminKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveKey(); }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {onClose && <Button variant="secondary" onClick={onClose}>Cancel</Button>}
              <Button variant="primary" onClick={handleSaveKey} disabled={!adminKeyInput.trim()}>
                Authenticate
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="cr-dashboard" style={{ flex: 1, overflowY: 'auto', background: 'var(--cr-ink-0)' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 40px 64px' }}>
        
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2>Admin Console</h2>
              <Chip kind="brand" size="sm">Operator</Chip>
            </div>
            <p className="cr-lead" style={{ marginTop: 4 }}>
              System-wide diagnostics, tenant database footprints, and local companion codeindex metrics.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={loadData} disabled={loading}>
              <Icon name="refresh" size={13} style={{ marginRight: 6 }} /> Refresh
            </Button>
            <Button variant="ghost" onClick={handleClearKey}>
              Lock Console
            </Button>
            {onClose && (
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
            )}
          </div>
        </div>

        {loading && !metrics ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>
            Loading operator analytics…
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
            
            {/* System Totals */}
            {metrics && (
              <div>
                <h3 style={{ marginBottom: 12 }}>System footprint</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                  <MetricCard label="Active Tenants" value={String(metrics.totals.tenants)} icon="database" />
                  <MetricCard label="Total Sessions" value={String(metrics.totals.sessions)} icon="message" />
                  <MetricCard label="Indexed Chunks" value={fmtTokens(metrics.totals.chunks)} sub="FTS & Vector chunks" icon="zap" />
                  <MetricCard label="Raw Files" value={String(metrics.totals.raw)} sub="Compressed raw JSONs" icon="file" />
                  <MetricCard label="Security Findings" value={String(metrics.totals.findings)} tone={metrics.totals.findings > 0 ? 'cost' : 'neutral'} icon="shield" />
                  <MetricCard label="Verified Secrets" value={String(metrics.totals.verified)} tone={metrics.totals.verified > 0 ? 'err' : 'ok'} icon="check" />
                </div>
              </div>
            )}

            {/* Tenant Breakdown */}
            {metrics && (
              <Card style={{ padding: 24 }}>
                <h3 style={{ marginTop: 0, marginBottom: 6 }}>Tenant database footprints</h3>
                <p style={{ fontSize: 12, color: 'var(--cr-fg-3)', margin: '0 0 16px' }}>
                  Granular counts of active database rows per workspace tenant.
                </p>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--cr-line-2)', color: 'var(--cr-fg-3)', fontWeight: 600 }}>
                        <th style={{ padding: '8px 12px' }}>Tenant Slug</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right' }}>Sessions</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right' }}>Indexed Chunks</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right' }}>Raw Files</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right' }}>Findings</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right' }}>Verified Secrets</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.tenants.map((t) => (
                        <tr key={t.tenant} style={{ borderBottom: '1px solid var(--cr-line-1)' }}>
                          <td style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--cr-fg-1)' }}>{t.tenant}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--cr-font-mono)' }}>{t.sessions.toLocaleString()}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--cr-font-mono)' }}>{t.chunks.toLocaleString()}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--cr-font-mono)' }}>{t.raw.toLocaleString()}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--cr-font-mono)' }}>{t.findings.toLocaleString()}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--cr-font-mono)', fontWeight: t.verified > 0 ? 600 : 400, color: t.verified > 0 ? 'var(--cr-err-500)' : 'inherit' }}>{t.verified.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {/* Code Indexer Setup & Companion Metrics */}
            <Card style={{ padding: 24 }}>
              <h3 style={{ marginTop: 0, marginBottom: 6 }}>Companion Indexer Workspaces</h3>
              <p style={{ fontSize: 12, color: 'var(--cr-fg-3)', margin: '0 0 16px' }}>
                Local workspace footprints processed by <code>codeindex</code> companion binary, containing outline token savings and sequence information.
              </p>
              {projects.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--cr-fg-3)', fontSize: 13 }}>
                  No indexed code projects found in the database. Run <code>chat-recall code index</code> to index a workspace.
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--cr-line-2)', color: 'var(--cr-fg-3)', fontWeight: 600 }}>
                        <th style={{ padding: '8px 12px' }}>Project Path</th>
                        <th style={{ padding: '8px 12px', textAlign: 'center' }}>Health</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right' }}>Files & Syms</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right' }}>Text Footprint</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right' }}>Token Savings (Outline vs Full)</th>
                        <th style={{ padding: '8px 12px', textAlign: 'center' }}>Watcher</th>
                        <th style={{ padding: '8px 12px', textAlign: 'center' }}>Sequence / Version</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right' }}>Last Indexed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {projects.map((p) => {
                        const h = p.health;
                        const savings = h.savingsPct != null ? Math.round(h.savingsPct) : null;
                        return (
                          <tr key={p.projectId} style={{ borderBottom: '1px solid var(--cr-line-1)' }}>
                            <td style={{ padding: '12px 12px', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.rootPath}>
                              <div style={{ fontWeight: 600, color: 'var(--cr-fg-1)' }}>{p.rootPath.split('/').pop()}</div>
                              <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>{p.rootPath}</div>
                            </td>
                            <td style={{ padding: '12px 12px', textAlign: 'center' }}>
                              <Chip kind={h.score >= 70 ? 'ok' : h.score >= 40 ? 'warn' : 'err'} size="sm">
                                {h.score}/100
                              </Chip>
                            </td>
                            <td style={{ padding: '12px 12px', textAlign: 'right' }}>
                              <div style={{ fontWeight: 500 }}>{p.fileCount.toLocaleString()} files</div>
                              <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>{p.symbolCount.toLocaleString()} symbols</div>
                            </td>
                            <td style={{ padding: '12px 12px', textAlign: 'right' }}>
                              {h.totalLines != null ? (
                                <>
                                  <div style={{ fontWeight: 500 }}>{h.totalLines.toLocaleString()} lines</div>
                                  <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>{fmtBytes(h.totalBytes)}</div>
                                </>
                              ) : (
                                <span style={{ color: 'var(--cr-fg-3)' }}>—</span>
                              )}
                            </td>
                            <td style={{ padding: '12px 12px', textAlign: 'right' }}>
                              {savings != null ? (
                                <>
                                  <div style={{ fontWeight: 600, color: 'var(--cr-ok-500)' }}>{savings}% saved</div>
                                  <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>
                                    {fmtTokens(h.outlineTokens)} outline / {fmtTokens(h.naiveTokens)} full
                                  </div>
                                </>
                              ) : (
                                <span style={{ color: 'var(--cr-fg-3)' }}>—</span>
                              )}
                            </td>
                            <td style={{ padding: '12px 12px', textAlign: 'center' }}>
                              {h.watcher != null ? (
                                <Chip kind={h.watcher ? 'ok' : 'neutral'} size="sm">
                                  {h.watcher ? 'Active' : 'Idle'}
                                </Chip>
                              ) : (
                                <span style={{ color: 'var(--cr-fg-3)' }}>—</span>
                              )}
                            </td>
                            <td style={{ padding: '12px 12px', textAlign: 'center', fontFamily: 'var(--cr-font-mono)', fontSize: 11.5 }}>
                              <div>seq {h.latestSeq ?? '—'}</div>
                              <div style={{ fontSize: 10, color: 'var(--cr-fg-3)' }}>coll v{p.collectorVersion ?? '—'}</div>
                            </td>
                            <td style={{ padding: '12px 12px', textAlign: 'right', fontSize: 12, color: 'var(--cr-fg-2)' }}>
                              {relTime(p.lastIndexedAt)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

          </div>
        )}

      </div>
    </div>
  );
}
