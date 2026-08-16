/**
 * Settings → Projects card.
 *
 * Replaces the deleted ProjectsPane. Lives inside the Settings dialog
 * so projects.json edits sit next to other config (embeddings, summaries,
 * sources, privacy). Saving here calls PUT /api/projects which writes
 * the file and runs the in-process project_id backfill so the sidebar
 * tree refreshes on next poll.
 *
 * Capabilities:
 *   - Inline rename (display name override).
 *   - Mark/demote workspace.
 *   - Ignore pattern editor (glob).
 *
 * Sub-project declarations (children[]) are not in this v1 UI — users
 * who need a monorepo split can edit ~/.chat-recall/projects.json by
 * hand and the resolver will pick it up on save.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  getProjects,
  saveProjectsConfig,
  type AggregatedProject,
  type ProjectsConfig,
  type ProjectsResponse,
} from '../services/api';

export default function ProjectsSettingsCard() {
  const [data, setData] = useState<ProjectsResponse | null>(null);
  const [edit, setEdit] = useState<ProjectsConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await getProjects();
      setData(r);
      setEdit(r.config);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const dirty = useMemo(() => {
    if (!data || !edit) return false;
    return JSON.stringify(edit) !== JSON.stringify(data.config);
  }, [data, edit]);

  const onSave = async () => {
    if (!edit) return;
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const r = await saveProjectsConfig(edit);
      await reload();
      setStatus(`Saved. Re-bucketed ${r.changed_rows} row(s).`);
      setTimeout(() => setStatus(null), 4000);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  const rename = (id: string, name: string) => {
    if (!edit) return;
    const next = clone(edit);
    upsert(next, id, p => { p.name = name || undefined; });
    setEdit(next);
  };
  const toggleWs = (id: string, root: string) => {
    if (!edit) return;
    const next = clone(edit);
    upsert(next, id, p => {
      p.workspace = !p.workspace;
      if (p.workspace && !p.root) p.root = root;
    });
    setEdit(next);
  };
  const addIgnore = (m: string) => {
    if (!edit || !m.trim()) return;
    const next = clone(edit);
    next.ignore = next.ignore || [];
    if (next.ignore.find(r => r.match === m)) return;
    next.ignore.push({ match: m });
    setEdit(next);
  };
  const rmIgnore = (m: string) => {
    if (!edit) return;
    const next = clone(edit);
    next.ignore = (next.ignore || []).filter(r => r.match !== m);
    setEdit(next);
  };

  if (!data || !edit) {
    return <CardBox title="Projects">Loading…</CardBox>;
  }

  // Show only the top ~40 most-active to keep the dialog scrollable.
  const visibleProjects = data.all
    .filter(p => !p.project_id.startsWith('untracked:'))
    .sort((a, b) => b.items - a.items)
    .slice(0, 40);

  return (
    <CardBox
      title="Projects"
      hint="Group repos into workspaces, rename, and hide noise. Stored in ~/.chat-recall/projects.json."
      footer={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            style={{
              padding: '6px 14px',
              background: dirty ? 'var(--cr-brand-500, #6c8eff)' : 'var(--cr-ink-2)',
              border: '1px solid var(--cr-line-1)',
              borderRadius: 6,
              color: dirty ? '#fff' : 'var(--cr-fg-3)',
              fontSize: 12,
              cursor: dirty && !saving ? 'pointer' : 'not-allowed',
            }}
          >
            {saving ? 'Saving + re-bucketing…' : dirty ? 'Save & rebuild tree' : 'No changes'}
          </button>
          {status && <small style={{ color: 'var(--cr-ok-500, #5bc28e)' }}>{status}</small>}
        </div>
      }
    >
      {error && (
        <div style={{ padding: 8, color: 'var(--cr-err-500, #d33)', fontSize: 12 }}>{error}</div>
      )}

      <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginBottom: 8 }}>
        Showing top {visibleProjects.length} of {data.all.filter(p => !p.project_id.startsWith('untracked:')).length} projects by activity.
      </div>

      <div className="cr-tablescroll">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--cr-fg-1)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--cr-line-1)' }}>
              <Th>Name</Th>
              <Th>project_id</Th>
              <Th>Source</Th>
              <Th align="right">Items</Th>
              <Th>Workspace</Th>
            </tr>
          </thead>
          <tbody>
            {visibleProjects.map(p => (
              <Row
                key={p.project_id}
                project={p}
                nameOverride={nameOverride(edit, p.project_id)}
                isWorkspaceOverride={isWorkspaceOverride(edit, p.project_id)}
                onRename={(n) => rename(p.project_id, n)}
                onToggleWs={() => toggleWs(p.project_id, deriveRoot(p))}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--cr-line-1)' }}>
        <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, color: 'var(--cr-fg-1)' }}>
          Ignore patterns
        </div>
        <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginBottom: 8 }}>
          Folders matching these globs get no project_id. Use to hide PR-bot worktrees, /tmp scratch, etc.
        </div>
        <IgnoreList
          rules={(edit.ignore || []).map(r => r.match)}
          onAdd={addIgnore}
          onRemove={rmIgnore}
        />
      </div>
    </CardBox>
  );
}

/* -----------------------------------------------------------------------
 * Row + small primitives (kept local so this card has no cross-file
 * dependency on dialog-internal helpers).
 * --------------------------------------------------------------------- */

