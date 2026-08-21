import { useState } from 'react';
import { Button, Input } from './primitives';
import {
  dataExportUrl, deleteProjectData, deleteAllData, DELETE_ALL_PHRASE,
} from '../services/api';

/**
 * Export and delete your own data.
 *
 * Two rules shaped this panel.
 *
 * Export comes FIRST, and is one click. It is the thing a person wants before
 * they delete anything, and the thing they are entitled to whether or not they
 * are still paying — so it is a plain link to a streamed download rather than a
 * fetch, and it keeps working after a subscription lapses because the endpoint is
 * a GET.
 *
 * Deleting everything requires typing a phrase we do not pre-fill. For an action
 * with no undo, a checkbox is a misclick waiting to happen; typing "delete
 * everything" is a decision. The button stays disabled until it matches, and the
 * copy says plainly that it cannot be undone rather than hinting at it.
 */
export default function DataControls({ projects }: { projects: string[] }) {
  const [project, setProject] = useState('');
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState<'project' | 'all' | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  async function delProject() {
    if (!project) return;
    setBusy('project'); setErr(''); setMsg('');
    try {
      const r = await deleteProjectData(project);
      setMsg(`Deleted ${r.deleted} session${r.deleted === 1 ? '' : 's'} from ${project}.`);
      setProject('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'delete failed');
    } finally { setBusy(null); }
  }

  async function delAll() {
    setBusy('all'); setErr(''); setMsg('');
    try {
      const r = await deleteAllData(phrase);
      setMsg(`Deleted ${r.deleted} session${r.deleted === 1 ? '' : 's'}. Your history is gone.`);
      setPhrase('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'delete failed');
    } finally { setBusy(null); }
  }

  const phraseOk = phrase.trim().toLowerCase() === DELETE_ALL_PHRASE;

  return (
    <section className="acct-card">
      <h2>Your data</h2>
      <style>{DC_CSS}</style>

      {err && <div className="dc-err" role="alert">{err}</div>}
      {msg && <div className="dc-ok" role="status">{msg}</div>}

      <p className="muted">
        Take a copy of everything we hold, as one file — one JSON object per line,
        so it stays readable in any tool. This keeps working even if your
        subscription ends.
      </p>
      <div className="acct-actions">
        {/* A link, not a fetch: the browser already knows how to stream a file to
            disk, and pulling it through memory first only adds a way to fail. */}
        <a className="dc-dl" href={dataExportUrl()} download>Export everything</a>
      </div>

      {projects.length > 0 && (
        <>
          <h3 className="dc-h3">Delete one project</h3>
          <p className="muted">
            Removes every session recorded under that project, here and on your
            other machines. The next sync will not put it back.
          </p>
          <div className="acct-actions">
            <select className="dc-sel" value={project} aria-label="Project to delete"
                    onChange={(e) => setProject(e.target.value)}>
              <option value="">Choose a project…</option>
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <Button variant="secondary" disabled={!project || busy !== null} onClick={delProject}>
              {busy === 'project' ? 'Deleting…' : 'Delete project'}
            </Button>
          </div>
        </>
      )}

      <h3 className="dc-h3 dc-danger-h">Delete everything</h3>
      <p className="muted">
        Every session, on every machine, permanently. This cannot be undone and we
        cannot recover it for you. Export first if you want a copy.
      </p>
      <div className="acct-actions">
        <Input
          placeholder={`Type "${DELETE_ALL_PHRASE}"`}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          aria-label={`Type ${DELETE_ALL_PHRASE} to confirm`}
        />
        <Button variant="danger" disabled={!phraseOk || busy !== null} onClick={delAll}>
          {busy === 'all' ? 'Deleting…' : 'Delete everything'}
        </Button>
      </div>
    </section>
  );
}

const DC_CSS = `
.dc-err { background: var(--cr-err-surf); color: var(--cr-err-500);
  border: 1px solid var(--cr-err-line); padding: 8px 12px;
  border-radius: var(--cr-radius-md); margin-bottom: 12px; font-size: 13px; }
.dc-ok { background: var(--cr-ok-surf); color: var(--cr-ok-500);
  border: 1px solid var(--cr-ok-line); padding: 8px 12px;
  border-radius: var(--cr-radius-md); margin-bottom: 12px; font-size: 13px; }
.dc-h3 { font-size: 13px; font-weight: 600; color: var(--cr-fg-1);
  margin: 22px 0 6px; }
/* The only red heading on the page, so the irreversible section is the one thing
   that stands out rather than every control shouting equally. */
.dc-danger-h { color: var(--cr-err-500); }
.dc-sel { border: 1px solid var(--cr-line-1); border-radius: var(--cr-radius-sm);
  padding: 7px 9px; background: var(--cr-ink-2); color: var(--cr-fg-1); font-size: 13px; }
.dc-dl { display: inline-flex; align-items: center; height: 34px; padding: 0 14px;
  border-radius: var(--cr-radius-sm); border: 1px solid var(--cr-line-2);
  background: var(--cr-ink-2); color: var(--cr-fg-1); font-size: 13px;
  text-decoration: none; transition: border-color var(--cr-dur-fast); }
.dc-dl:hover { border-color: var(--cr-brand-line); }
.dc-dl:focus-visible { outline: 2px solid var(--cr-brand-500); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .dc-dl { transition: none; } }
`;
