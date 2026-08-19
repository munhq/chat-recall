/**
 * OpenCode memory source.
 *
 * Indexes OpenCode sessions from its SQLite database at:
 *   ~/.local/share/opencode/opencode.db
 *
 * Tables used:
 * - session: id, project_id, title, directory, summary_files, time_created
 * - message: id, session_id, data (JSON with role)
 * - part: id, message_id, session_id, data (JSON with type, text, tool, cost, tokens)
 * - project: id, worktree, name
 */

import type { DatabaseSync } from 'node:sqlite';
import { openSqliteReadonlyOrThrow } from '../core/sqlite-reader.js';
import { existsSync } from 'fs';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
} from '../types/memory.js';
import { opencodeBackend as OPENCODE } from '../core/backends/opencode.js';
import { isSourceEnabled } from '../core/settings.js';

// OpenCode stores its sessions in its own SQLite file, so indexing it means
// reading that file — the only SQLite this project touches. Read with Node's
// built-in `node:sqlite` (22.5+, stable on the 24 we ship). It used to be
// better-sqlite3, a native optionalDependency, which meant this source silently
// yielded nothing whenever that module failed to build.

const MAX_CHUNK_CHARS = 2000;

export class OpenCodeSource implements MemorySource {
  readonly sourceType = 'session' as const;

  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || OPENCODE.dbPath();
  }

  async *discover(): AsyncGenerator<MemoryItem> {
    if (!isSourceEnabled('opencode', 'sessions')) return;
    if (!existsSync(this.dbPath)) return;
    let db: DatabaseSync;
    try {
      db = openSqliteReadonlyOrThrow(this.dbPath);
    } catch {
      return;
    }

    try {
      // Exclude subagent/child sessions (parent_id IS NOT NULL). OpenCode
      // dispatches like "@explorer find X" or "@general write Y" create
      // child rows in the same `session` table. Without this filter they
      // surface as standalone conversations in Recent/Activity/search,
      // duplicating the parent's work and burying the actual top-level
      // chats. Children are still queryable as subagents-of-parent via
      // `getOpenCodeSubagents(parentId)` on the conversation route.
      const sessions = db.prepare(`
        SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
               s.summary_files, s.summary_additions, s.summary_deletions,
               s.summary_diffs,
               p.worktree as project_path
        FROM session s
        LEFT JOIN project p ON s.project_id = p.id
        WHERE s.time_archived IS NULL AND s.parent_id IS NULL
        ORDER BY s.time_created DESC
      `).all() as Array<{
        id: string; title: string; directory: string;
        time_created: number; time_updated: number;
        summary_files: number | null;
        summary_additions: number | null;
        summary_deletions: number | null;
        summary_diffs: string | null;
        project_path: string;
      }>;

      for (const sess of sessions) {
        // Get first user message as preview
        const firstMsg = db.prepare(`
          SELECT data FROM part
          WHERE session_id = ? AND data LIKE '%"type":"text"%'
          ORDER BY time_created ASC LIMIT 1
        `).get(sess.id) as { data: string } | undefined;

        let preview = sess.title || '';
        if (firstMsg) {
          try {
            const partData = JSON.parse(firstMsg.data);
            if (partData.text) preview = partData.text.slice(0, 200);
          } catch {}
        }

        // Get cost/token totals from step-finish parts
        const costRow = db.prepare(`
          SELECT
            SUM(json_extract(data, '$.cost')) as total_cost,
            SUM(json_extract(data, '$.tokens.input')) as total_input,
            SUM(json_extract(data, '$.tokens.output')) as total_output,
            SUM(json_extract(data, '$.tokens.reasoning')) as total_reasoning,
            COUNT(*) as step_count
          FROM part
          WHERE session_id = ? AND data LIKE '%step-finish%'
        `).get(sess.id) as {
          total_cost: number | null;
          total_input: number | null;
          total_output: number | null;
          total_reasoning: number | null;
          step_count: number;
        } | undefined;

        // Get tools used in this session
        const toolRows = db.prepare(`
          SELECT DISTINCT json_extract(data, '$.tool') as tool_name
          FROM part WHERE session_id = ? AND data LIKE '%"type":"tool"%'
        `).all(sess.id) as Array<{ tool_name: string | null }>;
        const toolsUsed = toolRows.map(r => r.tool_name).filter(Boolean) as string[];

        // Get file modifications from summary
        const filesModified: string[] = [];
        if (sess.summary_diffs) {
          try {
            const diffs = JSON.parse(sess.summary_diffs as unknown as string);
            if (Array.isArray(diffs)) {
              for (const d of diffs) {
                if (d.path) filesModified.push(d.path);
              }
            }
          } catch {}
        }

        // Compute duration
        const durationMs = (sess.time_updated && sess.time_created)
          ? Math.max(0, sess.time_updated - sess.time_created)
          : 0;

        yield {
          id: OPENCODE.toPrefixedId(sess.id),
          sourceType: 'session',
          title: sess.title || `OpenCode Session ${sess.id.slice(4, 12)}`,
          projectPath: sess.project_path || sess.directory || '',
          filePath: this.dbPath,
          mtime: sess.time_updated || sess.time_created,
          contentPreview: preview,
          extra: {
            tool: 'opencode',
            slug: sess.title || '',
            messageCount: costRow?.step_count || 0,
            filesChanged: sess.summary_files || 0,
            additions: sess.summary_additions || 0,
            deletions: sess.summary_deletions || 0,
            // OpenCode pre-computes cost; expose it under the standard
            // `costUsd` name so the dossier reads one key across tools.
            costUsd: costRow?.total_cost || 0,
            estimatedCostUsd: costRow?.total_cost || 0,
            inputTokens: costRow?.total_input || 0,
            outputTokens: costRow?.total_output || 0,
            reasoningTokens: costRow?.total_reasoning || 0,
            durationMs,
            toolsUsed,
            filesModified,
            modelsUsed: [], // OpenCode doesn't expose model per session
          },
        };
      }
    } finally {
      db.close();
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(this.dbPath)) return [];

    const sessionId = item.id.replace('opencode_', '');
    const db = openSqliteReadonlyOrThrow(this.dbPath);
    const chunks: MemoryChunk[] = [];

    try {
      // Get text parts grouped by role
      const parts = db.prepare(`
        SELECT p.data, m.data as msg_data
        FROM part p
        JOIN message m ON p.message_id = m.id
        WHERE p.session_id = ?
        AND (p.data LIKE '%"type":"text"%' OR p.data LIKE '%"type":"reasoning"%')
        ORDER BY p.time_created ASC
      `).all(sessionId) as Array<{ data: string; msg_data: string }>;

      const userTexts: string[] = [];
      const assistantTexts: string[] = [];

      for (const part of parts) {
        try {
          const partData = JSON.parse(part.data);
          const msgData = JSON.parse(part.msg_data);
          const text = partData.text || '';
          if (text.length < 10) continue;

          if (msgData.role === 'user') {
            userTexts.push(text);
          } else {
            assistantTexts.push(text);
          }
        } catch {}
      }

      // User context chunk
      const userText = userTexts.join('\n\n').slice(0, MAX_CHUNK_CHARS);
      if (userText.length > 20) {
        chunks.push({
          chunkId: `${item.id}_user`,
          itemId: item.id,
          sourceType: 'session',
          title: item.title,
          text: userText,
          chunkType: 'user_context',
          projectPath: item.projectPath,
          filePath: item.filePath,
          mtime: item.mtime,
        });
      }

      // Assistant chunk
      const assistantText = assistantTexts.slice(0, 10).join('\n\n').slice(0, MAX_CHUNK_CHARS);
      if (assistantText.length > 20) {
        chunks.push({
          chunkId: `${item.id}_assistant`,
          itemId: item.id,
          sourceType: 'session',
          title: item.title,
          text: assistantText,
          chunkType: 'assistant',
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

  async extractLinks(_item: MemoryItem): Promise<MemoryLink[]> {
    return [];
  }
}