function Row({ project, nameOverride, isWorkspaceOverride, onRename, onToggleWs }: {
  project: AggregatedProject;
  nameOverride: string | undefined;
  isWorkspaceOverride: boolean | undefined;
  onRename: (n: string) => void;
  onToggleWs: () => void;
}) {
  const isWs = isWorkspaceOverride ?? project.is_workspace ?? false;
  return (
    <tr style={{ borderBottom: '1px solid var(--cr-line-1)' }}>
      <Td>
        <input
          type="text"
          defaultValue={nameOverride ?? project.display_name}
          placeholder={project.display_name}
          onBlur={e => {
            const v = e.currentTarget.value.trim();
            if (v && v !== project.display_name) onRename(v);
            else if (!v) onRename('');
          }}
          style={{
            width: '100%',
            // No minWidth: it would pin this column's min-content and make the
            // whole 5-column table unshrinkable. The table scrolls instead.
            background: 'transparent',
            border: '1px solid transparent',
            color: 'var(--cr-fg-1)',
            padding: '3px 6px',
            borderRadius: 4,
            fontFamily: 'inherit',
            fontSize: 12,
          }}
          onFocus={e => { e.currentTarget.style.border = '1px solid var(--cr-line-2)'; }}
          onBlurCapture={e => { e.currentTarget.style.border = '1px solid transparent'; }}
        />
      </Td>
      <Td><code style={{ fontSize: 10, color: 'var(--cr-fg-3)' }}>{project.project_id}</code></Td>
      <Td><span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>{project.source}</span></Td>
      <Td align="right">{project.items}</Td>
      <Td>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={isWs} onChange={onToggleWs} />
          <span style={{ fontSize: 11, color: 'var(--cr-fg-2)' }}>
            {isWs ? 'workspace' : 'project'}
          </span>
        </label>
      </Td>
    </tr>
  );
}

function CardBox({ title, hint, footer, children }: {
  title: string;
  hint?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: 'var(--cr-ink-1)',
        border: '1px solid var(--cr-line-1)',
        borderRadius: 8,
        padding: 18,
        marginBottom: 14,
      }}
    >
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: 'var(--cr-fg-1)' }}>{title}</h3>
        {hint && <small style={{ color: 'var(--cr-fg-3)', fontSize: 11 }}>{hint}</small>}
      </div>
      {children}
      {footer && <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--cr-line-1)' }}>{footer}</div>}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      style={{
        padding: '6px 8px',
        textAlign: align || 'left',
        color: 'var(--cr-fg-3)',
        fontWeight: 500,
        fontSize: 10,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </th>
  );
}
function Td({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td style={{ padding: '6px 8px', textAlign: align || 'left', verticalAlign: 'middle' }}>
      {children}
    </td>
  );
}

function IgnoreList({ rules, onAdd, onRemove }: { rules: string[]; onAdd: (m: string) => void; onRemove: (m: string) => void }) {
  const [draft, setDraft] = useState('');
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="**/node_modules/**, /home/user/claude/pr/bot/worktrees/**, /tmp/**"
          style={{
            flex: 1,
            padding: '6px 10px',
            background: 'var(--cr-ink-2)',
            border: '1px solid var(--cr-line-1)',
            borderRadius: 4,
            color: 'var(--cr-fg-1)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11,
          }}
        />
        <button
          onClick={() => { onAdd(draft); setDraft(''); }}
          style={{
            padding: '6px 12px',
            background: 'var(--cr-ink-2)',
            border: '1px solid var(--cr-line-1)',
            borderRadius: 4,
            color: 'var(--cr-fg-1)',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Add
        </button>
      </div>
      {rules.length === 0 ? (
        <small style={{ color: 'var(--cr-fg-3)' }}>No ignore rules.</small>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {rules.map(r => (
            <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', background: 'var(--cr-ink-2)', borderRadius: 3 }}>
              <code style={{ flex: 1, color: 'var(--cr-fg-1)', fontSize: 11 }}>{r}</code>
              <button
                onClick={() => onRemove(r)}
                style={{ background: 'transparent', border: 'none', color: 'var(--cr-fg-3)', cursor: 'pointer', fontSize: 11 }}
              >
                remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------- */

function clone(cfg: ProjectsConfig): ProjectsConfig {
  return JSON.parse(JSON.stringify(cfg));
}
function upsert(cfg: ProjectsConfig, id: string, mut: (p: NonNullable<ProjectsConfig['projects']>[number]) => void) {
  cfg.projects = cfg.projects || [];
  let entry = cfg.projects.find(p => p.id === id);
  if (!entry) {
    entry = { id, root: '' };
    cfg.projects.push(entry);
  }
  mut(entry);
  // Garbage-collect entries with no overrides.
  if (!entry.name && !entry.workspace && !(entry.children && entry.children.length)) {
    cfg.projects = cfg.projects.filter(p => p !== entry);
  }
}
function nameOverride(cfg: ProjectsConfig, id: string): string | undefined {
  return (cfg.projects || []).find(p => p.id === id)?.name;
}
function isWorkspaceOverride(cfg: ProjectsConfig, id: string): boolean | undefined {
  const entry = (cfg.projects || []).find(p => p.id === id);
  return entry ? !!entry.workspace : undefined;
}
function deriveRoot(p: AggregatedProject): string {
  // Best-effort: paths can derive from `path:` ids; everything else (git:, ws:)
  // we leave empty and let the resolver pick the canonical root.
  const m = /^path:(.+)$/.exec(p.project_id);
  return m ? m[1] : '';
}
