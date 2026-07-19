import { useEffect, useMemo, useState } from 'react';
import {
  listTasks, createTask, updateTask, getTask, addTaskComment,
  type TeamTask, type TeamTaskStatus, type TeamTaskComment,
} from '../services/api';
import { Button, Card, Chip, Input } from './primitives';

const COLUMNS: Array<{ status: TeamTaskStatus; label: string }> = [
  { status: 'todo', label: 'To do' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
];

type Member = { sub: string; email: string | null; role: string };

/**
 * Collaborative task board (Phase 3). Tasks are team-visible; create, assign,
 * move across status columns, and comment. Server-authoritative (/api/tasks).
 */
export default function TeamTasks({ members, mySub }: { members: Member[]; mySub: string | null }) {
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const emailBySub = useMemo(() => {
    const m: Record<string, string> = {};
    for (const x of members) if (x.email) m[x.sub] = x.email;
    return m;
  }, [members]);
  const who = (sub: string | null) => (sub ? (emailBySub[sub] || (sub === mySub ? 'me' : sub.slice(0, 8))) : 'unassigned');

  async function refresh() {
    setErr('');
    try { setTasks(await listTasks()); } catch (e: any) { setErr(String(e.message || e)); }
  }
  useEffect(() => { void refresh(); }, []);

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
  async function move(t: TeamTask, status: TeamTaskStatus) {
    setBusy(true);
    try { await updateTask(t.id, { status }); await refresh(); }
    catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  }
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
      {err && <div className="tt-err">{err}</div>}

      <div className="tt-new">
        <Input placeholder="New task title…" value={title}
               onChange={(e) => setTitle(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') void doCreate(); }} />
        <select className="tt-sel" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Unassigned</option>
          {members.map((m) => <option key={m.sub} value={m.sub}>{m.email || m.sub.slice(0, 8)}</option>)}
        </select>
        <Button variant="primary" onClick={doCreate} disabled={busy || !title.trim()}>Add task</Button>
      </div>

      <div className="tt-board">
        {COLUMNS.map((col) => {
          const items = byStatus(col.status);
          return (
            <div key={col.status} className="tt-col">
              <div className="tt-col-head">{col.label} <span className="tt-count">{items.length}</span></div>
              {items.map((t) => (
                <Card key={t.id} style={{ padding: 10, marginBottom: 8 }}>
                  <div className="tt-title">{t.title}</div>
                  <div className="tt-meta">
                    {t.projectId && <Chip kind="neutral" size="sm">{t.projectId}</Chip>}
                    <span className="tt-who">{who(t.assigneeSub)}</span>
                  </div>
                  <div className="tt-actions">
                    <select className="tt-sel-sm" value={t.status} disabled={busy}
                            onChange={(e) => move(t, e.target.value as TeamTaskStatus)}>
                      {COLUMNS.map((c) => <option key={c.status} value={c.status}>{c.label}</option>)}
                    </select>
                    <select className="tt-sel-sm" value={t.assigneeSub || ''} disabled={busy}
                            onChange={(e) => reassign(t, e.target.value)}>
                      <option value="">Unassigned</option>
                      {members.map((m) => <option key={m.sub} value={m.sub}>{m.email || m.sub.slice(0, 8)}</option>)}
                    </select>
                    <button className="tt-cmt" onClick={() => setOpenId(openId === t.id ? null : t.id)}>💬</button>
                  </div>
                  {openId === t.id && <TaskComments taskId={t.id} who={who} />}
                </Card>
              ))}
              {items.length === 0 && <div className="tt-empty">—</div>}
            </div>
          );
        })}
      </div>
    </div>
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
.tt-err { background: var(--danger-bg, #fee); color: var(--danger, #c00); padding: 8px 12px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; }
.tt-new { display: flex; gap: 8px; margin-bottom: 16px; }
.tt-new > :first-child { flex: 1; }
.tt-sel, .tt-sel-sm { border: 1px solid var(--border, #e3e3e8); border-radius: 8px; padding: 6px 8px; background: var(--surface, #fff); font-size: 13px; }
.tt-sel-sm { font-size: 11px; padding: 3px 6px; }
.tt-board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.tt-col { background: var(--surface-2, #f6f6f8); border-radius: 10px; padding: 10px; min-height: 120px; }
.tt-col-head { font-weight: 600; font-size: 13px; margin-bottom: 8px; display: flex; justify-content: space-between; }
.tt-count { color: var(--text-muted, #888); }
.tt-title { font-size: 13px; font-weight: 500; margin-bottom: 6px; }
.tt-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.tt-who { font-size: 11px; color: var(--text-muted, #888); }
.tt-actions { display: flex; gap: 6px; align-items: center; }
.tt-cmt { background: none; border: none; cursor: pointer; font-size: 13px; margin-left: auto; }
.tt-empty { color: var(--text-muted, #aaa); font-size: 12px; text-align: center; padding: 8px; }
.tt-comments { margin-top: 8px; border-top: 1px solid var(--border, #eee); padding-top: 8px; }
.tt-comment { font-size: 12px; margin-bottom: 4px; }
.tt-comment-add { display: flex; gap: 6px; margin-top: 6px; }
.tt-comment-add > :first-child { flex: 1; }
@media (prefers-color-scheme: dark) {
  .tt-col { background: #16161b; }
  .tt-sel, .tt-sel-sm { background: #1c1c22; border-color: #2c2c34; color: inherit; }
}
@media (max-width: 900px) { .tt-board { grid-template-columns: 1fr 1fr; } }
`;
