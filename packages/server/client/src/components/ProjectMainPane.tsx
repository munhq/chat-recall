/**
 * ProjectMainPane — tab strip shown above the main content area when a
 * project filter is active. Three tabs:
 *
 *   - Conversations  → existing ConversationList + right-side ConversationViewer
 *   - Dossier        → editorial markdown report from /api/projects/:id/dossier
 *   - Activity       → per-project ActivityTimeline
 *
 * Per-project tab selection persists in localStorage so power-users who
 * always want Conversations don't get teleported to Dossier on every
 * project switch. First-ever click on a project lands on Dossier (the
 * "what is this project" view).
 */

import { useEffect, useMemo, useState } from 'react';

import DossierView from './DossierView';
import { Icon } from './primitives';

export type ProjectTab = 'conversations' | 'dossier' | 'activity';

interface Props {
  projectId: string;
  /** Human-readable display name for the header. */
  displayName?: string;
  /** Each render-prop owns its tab's body so this component stays layout-only. */
  renderConversations: () => React.ReactNode;
  renderActivity: () => React.ReactNode;
}

const STORAGE_PREFIX = 'cr-project-tab:';

export default function ProjectMainPane({
  projectId,
  displayName,
  renderConversations,
  renderActivity,
}: Props) {
  const storageKey = `${STORAGE_PREFIX}${projectId}`;

  // First visit → Dossier (introduces the project).
  // Subsequent visits → whatever the user picked last for this project.
  const [tab, setTab] = useState<ProjectTab>(() => readSavedTab(storageKey));

  useEffect(() => {
    setTab(readSavedTab(storageKey));
  }, [storageKey]);

  useEffect(() => {
    try { localStorage.setItem(storageKey, tab); } catch { /* private mode */ }
  }, [storageKey, tab]);

  const tabs = useMemo<Array<{ id: ProjectTab; label: string; icon: string }>>(() => [
    { id: 'conversations', label: 'Conversations', icon: 'message' },
    { id: 'dossier', label: 'Dossier', icon: 'document' },
    { id: 'activity', label: 'Activity', icon: 'clock' },
  ], []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
      <ProjectTabStrip
        tabs={tabs}
        active={tab}
        onChange={setTab}
        displayName={displayName}
        projectId={projectId}
      />
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {tab === 'conversations' && renderConversations()}
        {tab === 'dossier' && <DossierView projectId={projectId} />}
        {tab === 'activity' && renderActivity()}
      </div>
    </div>
  );
}

function ProjectTabStrip({
  tabs, active, onChange, displayName, projectId,
}: {
  tabs: Array<{ id: ProjectTab; label: string; icon: string }>;
  active: ProjectTab;
  onChange: (t: ProjectTab) => void;
  displayName?: string;
  projectId: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 16px',
        height: 44,
        background: 'var(--cr-ink-1)',
        borderBottom: '1px solid var(--cr-line-1)',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, marginRight: 'auto' }}>
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--cr-fg-1)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {displayName || projectId}
        </span>
        <span
          style={{
            fontSize: 10,
            color: 'var(--cr-fg-3)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        >
          {projectId}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 2 }}>
        {tabs.map(t => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              data-testid={`project-tab-${t.id}`}
              onClick={() => onChange(t.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 30,
                padding: '0 12px',
                background: on ? 'var(--cr-ink-2)' : 'transparent',
                color: on ? 'var(--cr-fg-1)' : 'var(--cr-fg-2)',
                border: 'none',
                borderRadius: 6,
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: on ? 500 : 400,
                cursor: 'pointer',
                transition: 'background var(--cr-dur-fast), color var(--cr-dur-fast)',
              }}
            >
              <Icon name={t.icon} size={13} />
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function readSavedTab(key: string): ProjectTab {
  try {
    const saved = localStorage.getItem(key);
    if (saved === 'conversations' || saved === 'dossier' || saved === 'activity') {
      return saved;
    }
  } catch { /* private mode */ }
  // Default: conversations — the thing you're here for. The dossier is a
  // tab, not a gate. (Per-project choice persists in localStorage.)
  return 'conversations';
}
