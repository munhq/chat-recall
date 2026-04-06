/**
 * Project sidebar - browse conversations by project.
 */

import React, { useState, useEffect } from 'react';
import { getStatus } from '../services/api';
import './ProjectSidebar.css';

interface Project {
  path: string;
  count: number;
}

interface ProjectSidebarProps {
  selectedProject: string | null;
  onProjectSelect: (project: string | null) => void;
}

function formatProjectName(path: string): string {
  // Try to show just the relevant part of the path
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  // Return last 2 parts for readability: "code/chat-recall" or just "chat-recall"
  if (parts.length >= 2) {
    return parts.slice(-2).join('/');
  }
  return parts.join('/') || path;
}

export default function ProjectSidebar({ selectedProject, onProjectSelect }: ProjectSidebarProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalSessions, setTotalSessions] = useState(0);

  const load = () => {
    setLoading(true);
    setError(null);
    getStatus()
      .then((stats) => {
        const projectList = Object.entries(stats.projects)
          .map(([path, count]) => ({ path, count }))
          .sort((a, b) => b.count - a.count);
        setProjects(projectList);
        setTotalSessions(stats.totalSessions);
      })
      .catch((err) => setError(err.message || 'Failed to load'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  return (
    <nav className="project-sidebar" data-testid="project-sidebar">
      <div className="project-sidebar-header">Projects</div>

      {loading ? (
        <div className="project-sidebar-loading">Loading...</div>
      ) : error ? (
        <div className="project-sidebar-error">
          <span>Server unavailable</span>
          <button onClick={load} className="retry-btn">Retry</button>
        </div>
      ) : (
        <ul className="project-list">
          <li
            className={`project-item ${selectedProject === null ? 'active' : ''}`}
            onClick={() => onProjectSelect(null)}
            title="All projects"
            data-testid="project-all"
          >
            <span className="project-name">All Projects</span>
            <span className="project-count">{totalSessions}</span>
          </li>

          {projects.map((p) => (
            <li
              key={p.path}
              className={`project-item ${selectedProject === p.path ? 'active' : ''}`}
              onClick={() => onProjectSelect(p.path)}
              title={p.path}
              data-testid={`project-item`}
            >
              <span className="project-name">{formatProjectName(p.path)}</span>
              <span className="project-count">{p.count}</span>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
