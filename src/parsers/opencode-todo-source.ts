/**
 * OpenCode Todo memory source.
 *
 * Indexes OpenCode tasks/todos from its SQLite database.
 * Table: todo (session_id, content, status, priority, position)
 * Groups todos by session for discovery.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
} from '../types/memory.js';

export class OpenCodeTodoSource implements MemorySource {
  readonly sourceType = 'task' as const;

  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  }

  async *discover(): AsyncGenerator<MemoryItem> {
    if (!existsSync(this.dbPath)) return;

    let db: Database.Database;
    try {
      db = new Database(this.dbPath, { readonly: true });
    } catch {
      return;
    }

    try {
      // Group todos by session
      const sessions = db.prepare(`
        SELECT t.session_id, s.title as session_title, s.directory,
               p.worktree as project_path,
               COUNT(*) as todo_count,
               SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) as completed_count,
               MAX(t.time_updated) as last_updated
        FROM todo t
        JOIN session s ON t.session_id = s.id
        LEFT JOIN project p ON s.project_id = p.id
        GROUP BY t.session_id
        ORDER BY last_updated DESC
      `).all() as Array<{
        session_id: string;
        session_title: string;
        directory: string;
        project_path: string;
        todo_count: number;
        completed_count: number;
        last_updated: number;
      }>;

      for (const sess of sessions) {
        // Get individual todos for this session
        const todos = db.prepare(`
          SELECT content, status, priority FROM todo
          WHERE session_id = ? ORDER BY position ASC
        `).all(sess.session_id) as Array<{ content: string; status: string; priority: number }>;

        const preview = todos
          .map(t => `[${t.status}] ${t.content}`)
          .join('\n')
          .slice(0, 300);

        const title = `${sess.session_title || 'OpenCode Tasks'} (${sess.completed_count}/${sess.todo_count} done)`;

        yield {
          id: `opencode_todo_${sess.session_id}`,
          sourceType: 'task',
          title,
          projectPath: sess.project_path || sess.directory || '',
          filePath: this.dbPath,
          mtime: sess.last_updated || Date.now(),
          contentPreview: preview,
          extra: {
            tool: 'opencode',
            sessionId: sess.session_id,
            todoCount: sess.todo_count,
            completedCount: sess.completed_count,
          },
        };
      }
    } finally {
      db.close();
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(this.dbPath)) return [];

    const sessionId = (item.extra?.sessionId as string) || item.id.replace('opencode_todo_', '');
    const db = new Database(this.dbPath, { readonly: true });
    const chunks: MemoryChunk[] = [];

    try {
      const todos = db.prepare(`
        SELECT content, status, priority FROM todo
        WHERE session_id = ? ORDER BY position ASC
      `).all(sessionId) as Array<{ content: string; status: string; priority: number }>;

      if (todos.length > 0) {
        const text = todos
          .map(t => `[${t.status}] (p${t.priority}) ${t.content}`)
          .join('\n');

        chunks.push({
          chunkId: `${item.id}_todos`,
          itemId: item.id,
          sourceType: 'task',
          title: item.title,
          text: text.slice(0, 2000),
          chunkType: 'task_list',
          projectPath: item.projectPath,
          filePath: item.filePath,
          mtime: item.mtime,
        });
      }
    } finally {
      db.close();
    }

    return chunks;
  }

  async extractLinks(item: MemoryItem): Promise<MemoryLink[]> {
    const sessionId = item.extra?.sessionId as string;
    if (sessionId) {
      return [{
        sourceType: 'task',
        sourceId: item.id,
        targetType: 'session',
        targetId: `opencode_${sessionId}`,
        linkType: 'task_in_session',
        confidence: 1.0,
      }];
    }
    return [];
  }
}
