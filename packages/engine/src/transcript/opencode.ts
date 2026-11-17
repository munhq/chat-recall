/**
 * OpenCode transcript parser — SQLite-backed sessions + child sessions.
 * Ported verbatim from services/parser.ts.
 */
import { openOpencodeDbOrThrow } from '../core/backends/opencode-v2.js';
import type { TranscriptMessage as Message, Subagent, ToolCall } from './types.js';
import { createLogger } from '../core/logger.js';
import { capPayload } from './trim.js';

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
export async function parseOpenCodeSubagents(parentSessionId: string, opts: OpenCodeParseOptions = {}): Promise<Subagent[]> {
  const { existsSync } = await import('fs');
  const { opencodeBackend } = await import('../core/backends/opencode.js');

  const dbPath = opencodeBackend.dbPath();
  if (!existsSync(dbPath)) return [];

  const realParent = parentSessionId.replace('opencode_', '');
  const db = openOpencodeDbOrThrow(dbPath);
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
      try { messages = await parseOpenCodeTranscript(childId, opts); }
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
export interface OpenCodeParseOptions {
  /** Cut each tool state to this many characters as its row is read. */
  payloadCap?: number;
  /** The cut to apply to each payload. It wins over `payloadCap` and carries the budget of a whole session. */
  cut?: (v: unknown) => unknown;
  /** The cut to apply to the text of each message. */
  cutText?: (v: unknown) => unknown;
}

export async function parseOpenCodeTranscript(sessionId: string, opts: OpenCodeParseOptions = {}): Promise<Message[]> {
  const { existsSync } = await import('fs');
  const { opencodeBackend } = await import('../core/backends/opencode.js');

  const dbPath = opencodeBackend.dbPath();
  if (!existsSync(dbPath)) return [];

  const realId = sessionId.replace('opencode_', '');
  const db = openOpencodeDbOrThrow(dbPath);
  const messages: Message[] = [];

  try {
    // One row at a time: a row holds a whole tool output, so the rows of a large
    // session are never all in memory together.
    const parts = db.prepare(`
      SELECT p.data, p.time_created, m.data as msg_data
      FROM part p
      JOIN (SELECT id, data FROM message WHERE session_id = ?) m ON p.message_id = m.id
      WHERE p.session_id = ?
      ORDER BY p.time_created ASC
    `).iterate(realId, realId) as Iterable<{ data: string; time_created: number; msg_data: string }>;

    const cap = opts.cut ?? (opts.payloadCap ? (v: unknown) => capPayload(v, opts.payloadCap) : (v: unknown) => v);
    // The parts of one message carry the same message row, so its role is read once.
    let lastMsgData = '';
    let lastRole: 'user' | 'assistant' = 'assistant';
    let lineNum = 0;
    for (const part of parts) {
      try {
        const partData = JSON.parse(part.data);
        if (part.msg_data !== lastMsgData) {
          lastRole = JSON.parse(part.msg_data).role === 'user' ? 'user' : 'assistant';
          lastMsgData = part.msg_data;
        }
        const role = lastRole;

        if (partData.type === 'text' && partData.text?.trim()) {
          lineNum++;
          messages.push({ line: lineNum, role, content: opts.cutText ? opts.cutText(partData.text) as string : partData.text });
        } else if (partData.type === 'tool' && partData.tool) {
          lineNum++;
          messages.push({
            line: lineNum,
            role: 'assistant',
            content: `Tool: ${partData.tool}`,
            toolCalls: [{ name: partData.tool, input: cap(partData.state || {}) }],
          });
        }
      } catch {}
    }
  } finally {
    db.close();
  }
  return messages;
}


