import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listTasks, createTask, updateTask, getTask, addTaskComment, getSessionOutcome,
  type TeamTask, type TeamTaskStatus, type TeamTaskComment, type SessionOutcomeResponse,
} from '../services/api';
import { Button, Chip, Icon, Input } from './primitives';

const COLUMNS: Array<{ status: TeamTaskStatus; label: string }> = [
  { status: 'todo', label: 'To do' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
];

type Member = { sub: string; email: string | null; role: string };

/**
 * The task board.
 *
 * What makes it worth having, when every team already owns a kanban: a card
 * carries `linkedSessionId`, so it shows whether the AI session attached to it
 * ACTUALLY shipped code — status, files, lines, commits — and opens the
 * conversation that did the work. Everywhere else a card records that somebody
 * said it was done. Here it can be checked.
 *
 * That is the only part nobody can copy, so it is the part that gets the space.
 * Deliberately absent: swimlanes, labels, estimates, sprints, burndown. Losing
 * to Linear on kanban features is certain and irrelevant.
 *
 * The previous version of this file styled itself with `var(--border, #e3e3e8)`,
 * `var(--surface, #fff)` and its own prefers-color-scheme block — none of which
 * are this app's tokens, so it rendered in hardcoded light grey inside a dark
 * product and ignored the theme toggle entirely. Everything here is --cr-*.
 */
export default function TeamTasks({ members, mySub }: { members: Member[]; mySub: string | null }) {
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<TeamTaskStatus | null>(null);

  const emailBySub = useMemo(() => {
    const m: Record<string, string> = {};
    for (const x of members) if (x.email) m[x.sub] = x.email;
    return m;
  }, [members]);
  const who = (sub: string | null) => (sub ? (emailBySub[sub] || (sub === mySub ? 'me' : sub.slice(0, 8))) : 'unassigned');
  /** Initials for the avatar chip: a board scans by shape, not by reading emails. */
  const initials = (sub: string | null) => {
    if (!sub) return '—';
    const name = emailBySub[sub] || sub;
    const local = name.split('@')[0] || name;
    const parts = local.split(/[._-]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || local.slice(0, 2).toUpperCase();
  };

  const refresh = useCallback(async () => {
    setErr('');
    try { setTasks(await listTasks()); } catch (e: any) { setErr(String(e.message || e)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function doCreate() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await createTask({ title: title.trim(), assigneeSub: assignee || null });
      setTitle(''); setAssignee('');
      await refresh();
    } catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  }

  /**
   * Move optimistically, then reconcile.
   *
   * A drag that waits for a round trip before the card moves feels broken, so the
   * card lands where it was dropped immediately and a failure puts it back — with
   * the server's message, which is how a Solo tenant learns that assigning to
   * someone else needs a team plan.
   */
  const move = useCallback(async (id: string, status: TeamTaskStatus) => {
    const before = tasks;
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, status } : t)));
    try { await updateTask(id, { status }); }
    catch (e: any) { setTasks(before); setErr(String(e.message || e)); }
  }, [tasks]);

  async function reassign(t: TeamTask, sub: string) {
    setBusy(true);
    try { await updateTask(t.id, { assigneeSub: sub || null }); await refresh(); }
    catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  }

  const byStatus = (s: TeamTaskStatus) => tasks.filter((t) => t.status === s);

  return (
    <div className="tt">
      <style>{TT_CSS}</style>
      {err && <div className="tt-err" role="alert">{err}</div>}

      <div className="tt-new">
        <Input placeholder="New task…" value={title}
               onChange={(e) => setTitle(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') void doCreate(); }} />
        {members.length > 0 && (
          <select className="tt-sel" value={assignee} aria-label="Assign to"
                  onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {members.map((m) => <option key={m.sub} value={m.sub}>{m.email || m.sub.slice(0, 8)}</option>)}
          </select>
        )}
        <Button variant="primary" onClick={doCreate} disabled={busy || !title.trim()}>Add</Button>
      </div>

      <div className="tt-board">
        {COLUMNS.map((col) => {
          const items = byStatus(col.status);
          return (
            <section
              key={col.status}
              className={`tt-col${overCol === col.status ? ' tt-col-over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setOverCol(col.status); }}
              onDragLeave={() => setOverCol((c) => (c === col.status ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                setOverCol(null);
                const id = dragId || e.dataTransfer.getData('text/plain');
                if (id) void move(id, col.status);
                setDragId(null);
              }}
            >
              <header className="tt-col-head">
                <span>{col.label}</span>
                <span className="tt-count">{items.length}</span>
              </header>

              {items.map((t) => (
                <article
                  key={t.id}
                  className={`tt-card${dragId === t.id ? ' tt-dragging' : ''}`}
                  draggable
                  onDragStart={(e) => { setDragId(t.id); e.dataTransfer.setData('text/plain', t.id); }}
                  onDragEnd={() => setDragId(null)}
                >
                  <div className="tt-title">{t.title}</div>

                  {/* The differentiator: did the session attached to this card
                      actually ship anything? */}
                  {t.linkedSessionId && <SessionOutcome sessionId={t.linkedSessionId} />}

                  <div className="tt-meta">
                    {t.projectId && <Chip kind="neutral" size="sm">{t.projectId}</Chip>}
                    {t.blockedBy.length > 0 && (
                      <Chip kind="warn" size="sm">blocked by {t.blockedBy.length}</Chip>
                    )}
                    {t.due != null && (
                      <span className={`tt-due${t.due < Date.now() ? ' tt-overdue' : ''}`}>
                        {new Date(t.due).toLocaleDateString()}
                      </span>
                    )}
                  </div>

                  <footer className="tt-foot">
                    <span className="tt-avatar" title={who(t.assigneeSub)}>{initials(t.assigneeSub)}</span>
                    {/* Keyboard and touch route: a board that ONLY moves by drag
                        is unusable on a phone and unreachable by keyboard. */}
                    <select
                      className="tt-sel-sm" value={t.status} aria-label={`Status of ${t.title}`}
                      onChange={(e) => void move(t.id, e.target.value as TeamTaskStatus)}
                    >
                      {COLUMNS.map((c) => <option key={c.status} value={c.status}>{c.label}</option>)}
                    </select>
                    {members.length > 0 && (
                      <select
                        className="tt-sel-sm" value={t.assigneeSub || ''} disabled={busy}
                        aria-label={`Assignee of ${t.title}`}
                        onChange={(e) => reassign(t, e.target.value)}
                      >
                        <option value="">Unassigned</option>
                        {members.map((m) => <option key={m.sub} value={m.sub}>{m.email || m.sub.slice(0, 8)}</option>)}
                      </select>
                    )}
                    <button className="tt-cmt" aria-label={`Comments on ${t.title}`}
                            onClick={() => setOpenId(openId === t.id ? null : t.id)}>
                      <Icon name="message" size={13} />
                    </button>
                  </footer>

                  {openId === t.id && <TaskComments taskId={t.id} who={who} />}
                </article>
              ))}

              {items.length === 0 && (
                <div className="tt-empty">
                  {col.status === 'done' ? 'Nothing finished yet.' : 'Drop a card here.'}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Whether the session behind this card shipped anything.
 *
 * Fetched per card and cached per session for the page's lifetime, because two
 * cards often point at the same session. A failure renders nothing at all: an
 * outcome is a bonus on a card, and an error message where a badge should be
 * makes the board look broken.
 */
// The PROMISE is cached, not the result, and that distinction is load-bearing.
// Caching a result plus an "already asked" ref looks equivalent and is not: under
// StrictMode the first effect starts the request and is then cleaned up, so its
// setState is skipped, while the second run sees the ref and returns early —
// leaving the badge permanently blank even though the fetch succeeded. Awaiting a
// shared promise means every mount resolves, and two cards on one session still
// make one request.
const outcomeCache = new Map<string, Promise<SessionOutcomeResponse | null>>();

function outcomeFor(sessionId: string): Promise<SessionOutcomeResponse | null> {
  let p = outcomeCache.get(sessionId);
  if (!p) {
    p = getSessionOutcome(sessionId).catch(() => null);
    outcomeCache.set(sessionId, p);
  }
  return p;
}

function SessionOutcome({ sessionId }: { sessionId: string }) {
  const [out, setOut] = useState<SessionOutcomeResponse | null>(null);

  useEffect(() => {
    let live = true;
    void outcomeFor(sessionId).then((o) => { if (live) setOut(o); });
    return () => { live = false; };
  }, [sessionId]);

  if (!out || !out.found || out._computing) return null;
  const icon = out.status === 'shipped' ? '🚢'
    : out.status === 'interrupted' ? '⏸'
    : out.status === 'abandoned' ? '🪦' : '🟡';
  const commits = out.commits?.repos?.reduce((n, r) => n + (r.commits?.length ?? 0), 0) ?? 0;

  return (
    <a
      className="tt-outcome"
      href={`/?view=search&session=${encodeURIComponent(sessionId)}`}
      title="Open the session that did this work"
    >
      <span className="tt-outcome-status">{icon} {out.status.replace('_', ' ')}</span>
      {out.fileCount > 0 && <span>{out.fileCount} file{out.fileCount === 1 ? '' : 's'}</span>}
      {(out.totalLinesAdded > 0 || out.totalLinesRemoved > 0) && (
        <span className="tt-diff">+{out.totalLinesAdded}/−{out.totalLinesRemoved}</span>
      )}
      {commits > 0 && <span>{commits} commit{commits === 1 ? '' : 's'}</span>}
    </a>
  );
}

function TaskComments({ taskId, who }: { taskId: string; who: (s: string | null) => string }) {
  const [comments, setComments] = useState<TeamTaskComment[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { getTask(taskId).then((r) => setComments(r.comments)).catch(() => {}); }, [taskId]);
  async function add() {
    if (!body.trim()) return;
    setBusy(true);
    try { const c = await addTaskComment(taskId, body.trim()); setComments((cs) => [...cs, c]); setBody(''); }
    catch { /* surfaced by the board's err on refresh */ }
    finally { setBusy(false); }
  }
  return (
    <div className="tt-comments">
      {comments.map((c) => (
        <div key={c.id} className="tt-comment"><b>{who(c.authorSub)}</b> {c.body}</div>
      ))}
      <div className="tt-comment-add">
        <Input placeholder="Comment…" value={body} onChange={(e) => setBody(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
        <Button size="sm" onClick={add} disabled={busy || !body.trim()}>Post</Button>
      </div>
    </div>
  );
}

const TT_CSS = `
.tt-err { background: var(--cr-err-surf); color: var(--cr-err-500);
  border: 1px solid var(--cr-err-line); padding: 8px 12px;
  border-radius: var(--cr-radius-md); margin-bottom: 12px; font-size: 13px; }

.tt-new { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.tt-new > :first-child { flex: 1; min-width: 0; }
.tt-sel, .tt-sel-sm { border: 1px solid var(--cr-line-1); border-radius: var(--cr-radius-sm);
  padding: 6px 8px; background: var(--cr-ink-2); color: var(--cr-fg-1); font-size: 13px; }
.tt-sel-sm { font-size: 11px; padding: 2px 5px; }
.tt-sel:focus-visible, .tt-sel-sm:focus-visible, .tt-cmt:focus-visible {
  outline: 2px solid var(--cr-brand-500); outline-offset: 1px; }

.tt-board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px;
  align-items: start; }
.tt-col { background: var(--cr-ink-1); border: 1px solid var(--cr-line-1);
  border-radius: var(--cr-radius-lg); padding: 10px; min-height: 140px;
  transition: border-color var(--cr-dur-fast), background var(--cr-dur-fast); }
/* The drop target announces itself. Without this a drag is a guess. */
.tt-col-over { border-color: var(--cr-brand-line); background: var(--cr-brand-surf); }
.tt-col-head { display: flex; justify-content: space-between; align-items: baseline;
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--cr-fg-3); font-weight: 600; margin-bottom: 10px; }
.tt-count { font-variant-numeric: tabular-nums; }

.tt-card { background: var(--cr-ink-2); border: 1px solid var(--cr-line-1);
  border-radius: var(--cr-radius-md); padding: 10px; margin-bottom: 8px;
  cursor: grab; transition: border-color var(--cr-dur-fast), transform var(--cr-dur-fast); }
.tt-card:hover { border-color: var(--cr-line-2); }
.tt-card:active { cursor: grabbing; }
.tt-dragging { opacity: 0.45; transform: rotate(-1deg); }
.tt-title { font-size: 13px; font-weight: 500; color: var(--cr-fg-1); line-height: 1.4;
  margin-bottom: 8px; text-wrap: pretty; }

.tt-outcome { display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  margin-bottom: 8px; padding: 5px 7px; border-radius: var(--cr-radius-sm);
  background: var(--cr-ink-0); border: 1px solid var(--cr-line-1);
  font-size: 10.5px; color: var(--cr-fg-3); text-decoration: none;
  font-variant-numeric: tabular-nums; }
.tt-outcome:hover { border-color: var(--cr-brand-line); color: var(--cr-fg-2); }
.tt-outcome-status { color: var(--cr-fg-2); font-weight: 500; }
.tt-diff { color: var(--cr-ok-500); }

.tt-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.tt-due { font-size: 10.5px; color: var(--cr-fg-3); font-variant-numeric: tabular-nums; }
.tt-overdue { color: var(--cr-err-500); }

.tt-foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
/* A select must be allowed to shrink, or its intrinsic width pushes the comment
   button past the card's right edge in a four-column layout. */
.tt-foot .tt-sel-sm { min-width: 0; flex: 0 1 auto; max-width: 100%; }
.tt-avatar { flex: none; width: 22px; height: 22px; border-radius: var(--cr-radius-xs);
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--cr-ink-3); color: var(--cr-fg-2); font-size: 9.5px; font-weight: 600;
  letter-spacing: 0.02em; }
.tt-cmt { background: none; border: 0; cursor: pointer; color: var(--cr-fg-3);
  margin-left: auto; display: inline-flex; padding: 2px; border-radius: var(--cr-radius-xs); }
.tt-cmt:hover { color: var(--cr-fg-1); }

.tt-empty { color: var(--cr-fg-3); font-size: 11.5px; text-align: center; padding: 14px 6px;
  border: 1px dashed var(--cr-line-1); border-radius: var(--cr-radius-sm); }

.tt-comments { margin-top: 8px; border-top: 1px solid var(--cr-line-1); padding-top: 8px; }
.tt-comment { font-size: 12px; color: var(--cr-fg-2); margin-bottom: 4px; line-height: 1.45; }
.tt-comment b { color: var(--cr-fg-1); font-weight: 500; }
.tt-comment-add { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.tt-comment-add > :first-child { flex: 1; min-width: 0; }

@media (prefers-reduced-motion: reduce) {
  .tt-card, .tt-col { transition: none; }
  .tt-dragging { transform: none; }
}
@media (max-width: 900px) { .tt-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
/* Below 620px two columns leave ~141px each, which cannot hold a title, its
 * chips and a footer. One column is the only readable option — and drag is
 * unavailable on touch anyway, which is why every card keeps a status select. */
@media (max-width: 620px) { .tt-board { grid-template-columns: minmax(0, 1fr); } }
`;
