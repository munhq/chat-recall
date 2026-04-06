/**
 * Status widget - shows real-time index stats via SSE + memory stats.
 */

import React, { useEffect, useState } from 'react';
import { subscribeToStatus, getMemoryStatus, type IndexStats, type MemoryStatus } from '../services/api';
import './StatusWidget.css';

export default function StatusWidget() {
  const [stats, setStats] = useState<IndexStats | null>(null);
  const [memoryStats, setMemoryStats] = useState<MemoryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToStatus(
      (newStats) => {
        setStats(newStats);
        setError(null);
      },
      (err) => {
        setError(err.message);
      }
    );

    // Also fetch memory stats
    getMemoryStatus().then(setMemoryStats).catch(() => {
      // Memory index might not exist yet - that's ok
    });

    return () => {
      unsubscribe();
    };
  }, []);

  if (error) {
    return (
      <div className="status-widget error">
        <span className="status-indicator error">●</span>
        Error: {error}
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="status-widget loading">
        <span className="status-indicator loading">●</span>
        Loading...
      </div>
    );
  }

  const memoryItemCount = memoryStats?.totalItems || 0;

  return (
    <div className="status-widget">
      <span className="status-indicator active">●</span>
      <div className="status-info">
        <span className="status-sessions">
          {stats.totalSessions} sessions
        </span>
        <span className="status-chunks">
          {stats.totalChunks} chunks
        </span>
        {memoryItemCount > 0 && (
          <span className="status-memory">
            {memoryItemCount} memory items
          </span>
        )}
      </div>
    </div>
  );
}
