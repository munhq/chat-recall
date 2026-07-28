import { useEffect, useMemo, useState } from 'react';
import {
  getMe, getTeamActivity, listMyShares, addShare, removeShare, setActiveTeam, getActiveTeam,
  type TeamActivityResponse, type ProjectShare,
} from '../services/api';
import { Button, Card, Chip, Avatar, Input, MetricCard } from './primitives';
import TeamTasks from './TeamTasks';

/**
 * Team view (Phase 2) — "what did each teammate do, per project", plus the
 * per-project sharing control. The activity list is RLS-scoped by the server to
 * what this member may see (own + team-shared), so nothing private ever renders.
 */
export default function TeamView({ onOpenProject }: { onOpenProject?: (projectId: string) => void }) {
  const [teamSlug, setTeamSlug] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string>('');
  const [mySub, setMySub] = useState<string | null>(null);
  const [act, setAct] = useState<TeamActivityResponse | null>(null);
  const [shares, setShares] = useState<ProjectShare[]>([]);
  const [sinceDays, setSinceDays] = useState<number>(30);
  const [tab, setTab] = useState<'activity' | 'tasks'>('activity');
  const [newProject, setNewProject] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Resolve the caller's team (first membership) once.
  useEffect(() => {
    getMe().then((me) => {
      setMySub(me.user.sub);
      // Respect a still-valid active-team selection; only fall back to the
      // first membership if none is set or the stored one is stale.
      const cur = getActiveTeam();
      const t = (cur && me.teams.find((x) => x.team_slug === cur)) || me.teams[0];
      if (t) { setTeamSlug(t.team_slug); setTeamName(t.name || t.team_slug); setActiveTeam(t.team_slug); }
    }).catch((e) => setErr(String(e.message || e)));
  }, []);

  async function refresh(days: number) {
    setErr('');
    try {
      const [a, s] = await Promise.all([getTeamActivity({ sinceDays: days }), listMyShares()]);
      setAct(a); setShares(s);
    } catch (e: any) { setErr(String(e.message || e)); }
  }
  useEffect(() => { if (teamSlug) void refresh(sinceDays); }, [teamSlug, sinceDays]);

  // Group activity rows by member for the matrix.
  const byMember = useMemo(() => {
    const m = new Map<string, { label: string; isMe: boolean; rows: TeamActivityResponse['activity'] }>();
    for (const r of act?.activity ?? []) {
      const key = r.authorSub ?? 'unattributed';
      const label = r.memberEmail || (r.authorSub ? r.authorSub.slice(0, 8) : 'Unattributed (legacy)');
      if (!m.has(key)) m.set(key, { label, isMe: r.authorSub === mySub, rows: [] });
      m.get(key)!.rows.push(r);
    }
    // Sort: me first, then by total sessions desc.
    return [...m.values()].sort((a, b) =>
      (Number(b.isMe) - Number(a.isMe)) ||
      (b.rows.reduce((n, r) => n + r.sessions, 0) - a.rows.reduce((n, r) => n + r.sessions, 0)));
  }, [act, mySub]);

  const totalSessions = (act?.activity ?? []).reduce((n, r) => n + r.sessions, 0);
  const activeProjects = new Set((act?.activity ?? []).map((r) => r.projectId)).size;

  async function doAddShare() {
    const pid = newProject.trim();
    if (!pid) return;
    setBusy(true);
    try { await addShare(pid); setNewProject(''); await refresh(sinceDays); }
    catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  }
  async function doRemoveShare(pid: string) {
    setBusy(true);
    try { await removeShare(pid); await refresh(sinceDays); }
    catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  }

  if (!teamSlug && !err) return <div className="team"><style>{TEAM_CSS}</style><p className="muted">Loading team…</p></div>;

  return (
    <div className="team">
      <style>{TEAM_CSS}</style>
      <div className="team-head">
        <div>
          <h1>Team{teamName ? ` · ${teamName}` : ''}</h1>
          <p className="muted">What the team has been working on. You see your own work plus projects teammates have shared.</p>
        </div>
        {tab === 'activity' && (
          <div className="team-range">
            {[7, 30, 90].map((d) => (
              <Button key={d} variant={sinceDays === d ? 'primary' : 'ghost'} onClick={() => setSinceDays(d)}>{d}d</Button>
            ))}
          </div>
        )}
      </div>

      <div className="team-tabs">
        <Button variant={tab === 'activity' ? 'primary' : 'ghost'} onClick={() => setTab('activity')}>Activity</Button>
        <Button variant={tab === 'tasks' ? 'primary' : 'ghost'} onClick={() => setTab('tasks')}>Tasks</Button>
      </div>

      {err && <div className="team-err">{err}</div>}

      {tab === 'tasks' && <TeamTasks members={act?.members ?? []} mySub={mySub} />}
      {tab === 'activity' && (
      <>
      <div className="team-metrics">
        <MetricCard label="Members" value={String(act?.members.length ?? 0)} icon="grid" />
        <MetricCard label="Active projects" value={String(activeProjects)} sub={`last ${sinceDays}d`} icon="folder" />
        <MetricCard label="Sessions" value={String(totalSessions)} sub={`last ${sinceDays}d`} icon="message" />
        <MetricCard label="Projects I share" value={String(shares.length)} tone={shares.length ? 'ok' : 'neutral'} icon="check" />
      </div>

      <section>
        <h2>Projects I share</h2>
        <p className="muted">Sharing a project lets teammates see your sessions, search, and findings for it. Default is private.</p>
        <div className="team-shares">
          {shares.length === 0 && <span className="muted">You haven't shared any projects yet.</span>}
          {shares.map((s) => (
            <Chip key={s.projectId} kind="ok" icon="folder">
              {s.projectId}
              <button className="chip-x" title="Stop sharing" onClick={() => doRemoveShare(s.projectId)} disabled={busy}>×</button>
            </Chip>
          ))}
        </div>
        <div className="team-add">
          <Input placeholder="project_id to share (e.g. git:github.com/org/repo)" value={newProject}
                 onChange={(e) => setNewProject(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') void doAddShare(); }} />
          <Button variant="primary" onClick={doAddShare} disabled={busy || !newProject.trim()}>Share</Button>
        </div>
      </section>

      <section>
        <h2>Activity by member</h2>
        {byMember.length === 0 ? (
          <p className="muted">No activity visible yet. When teammates share projects, their work shows up here.</p>
        ) : byMember.map((m) => {
          const total = m.rows.reduce((n, r) => n + r.sessions, 0);
          return (
            <Card key={m.label} style={{ marginBottom: 12, padding: 14 }}>
              <div className="team-member">
                <Avatar name={m.label} />
                <div className="team-member-name">{m.label}{m.isMe && <Chip kind="brand" size="sm">you</Chip>}</div>
                <div className="muted">{total} session{total === 1 ? '' : 's'}</div>
              </div>
              <div className="team-projgrid">
                {[...m.rows].sort((a, b) => b.lastMtime - a.lastMtime).map((r) => (
                  <button key={r.projectId} className="team-proj" onClick={() => onOpenProject?.(r.projectId)} title="Open project">
                    <span className="team-proj-id">{r.projectId}</span>
                    <span className="team-proj-meta">{r.sessions} · {r.lastMtime ? new Date(r.lastMtime).toISOString().slice(0, 10) : '—'}</span>
                  </button>
                ))}
              </div>
            </Card>
          );
        })}
      </section>
      </>
      )}
    </div>
  );
}

const TEAM_CSS = `
.team-tabs { display: flex; gap: 6px; margin-bottom: 16px; }
/* Scroll its own overflow: .team is a flex child of .app-row (overflow:hidden),
 * stretched to the row height — without this the page clips and can't scroll. */
.team { max-width: 1100px; margin: 0 auto; padding: 20px; min-height: 0; overflow-y: auto; }
.team-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
.team-head h1 { margin: 0 0 4px; }
.team .muted { color: var(--text-muted, #888); font-size: 13px; margin: 0; }
.team-range { display: flex; gap: 6px; }
.team-err { background: var(--danger-bg, #fee); color: var(--danger, #c00); padding: 8px 12px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; }
.team-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
.team section { margin-bottom: 28px; }
.team section h2 { margin: 0 0 4px; font-size: 16px; }
.team-shares { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; min-height: 28px; }
.chip-x { background: none; border: none; cursor: pointer; font-size: 15px; line-height: 1; margin-left: 6px; opacity: 0.6; }
.chip-x:hover { opacity: 1; }
.team-add { display: flex; gap: 8px; max-width: 560px; }
.team-add > :first-child { flex: 1; }
.team-member { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.team-member-name { font-weight: 600; display: flex; align-items: center; gap: 8px; flex: 1; }
.team-projgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }
.team-proj { text-align: left; background: var(--surface-2, #f6f6f8); border: 1px solid var(--border, #e3e3e8); border-radius: 8px; padding: 8px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
.team-proj:hover { border-color: var(--accent, #6c5ce7); }
.team-proj-id { font-size: 12px; font-family: var(--mono, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.team-proj-meta { font-size: 11px; color: var(--text-muted, #888); }
@media (prefers-color-scheme: dark) {
  .team-proj { background: #1c1c22; border-color: #2c2c34; }
}
`;
