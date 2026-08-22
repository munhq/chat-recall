import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listTasks, createTask, updateTask, getTask, addTaskComment, getSessionOutcome,
  getAutoTasksPolicy, setAutoTasksPolicy, runAutoTasksNow, SEVERITY_BY_PRI,
  type TeamTask, type TeamTaskStatus, type TeamTaskComment, type SessionOutcomeResponse,
  type AutoTasksStatus,
} from '../services/api';
import { Button, Chip, Icon, Input } from './primitives';

/**
 * Who may move a card where.
 *
 * `done` is not a column a person drops into. A card asserts a problem exists in
 * the code, so "done" asserts the code changed — the agent that did the work
 * sets it through the MCP and attaches its session, and the board can then show
 * the files, lines and commits behind the claim. Dragging proves nothing, and
 * this board already carries dozens of "done" cards nobody ever worked.
 *
 * What a person CAN do is disagree: reject the card. That is a real verdict, it
 * dismisses the underlying finding, and the auto-filer stops re-filing it.
 *
 * `blocked` is gone. Nothing in the product ever set it — not the filer, not the
 * MCP, not one card on any board — so it was a column that could only ever be
 * empty. Rows written before this still load; the type keeps the value.
 */
const COLUMNS: Array<{ status: TeamTaskStatus; label: string }> = [
  { status: 'todo', label: 'To do' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'done', label: 'Done' },
  { status: 'rejected', label: 'Rejected' },
];
/** Columns a human may drag INTO, and pick in the per-card select. */
const HUMAN_STATUSES: readonly TeamTaskStatus[] = ['todo', 'in_progress', 'rejected'];

