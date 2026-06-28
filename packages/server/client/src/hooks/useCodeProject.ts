/**
 * useCodeProject — resolve the code-intelligence project for a workspace id and
 * load its recommendations + action plan + behaviour signal. Centralizes the
 * match rule (exact projectId OR rootPath.includes) that CodeExplorer and the
 * old Pulse tab each duplicated.
 */
import { useState, useEffect, useCallback } from 'react';
import { getCodeProjects, getCodeRecommendations, getCodeActions, type CodeProject, type CodeRecommendation, type CodeAction } from '../services/api';

export interface UseCodeProject {
  project: CodeProject | null;
  recs: CodeRecommendation[];
  actions: CodeAction[];
  behavior: { failedOrAbandoned: number; totalSessions: number } | null;
  loading: boolean;
  reload: () => void;
}

export function useCodeProject(projectId: string): UseCodeProject {
  const [project, setProject] = useState<CodeProject | null>(null);
  const [recs, setRecs] = useState<CodeRecommendation[]>([]);
  const [actions, setActions] = useState<CodeAction[]>([]);
  const [behavior, setBehavior] = useState<{ failedOrAbandoned: number; totalSessions: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let on = true;
    setLoading(true);
    getCodeProjects().then((ps) => {
      if (!on) return;
      const match = ps.find((p) => p.projectId === projectId || p.rootPath.includes(projectId)) ?? null;
      setProject(match);
      if (match) {
        getCodeRecommendations(match.projectId).then((r) => { if (on) { setRecs(r.recommendations); setBehavior(r.behavior); } });
        getCodeActions(match.projectId, { limit: 200 }).then((a) => { if (on) setActions(a); });
      } else { setRecs([]); setActions([]); setBehavior(null); }
      setLoading(false);
    });
    return () => { on = false; };
  }, [projectId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { project, recs, actions, behavior, loading, reload };
}
