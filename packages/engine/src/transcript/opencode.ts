/**
 * OpenCode transcript parser — SQLite-backed sessions + child sessions.
 * Ported verbatim from services/parser.ts.
 */
import type { TranscriptMessage as Message, Subagent, ToolCall } from './types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('transcript-opencode');

/**
 * Discover OpenCode sub-agent sessions spawned by a parent. OpenCode
 * stores each `@explorer …` / `@general …` dispatch as its own row in
 * the `session` table with `parent_id` pointing back at the parent —
 * structurally the same shape as Codex sub-agent rollouts, just in
 * SQLite instead of JSONL. Returns them in the same `Subagent` shape
 * the UI renders for Codex/Claude so the conversation viewer can show
 * collapsible sub-agent panels uniformly.
 */
export async function parseOpenCodeSubagents(parentSessionId: string): Promise<Subagent[]> {
  const Database = (await import('better-sqlite3')).default;
  const { existsSync } = await import('fs');
  const { opencodeBackend } = await import('../core/backends/opencode.js');

  const dbPath = opencodeBackend.dbPath();
  if (!existsSync(dbPath)) return [];

  const realParent = parentSessionId.replace('opencode_', '');
  const db = new Database(dbPath, { readonly: true });
  try {
    const children = db.prepare(`
      SELECT id, title, time_created
      FROM session
      WHERE parent_id = ? AND time_archived IS NULL
      ORDER BY time_created ASC
    `).all(realParent) as Array<{ id: string; title: string; time_created: number }>;

    const out: Subagent[] = [];
    for (const c of children) {
      const childId = `opencode_${c.id}`;
      let messages: Message[] = [];
      try { messages = await parseOpenCodeTranscript(childId); }
      catch (e) { log.error({ err: e, sessionId: c.id }, 'Failed to parse OpenCode sub-session'); }
      const toolUseCount = messages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);

      // Heuristic kind from the title prefix (`@explorer`, `@general`, …).
      const m = (c.title || '').match(/@(\w+)/);
      const role = (m?.[1] || '').toLowerCase();
      const kind: Subagent['kind'] =
          role.includes('compact') ? 'compact'
        : role.includes('aside')   ? 'aside'
        : role.includes('explorer') || role.includes('explore') ? 'explore'
        : 'other';

      out.push({
        id: childId,
        kind,
        agentType: m?.[1],
        description: c.title,
        filePath: '',
        messageCount: messages.length,
        toolUseCount,
        messages,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Parse an OpenCode session from SQLite.
 */
export async function parseOpenCodeTranscript(sessionId: string): Promise<Message[]> {
  const Database = (await import('better-sqlite3')).default;
  const { existsSync } = await import('fs');
  const { opencodeBackend } = await import('../core/backends/opencode.js');

  const dbPath = opencodeBackend.dbPath();
  if (!existsSync(dbPath)) return [];

  const realId = sessionId.replace('opencode_', '');
  const db = new Database(dbPath, { readonly: true });
  const messages: Message[] = [];

  try {
    const parts = db.prepare(`
      SELECT p.data, p.time_created, m.data as msg_data
      FROM part p
      JOIN message m ON p.message_id = m.id
      WHERE p.session_id = ?
      ORDER BY p.time_created ASC
    `).all(realId) as Array<{ data: string; time_created: number; msg_data: string }>;

    let lineNum = 0;
    for (const part of parts) {
      try {
        const partData = JSON.parse(part.data);
        const msgData = JSON.parse(part.msg_data);
        const role: 'user' | 'assistant' = msgData.role === 'user' ? 'user' : 'assistant';

        if (partData.type === 'text' && partData.text?.trim()) {
          lineNum++;
          messages.push({ line: lineNum, role, content: partData.text });
        } else if (partData.type === 'tool' && partData.tool) {
          lineNum++;
          messages.push({
            line: lineNum,
            role: 'assistant',
            content: `Tool: ${partData.tool}`,
            toolCalls: [{ name: partData.tool, input: partData.state || {} }],
          });
        }
      } catch {}
    }
  } finally {
    db.close();
  }
  return messages;
}


