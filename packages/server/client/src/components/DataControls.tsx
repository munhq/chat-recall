import { useEffect, useState } from 'react';
import { Button, Input } from './primitives';
import {
  dataExportUrl, deleteProjectData, deleteAllData, DELETE_ALL_PHRASE,
  getRetention, setRetention, type RetentionState,
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
 *
 * The retention window follows the same rule for a harder case: it deletes on a
 * TIMER, so the person arming it is not present when it acts. The panel prices
 * the change first — "this removes 412 sessions" — and will not send it until
 * that count is acknowledged, because a number is the only thing that makes an
 * unattended deletion real to the person switching it on. It also says the part
 * that is easy to leave out: re-syncing recovers a session only while its
 * transcript still exists on a machine they have.
 */
export default function DataControls({ projects }: { projects: string[] }) {
  const [project, setProject] = useState('');
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState<'project' | 'all' | 'retention' | null>(null);
  const [ret, setRet] = useState<RetentionState | null>(null);
  const [retDays, setRetDays] = useState('');
  const [retPreview, setRetPreview] = useState<number | null>(null);
  const [retAck, setRetAck] = useState(false);
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

  useEffect(() => {
    getRetention().then((r) => { setRet(r); setRetDays(r.days ? String(r.days) : ''); }).catch(() => {});
  }, []);

  // Price the candidate as it is typed, so the count the user acknowledges is the
  // count for the window they are actually about to set.
  useEffect(() => {
    const n = Number(retDays);
    if (!retDays || !Number.isInteger(n) || n <= 0) { setRetPreview(null); return; }
    let live = true;
    const id = setTimeout(() => {
      getRetention(n).then((r) => { if (live) setRetPreview(r.wouldDelete); }).catch(() => {});
    }, 400);
    return () => { live = false; clearTimeout(id); };
  }, [retDays]);

  async function saveRetention(days: number) {
    setBusy('retention'); setErr(''); setMsg('');
    try {
      const r = await setRetention(days, true);
      setRet(await getRetention());
      setRetAck(false);
      setMsg(days === 0
        ? 'Retention window cleared — the server keeps everything you sync.'
        : `Retention window set to ${r.days} days. ${r.wouldDelete} session(s) will be removed on the next sweep.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not set the window');
    } finally { setBusy(null); }
  }

  const retN = Number(retDays);
  const retValid = !!ret && Number.isInteger(retN) && retN >= ret.min && retN <= ret.max;
  const retDestructive = (retPreview ?? 0) > 0;
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

      {ret && (
        <>
          <h3 className="dc-h3">How long we keep it</h3>
          <p className="muted">
            {ret.days
              ? `We delete anything older than ${ret.days} days, on a timer.`
              : 'We keep everything you sync, with no time limit. Set a window and we delete anything older.'}
          </p>
          <div className="acct-actions">
            <Input
              placeholder={`Days (${ret.min}–${ret.max})`}
              value={retDays}
              inputMode="numeric"
              onChange={(e) => { setRetDays(e.target.value); setRetAck(false); }}
              aria-label="Retention window in days"
            />
            <Button
              variant={retDestructive ? 'danger' : 'secondary'}
              disabled={!retValid || busy !== null || (retDestructive && !retAck)}
              onClick={() => saveRetention(retN)}
            >
              {busy === 'retention' ? 'Saving…' : 'Set window'}
            </Button>
            {!!ret.days && (
              <Button variant="secondary" disabled={busy !== null} onClick={() => saveRetention(0)}>
                Keep everything
              </Button>
            )}
          </div>

          {retValid && retDestructive && (
            /* The warning appears only when the change actually destroys
               something. Showing it for a window that deletes nothing would
               teach people to dismiss it. */
            <div className="dc-warn" role="alert">
              <strong>This deletes {retPreview} session{retPreview === 1 ? '' : 's'} now,</strong> and anything
              older than {retN} days from then on.
              <br />
              Re-syncing brings a session back <strong>only</strong> if its transcript is still on a machine you
              have. For a laptop you no longer own, history your AI tool has rotated, or files you deleted, our
              copy is the only copy — those are gone for good. Export first if you want one.
              <label className="dc-ack">
                <input type="checkbox" checked={retAck} onChange={(e) => setRetAck(e.target.checked)} />
                I understand {retPreview} session{retPreview === 1 ? '' : 's'} will be deleted and may not be recoverable
              </label>
            </div>
          )}
          {retValid && !retDestructive && (
            <p className="muted dc-small">Nothing you have synced is older than {retN} days, so this deletes nothing today.</p>
          )}
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
.dc-warn { background: var(--cr-err-surf); color: var(--cr-fg-1);
  border: 1px solid var(--cr-err-line); padding: 10px 12px;
  border-radius: var(--cr-radius-md); margin: 10px 0 4px; font-size: 13px; line-height: 1.5; }
.dc-ack { display: flex; align-items: flex-start; gap: 8px; margin-top: 10px; font-weight: 600; }
.dc-ack input { margin-top: 2px; }
.dc-small { font-size: 13px; margin-top: 8px; }
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