/**
 * Auto-filed cards carry their severity as a `[critical] `/`[high] ` title
 * prefix (services/auto-tasks.ts writes it, and the finding id — not the title —
 * is the dedup key, so the prefix is display data). Rendering it as a chip beats
 * leaving a bracket in a sentence, and ranking on it puts the criticals at the
 * top of the column where a board is actually read.
 */
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
function splitSeverity(title: string): { sev: string | null; text: string } {
  const m = /^\[(critical|high|medium|low)\]\s*/i.exec(title);
  if (!m) return { sev: null, text: title };
  return { sev: m[1].toLowerCase(), text: title.slice(m[0].length) };
}

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
  // Auto-file policy: urgent code findings open their own cards. Opt-in — the
  // board has no delete, so nothing writes to it without this switch.
  const [auto, setAuto] = useState<AutoTasksStatus | null>(null);
  // A failure to LOAD the policy used to hide the control entirely, which is how
  // "where is the auto-file setting?" became a question with no answer on screen.
  // Now the reason is shown where the control would be.
  const [autoErr, setAutoErr] = useState('');
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoNote, setAutoNote] = useState('');
  const [overCol, setOverCol] = useState<TeamTaskStatus | null>(null);
  /** Board filter. The board groups by STATUS; criticals arrive per project, so
   *  without this a busy tenant reads four columns of mixed repositories. */
  const [projFilter, setProjFilter] = useState('');

  const emailBySub = useMemo(() => {
    const m: Record<string, string> = {};
    for (const x of members) if (x.email) m[x.sub] = x.email;
    return m;
  }, [members]);
  const who = (sub: string | null) => (sub ? (emailBySub[sub] || (sub === mySub ? 'me' : sub.slice(0, 8))) : 'unassigned');
  /** Initials for the avatar chip: a board scans by shape, not by reading emails. */
  const initials = (sub: string | null) => {
    if (!sub) return '-';
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

  const loadAuto = useCallback(async () => {
    try { setAuto(await getAutoTasksPolicy()); setAutoErr(''); }
    catch (e: any) { setAuto(null); setAutoErr(String(e?.message || e)); }
  }, []);
  useEffect(() => { void loadAuto(); }, [loadAuto]);

  /** Save a policy change, then re-read the state so the panel reports the
   *  server's answer rather than the optimistic guess. */
  const saveAuto = async (next: { enabled: boolean; maxPri: 0 | 1 | 2 | 3 }) => {
    if (!auto) return;
    const before = auto;
    setAuto({ ...auto, ...next });
    setAutoNote('');
    setAutoBusy(true);
    try { await setAutoTasksPolicy(next); await loadAuto(); }
    catch { setAuto(before); setAutoErr('Could not save the auto-file setting.'); }
    finally { setAutoBusy(false); }
  };

  /** The button that makes the switch observable: file the waiting findings now
   *  instead of waiting for the next `chat-recall code index`. */
  const runNow = async () => {
    setAutoBusy(true);
    setAutoNote('');
    try {
      const r = await runAutoTasksNow();
      setAutoNote(r.created || r.closed
        ? `Filed ${r.created}, closed ${r.closed}.`
        : 'It ran. Nothing qualified, so no cards were filed.');
      await Promise.all([refresh(), loadAuto()]);
    } catch (e: any) { setAutoErr(String(e?.message || e)); }
    finally { setAutoBusy(false); }
  };

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

  const visible = useMemo(
    () => (projFilter ? tasks.filter((t) => (t.projectId || '') === projFilter) : tasks),
    [tasks, projFilter],
  );
  const byStatus = (s: TeamTaskStatus) => visible
    .filter((t) => t.status === s)
    .slice()
    .sort((a, b) => {
      const ra = SEV_RANK[splitSeverity(a.title).sev ?? ''] ?? 2;
      const rb = SEV_RANK[splitSeverity(b.title).sev ?? ''] ?? 2;
      return ra - rb;
    });

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

      <AutoPanel
        auto={auto} err={autoErr} note={autoNote} busy={autoBusy}
        open={autoOpen} onOpen={() => setAutoOpen((o) => !o)}
        onSave={saveAuto} onRun={runNow}
        projFilter={projFilter} onProject={setProjFilter}
      />

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
                setDragId(null);
                if (!id) return;
                if (col.status === 'done') {
                  // Say why, instead of a silent no-op or a 409 from the server.
                  setErr('A task is marked done by the work, not by hand. The agent that fixes it '
                    + 'closes it and attaches its session, or it closes itself when a re-index stops '
                    + 'reporting the finding. If it should not be worked at all, reject it.');
                  return;
                }
                void move(id, col.status);
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
                  <div className="tt-title">
                    {(() => {
                      const { sev, text } = splitSeverity(t.title);
                      return (
                        <>
                          {sev && (
                            <span className={`tt-sev tt-sev-${sev}`}>{sev}</span>
                          )}
                          {sev ? text : t.title}
                        </>
                      );
                    })()}
                  </div>

                  {/* The differentiator: did the session attached to this card
                      actually ship anything? */}
                  {t.linkedSessionId && <SessionOutcome sessionId={t.linkedSessionId} />}

                  <div className="tt-meta">
                    {t.linkedFindingId && <Chip kind="brand" size="sm">auto</Chip>}
                    {t.projectId && <Chip kind="neutral" size="sm">{t.projectId}</Chip>}
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
                    {t.status === 'done' ? (
                      <span className="tt-donetag" title={t.linkedSessionId
                        ? 'Closed by the session linked to this card'
                        : 'Closed automatically: a re-index stopped reporting the finding'}>done</span>
                    ) : (
                      <select
                        className="tt-sel-sm" value={t.status} aria-label={`Status of ${t.title}`}
                        onChange={(e) => void move(t.id, e.target.value as TeamTaskStatus)}
                      >
                        {COLUMNS.filter((c) => HUMAN_STATUSES.includes(c.status))
                          .map((c) => <option key={c.status} value={c.status}>{c.label}</option>)}
                      </select>
                    )}
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
                  {col.status === 'done' ? 'Nothing finished yet.'
                    : col.status === 'rejected' ? 'Reject a card to stop it coming back.'
                    : col.status === 'in_progress' ? 'An agent claims a card here.'
                    : 'Drop a card here.'}
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
 * Automation — the switch, what it will do, and what it already did.
 *
 * This replaced a bare checkbox, and the reason is worth writing down: the
 * checkbox set a tenant POLICY, while the only thing that ever files a card is a
 * `chat-recall code index` sync. So ticking it produced no visible change, ever,
 * and a person who ticked it could not tell it apart from a dead control. Three
 * things fix that, and none of them is a wizard:
 *
 *   1. Say what is waiting, per project, BEFORE anything is pressed.
 *   2. Give the action its own button ("Run now"), so the effect is immediate.
 *   3. Report the last run, including a run that filed nothing.
 *
 * A wizard would be the wrong shape here: there are two settings, and a
 * multi-step flow to collect two settings is ceremony, not clarity. What was
 * missing was feedback, not steps.
 */
function AutoPanel({
  auto, err, note, busy, open, onOpen, onSave, onRun, projFilter, onProject,
}: {
  auto: AutoTasksStatus | null;
  err: string;
  note: string;
  busy: boolean;
  open: boolean;
  onOpen: () => void;
  onSave: (p: { enabled: boolean; maxPri: 0 | 1 | 2 | 3 }) => void | Promise<void>;
  onRun: () => void | Promise<void>;
  projFilter: string;
  onProject: (p: string) => void;
}) {
  // LOADING: a skeleton in the panel's own shape, so the bar does not pop in
  // after the board has already painted. Not a spinner.
  if (!auto && !err) {
    return (
      <div className="tt-auto-wrap" aria-busy="true">
        <div className="tt-auto-bar">
          <span className="tt-skel tt-skel-switch" />
          <span className="tt-skel tt-skel-line" />
        </div>
      </div>
    );
  }
  // ERROR: the control is never hidden. The reason takes its place, because a
  // vanished control is the thing nobody can debug from the screen.
  if (!auto) {
    return (
      <div className="tt-auto-wrap tt-auto-dead" role="status">
        <Icon name="settings" size={13} />
        <span>Auto-filing is unavailable. {err}</span>
      </div>
    );
  }

  /** How many open findings sit at `sev` or above, across every project. */
  const total = (sev: string): number => {
    const floor = SEVERITY_BY_PRI.indexOf(sev as (typeof SEVERITY_BY_PRI)[number]);
    if (floor < 0) return 0;
    let n = 0;
    for (const r of auto.byProject) {
      for (let p = 0; p <= floor; p++) n += r.counts[SEVERITY_BY_PRI[p]] ?? 0;
    }
    return n;
  };

  const ago = (ms: number) => {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  };

  /** The one sentence that answers "is anything happening?". */
  const headline = !auto.enabled
    ? 'Off. Findings stay in the ranked view.'
    : auto.eligible > 0
      ? `${auto.eligible} finding${auto.eligible === 1 ? '' : 's'} ready to file`
      : auto.filed > 0 ? 'All caught up' : 'On. Nothing to file yet.';

  const sub = [
    auto.filed > 0 ? `${auto.filed} filed` : '',
    auto.lastRun ? `last run ${ago(auto.lastRun.at)}` : 'never run',
  ].filter(Boolean).join(', ');

  return (
    <section className="tt-auto-wrap">
      <div className="tt-auto-bar">
        <label
          className="tt-switch"
          title="After each code index, critical and high findings open their own cards here. At most 10 per run, deduplicated, and each card closes itself when a re-index stops reporting its finding. Nothing is ever deleted."
        >
          <input
            type="checkbox" checked={auto.enabled} disabled={busy}
            onChange={() => onSave({ enabled: !auto.enabled, maxPri: auto.maxPri })}
          />
          <span className="tt-switch-track" aria-hidden="true"><span className="tt-switch-dot" /></span>
          <span className="tt-switch-label">Auto-file findings</span>
        </label>

        <span className="tt-auto-head">
          <b>{headline}</b>
          <span className="tt-auto-sub">{sub}</span>
        </span>

        <span className="tt-auto-actions">
          {auto.enabled && (
            <Button size="sm" onClick={onRun} disabled={busy}>
              {busy ? 'Filing' : 'Run now'}
            </Button>
          )}
          <button className="tt-link" onClick={onOpen} aria-expanded={open}>
            {open ? 'Less' : 'Settings'}
          </button>
        </span>
      </div>

      {note && <div className="tt-auto-note" role="status">{note}</div>}
      {err && <div className="tt-auto-note tt-auto-err" role="alert">{err}</div>}

      {open && (
        <div className="tt-auto-body">
          <div className="tt-auto-set">
            <span className="tt-auto-lede">File findings at or above</span>
            <span className="tt-sevpick" role="group" aria-label="Severity floor">
              {SEVERITY_BY_PRI.map((label, pri) => {
                const n = total(label);
                const on = auto.maxPri === pri;
                return (
                  <button
                    key={label}
                    className={`tt-sevopt${on ? ' tt-sevopt-on' : ''}`}
                    disabled={busy || !auto.enabled}
                    aria-pressed={on}
                    onClick={() => onSave({ enabled: auto.enabled, maxPri: pri as 0 | 1 | 2 | 3 })}
                  >
                    {label}
                    {/* What this choice would actually pick up. Choosing a floor
                        blind is how you end up selecting one that files nothing. */}
                    <i className="tt-sevopt-n">{n}</i>
                  </button>
                );
              })}
            </span>
          </div>
          {total(SEVERITY_BY_PRI[auto.maxPri]) === 0 && auto.enabled && (
            <div className="tt-auto-empty">
              Nothing sits at <b>{SEVERITY_BY_PRI[auto.maxPri]}</b> or above, so this floor
              files nothing. The counts above show what a lower floor would pick up.
            </div>
          )}

          {auto.byProject.length === 0 ? (
            /* EMPTY: says how to populate it, per the interactive-states rule. */
            <div className="tt-auto-empty">
              No critical or high findings yet. Run <code>chat-recall code index</code> in
              a repository and they show up here.
            </div>
          ) : (
            <div className="tt-ptiles">
              {auto.byProject.map((r) => {
                const on = projFilter === r.projectId;
                return (
                  <button
                    key={r.projectId}
                    className={`tt-ptile${on ? ' tt-ptile-on' : ''}`}
                    onClick={() => onProject(on ? '' : r.projectId)}
                    title={on ? 'Show every project' : `Show only ${r.projectId}`}
                  >
                    <span className="tt-ptile-name">{r.projectId}</span>
                    <span className="tt-ptile-nums">
                      {SEVERITY_BY_PRI.filter((sv) => (r.counts[sv] ?? 0) > 0).map((sv, i) => (
                        <span key={sv} className="tt-ptile-n">
                          {i > 0 && <i />}
                          <b className={sv === 'critical' ? 'tt-pcrit' : undefined}>{r.counts[sv]}</b> {sv}
                        </span>
                      ))}
                    </span>
                    <span className="tt-ptile-foot">
                      {r.eligible > 0 ? `${r.eligible} waiting to file` : on ? 'Filtering the board' : 'All filed'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {projFilter && (
        <div className="tt-auto-note">
          Showing <b>{projFilter}</b> only.{' '}
          <button className="tt-link" onClick={() => onProject('')}>Show every project</button>
        </div>
      )}
    </section>
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

.tt-new { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
/* The new-task input takes the row; the selects keep their intrinsic width. */
.tt-new > :first-child { flex: 1; min-width: 0; }

/* Every <select> and the comment button on this board. These rules were lost
   when the auto-file checkbox they sat next to was replaced by AutoPanel, so the
   status and assignee pickers rendered as unstyled browser controls — light grey
   boxes inside a dark board, with no focus ring on any of them. */
.tt-sel, .tt-sel-sm { border: 1px solid var(--cr-line-1); border-radius: var(--cr-radius-sm);
  padding: 6px 8px; background: var(--cr-ink-2); color: var(--cr-fg-1); font-size: 13px;
  font-family: inherit; }
.tt-sel-sm { font-size: 11px; padding: 2px 5px; }
.tt-sel:focus-visible, .tt-sel-sm:focus-visible, .tt-cmt:focus-visible {
  outline: 2px solid var(--cr-brand-500); outline-offset: 1px; }
.tt-auto-wrap { border: 1px solid var(--cr-line-1); border-radius: var(--cr-radius-lg);
  background: var(--cr-ink-1); margin-bottom: 16px; overflow: hidden; }
.tt-auto-bar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 11px 13px; }
.tt-auto-dead { display: flex; align-items: center; gap: 8px; padding: 11px 13px;
  font-size: 12.5px; color: var(--cr-fg-3); }

/* The state sentence carries the weight, so it gets real contrast. It used to be
   grey micro-copy doing the panel's most important job. */
.tt-auto-head { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.tt-auto-head b { font-size: 12.5px; font-weight: 600; color: var(--cr-fg-1); }
.tt-auto-sub { font-size: 11px; color: var(--cr-fg-3); font-variant-numeric: tabular-nums; }
.tt-auto-actions { margin-left: auto; display: inline-flex; gap: 10px; align-items: center; }

.tt-link { background: none; border: 0; padding: 2px 3px; cursor: pointer; color: var(--cr-fg-3);
  font-size: 12px; font-family: inherit; border-radius: var(--cr-radius-xs); }
.tt-link:hover { color: var(--cr-fg-1); }
.tt-link:active { transform: translateY(1px); }
.tt-link:focus-visible { outline: 2px solid var(--cr-brand-500); outline-offset: 1px; }

/* A switch, not a 13px tick: this control has a state worth reading from across
   the board, and a checkbox that small reads as decoration. */
.tt-switch { display: inline-flex; align-items: center; gap: 9px; cursor: pointer;
  user-select: none; font-size: 13px; color: var(--cr-fg-1); flex: none; }
.tt-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.tt-switch-track { width: 34px; height: 19px; border-radius: 999px; flex: none;
  background: var(--cr-ink-3); border: 1px solid var(--cr-line-1); position: relative;
  transition: background var(--cr-dur-fast), border-color var(--cr-dur-fast); }
.tt-switch-dot { position: absolute; top: 2px; left: 2px; width: 13px; height: 13px;
  border-radius: 999px; background: var(--cr-fg-3);
  transition: transform var(--cr-dur-fast), background var(--cr-dur-fast); }
.tt-switch input:checked + .tt-switch-track { background: var(--cr-brand-surf);
  border-color: var(--cr-brand-line); }
.tt-switch input:checked + .tt-switch-track .tt-switch-dot {
  transform: translateX(15px); background: var(--cr-brand-500); }
.tt-switch input:focus-visible + .tt-switch-track { outline: 2px solid var(--cr-brand-500);
  outline-offset: 2px; }
.tt-switch input:disabled + .tt-switch-track { opacity: 0.55; }
.tt-switch-label { font-weight: 500; }

/* Skeleton in the panel's own shape. */
.tt-skel { display: block; border-radius: var(--cr-radius-sm); background: var(--cr-ink-3);
  opacity: 0.55; animation: tt-pulse 1.4s ease-in-out infinite; }
.tt-skel-switch { width: 34px; height: 19px; border-radius: 999px; flex: none; }
.tt-skel-line { width: 190px; height: 11px; }
@keyframes tt-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 0.7; } }

.tt-auto-note { padding: 8px 13px; font-size: 12px; color: var(--cr-fg-2);
  border-top: 1px solid var(--cr-line-1); background: var(--cr-ink-0); }
.tt-auto-note b { color: var(--cr-fg-1); font-weight: 600; }
.tt-auto-err { color: var(--cr-err-500); }

.tt-auto-body { border-top: 1px solid var(--cr-line-1); padding: 13px;
  display: flex; flex-direction: column; gap: 12px; background: var(--cr-ink-0); }
.tt-auto-set { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font-size: 12.5px; }
.tt-auto-lede { color: var(--cr-fg-3); }
/* A segmented picker beats four radios here: the choice is ordinal, and each
   option carries the count it would file, so picking one is not a guess. */
.tt-sevpick { display: inline-flex; border: 1px solid var(--cr-line-1);
  border-radius: var(--cr-radius-sm); overflow: hidden; }
.tt-sevopt { display: inline-flex; align-items: baseline; gap: 5px; cursor: pointer;
  padding: 5px 10px; background: var(--cr-ink-1); border: 0; font-family: inherit;
  font-size: 12px; color: var(--cr-fg-3); border-right: 1px solid var(--cr-line-1);
  text-transform: capitalize; }
.tt-sevopt:last-child { border-right: 0; }
.tt-sevopt:hover:not(:disabled) { color: var(--cr-fg-1); background: var(--cr-ink-2); }
.tt-sevopt:disabled { opacity: 0.5; cursor: default; }
.tt-sevopt-on { background: var(--cr-brand-surf); color: var(--cr-fg-1); font-weight: 600; }
.tt-sevopt-n { font-style: normal; font-size: 10.5px; opacity: 0.75;
  font-variant-numeric: tabular-nums; }
.tt-ptile-n { display: inline-flex; align-items: baseline; gap: 4px; }
.tt-auto-empty { font-size: 12.5px; color: var(--cr-fg-3); line-height: 1.55; }
.tt-auto-empty code { background: var(--cr-ink-2); padding: 1px 5px;
  border-radius: var(--cr-radius-xs); font-size: 11.5px; }

/* Findings per project as tiles, not a hairline-per-row table: a repo is a thing
   you click, and a border under every row is the laziest layout there is. */
.tt-ptiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
.tt-ptile { display: flex; flex-direction: column; gap: 4px; text-align: left; cursor: pointer;
  padding: 9px 11px; border: 1px solid var(--cr-line-1); border-radius: var(--cr-radius-md);
  background: var(--cr-ink-1); font-family: inherit;
  transition: border-color var(--cr-dur-fast), background var(--cr-dur-fast); }
.tt-ptile:hover { border-color: var(--cr-line-2); }
.tt-ptile:active { transform: translateY(1px); }
.tt-ptile:focus-visible { outline: 2px solid var(--cr-brand-500); outline-offset: 1px; }
.tt-ptile-on { border-color: var(--cr-brand-line); background: var(--cr-brand-surf); }
.tt-ptile-name { font-size: 12.5px; font-weight: 600; color: var(--cr-fg-1); overflow-wrap: anywhere; }
.tt-ptile-nums { font-size: 11.5px; color: var(--cr-fg-3); display: flex; align-items: baseline;
  gap: 5px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
.tt-ptile-nums b { font-size: 15px; font-weight: 600; color: var(--cr-fg-1); }
.tt-ptile-nums i { width: 1px; height: 10px; background: var(--cr-line-1); margin: 0 3px; }
.tt-ptile-foot { font-size: 10.5px; color: var(--cr-fg-3); }
.tt-pcrit { color: var(--cr-err-500) !important; }
.tt-pzero { color: var(--cr-fg-3) !important; }
@media (max-width: 620px) { .tt-auto-actions { margin-left: 0; } }

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
/* Severity reads as a chip, not as a bracket inside the sentence. */
.tt-sev { display: inline-block; margin-right: 6px; padding: 1px 5px; border-radius: var(--cr-radius-xs);
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
  vertical-align: 1px; }
.tt-sev-critical { background: var(--cr-err-surf); color: var(--cr-err-500);
  border: 1px solid var(--cr-err-line); }
.tt-sev-high { background: var(--cr-warn-surf, var(--cr-ink-3)); color: var(--cr-warn-500, var(--cr-fg-2));
  border: 1px solid var(--cr-warn-line, var(--cr-line-2)); }
.tt-sev-medium, .tt-sev-low { background: var(--cr-ink-3); color: var(--cr-fg-3);
  border: 1px solid var(--cr-line-1); }

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
.tt-donetag { font-size: 11px; color: var(--cr-ok-500); border: 1px solid var(--cr-line-1);
  padding: 2px 7px; border-radius: var(--cr-radius-xs); background: var(--cr-ink-1); }
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
  .tt-card, .tt-col, .tt-switch-track, .tt-switch-dot, .tt-ptile { transition: none; }
  .tt-dragging { transform: none; }
  .tt-skel { animation: none; }
  .tt-link:active, .tt-ptile:active { transform: none; }
}
@media (max-width: 900px) { .tt-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
/* Below 620px two columns leave ~141px each, which cannot hold a title, its
 * chips and a footer. One column is the only readable option — and drag is
 * unavailable on touch anyway, which is why every card keeps a status select. */
@media (max-width: 620px) { .tt-board { grid-template-columns: minmax(0, 1fr); } }
`;
