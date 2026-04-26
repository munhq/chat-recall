/**
 * JSONL parser for Claude Code sessions.
 * Reads conversations on-demand without caching.
 */

import { open, readdir, readFile, stat } from 'fs/promises';
import { dirname, join, basename } from 'path';

// Client banners Claude Code prepends to user messages on session boundaries.
// Strip them from parsed messages so they don't render as part of the prompt.
const INJECTED_BANNERS: RegExp[] = [
  /MCP issues detected\. ?Run \/mcp list for status\.?/g,
  /Context low[^\n]*Run \/compact[^\n]*/g,
  /API Error:[^\n]{0,120}/g,
];
function stripBanners(text: string): string {
  let out = text;
  for (const re of INJECTED_BANNERS) out = out.replace(re, ' ');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

export interface Message {
  line: number;
  role: 'user' | 'assistant' | 'summary';
  content: string;
  thinking?: string;
  toolCalls?: Array<{
    name: string;
    input: any;
    result?: any;
    isError?: boolean;
  }>;
  timestamp?: string;
}

export interface Subagent {
  id: string;                   // basename without .jsonl
  kind: 'explore' | 'compact' | 'aside' | 'other';
  agentType?: string;           // from .meta.json (e.g. "Explore")
  description?: string;         // from .meta.json
  filePath: string;
  messageCount: number;
  toolUseCount: number;
  messages: Message[];
}

interface UserMessage {
  type: 'user';
  message: {
    content: string | Array<{ type: string; text?: string }>;
  };
}

interface AssistantMessage {
  type: 'assistant';
  message: {
    content: Array<{
      type: 'thinking' | 'text' | 'tool_use' | 'tool_result';
      thinking?: string;
      text?: string;
      name?: string;
      input?: any;
      tool_use_id?: string;
      content?: any;
    }>;
  };
}

interface SummaryMessage {
  type: 'summary';
  summary: string;
}

type SessionMessage = UserMessage | AssistantMessage | SummaryMessage;

/**
 * Parse a session JSONL file into messages.
 *
 * Claude Code stores tool_result blocks inside user messages that follow the
 * assistant's tool_use. We build a tool_use_id → result map in the first pass
 * and attach results to the originating tool_use in the second pass, then skip
 * the tool-result-only user messages so they don't render as empty turns.
 *
 * Extended-thinking blocks arrive with `thinking: ""` (the plaintext is not
 * returned, only a signed signature). We still surface the turn so the flow
 * is visible even when the text is empty.
 */
export async function getConversation(sessionPath: string): Promise<Message[]> {
  return parseMessagesFromFile(sessionPath);
}

async function parseMessagesFromFile(sessionPath: string): Promise<Message[]> {
  const file = await open(sessionPath);
  const raw: Array<{ line: number; obj: any }> = [];
  try {
    let lineNumber = 0;
    for await (const line of file.readLines()) {
      lineNumber++;
      if (!line.trim()) continue;
      try {
        raw.push({ line: lineNumber, obj: JSON.parse(line) });
      } catch (e) {
        console.error(`Error parsing line ${lineNumber}:`, e);
      }
    }
  } finally {
    await file.close();
  }

  const toolResults = new Map<string, { content: any; isError?: boolean }>();
  for (const { obj } of raw) {
    if (obj?.type !== 'user') continue;
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_result' && block.tool_use_id) {
        toolResults.set(block.tool_use_id, {
          content: block.content,
          isError: block.is_error === true,
        });
      }
    }
  }

  const messages: Message[] = [];
  for (const { line, obj } of raw) {
    if (!obj || typeof obj !== 'object') continue;
    const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;

    if (obj.type === 'user') {
      const content = obj.message?.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
          .map((c: any) => c.text)
          .join('\n');
      }
      if (!text.trim()) continue; // tool_result-only user messages are attached to the preceding assistant
      messages.push({ line, role: 'user', content: stripBanners(text), timestamp });
    } else if (obj.type === 'assistant') {
      const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
      const thinkingBlock = blocks.find((c: any) => c?.type === 'thinking');
      const textBlock = blocks.find((c: any) => c?.type === 'text');
      const toolUses = blocks.filter((c: any) => c?.type === 'tool_use');

      const toolCalls = toolUses.map((toolUse: any) => {
        const result = toolUse.id ? toolResults.get(toolUse.id) : undefined;
        return {
          name: toolUse.name || 'unknown',
          input: toolUse.input,
          result: result?.content,
          isError: result?.isError,
        };
      });

      const hasThinking = thinkingBlock !== undefined;
      const text = textBlock?.text ?? '';
      const thinking = thinkingBlock?.thinking ?? (hasThinking ? '' : undefined);

      if (!text && !hasThinking && toolCalls.length === 0) continue;
      messages.push({
        line,
        role: 'assistant',
        content: text,
        thinking,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        timestamp,
      });
    } else if (obj.type === 'summary' && typeof obj.summary === 'string') {
      messages.push({ line, role: 'summary', content: obj.summary });
    }
  }
  return messages;
}

/**
 * Discover and parse subagent conversations co-located with the main session.
 *
 * Claude Code writes subagent work to `<session-dir>/<session-id>/subagents/*.jsonl`
 * with a paired `.meta.json` carrying the agent type + description. The main
 * session JSONL has no direct reference — only filesystem co-location — so the
 * whole explore/compact/aside conversation is invisible in the viewer unless
 * we opt into reading the sidecar directory.
 *
 * Filename prefix encodes the kind: `agent-acompact-*` is a compaction summary
 * holding the condensed prior history, `agent-aside_question-*` is an aside Q&A,
 * anything else (`agent-a<hash>`) is a generic explore subagent.
 */
export async function getSubagents(sessionPath: string): Promise<Subagent[]> {
  const sessionId = basename(sessionPath).replace(/\.jsonl$/i, '');
  const subagentsDir = join(dirname(sessionPath), sessionId, 'subagents');

  let entries: string[];
  try {
    entries = await readdir(subagentsDir);
  } catch {
    return [];
  }

  const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'));
  const subagents: Subagent[] = [];

  for (const fileName of jsonlFiles) {
    const filePath = join(subagentsDir, fileName);
    const id = fileName.replace(/\.jsonl$/i, '');
    const kind: Subagent['kind'] = id.includes('acompact')
      ? 'compact'
      : id.includes('aside_question')
        ? 'aside'
        : id.includes('explore') || /^agent-a[0-9a-f]{16,}$/i.test(id)
          ? 'explore'
          : 'other';

    let agentType: string | undefined;
    let description: string | undefined;
    const metaPath = join(subagentsDir, `${id}.meta.json`);
    try {
      const metaRaw = await readFile(metaPath, 'utf-8');
      const meta = JSON.parse(metaRaw);
      agentType = typeof meta.agentType === 'string' ? meta.agentType : undefined;
      description = typeof meta.description === 'string' ? meta.description : undefined;
    } catch {
      // meta is optional
    }

    let messages: Message[] = [];
    try {
      messages = await parseMessagesFromFile(filePath);
    } catch (e) {
      console.error(`Failed to parse subagent ${filePath}:`, e);
    }

    const toolUseCount = messages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);
    subagents.push({
      id,
      kind,
      agentType,
      description,
      filePath,
      messageCount: messages.length,
      toolUseCount,
      messages,
    });
  }

  // Order by file mtime so they read chronologically when rendered in sequence
  const stats = await Promise.all(
    subagents.map(async (s) => {
      try {
        return (await stat(s.filePath)).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );
  return subagents
    .map((s, i) => ({ s, mtime: stats[i] }))
    .sort((a, b) => a.mtime - b.mtime)
    .map(({ s }) => s);
}

/**
 * Parse a Gemini CLI session JSON file.
 */
export async function getGeminiConversation(sessionPath: string): Promise<Message[]> {
  const { readFileSync } = await import('fs');
  const content = JSON.parse(readFileSync(sessionPath, 'utf-8'));
  const messages: Message[] = [];

  for (let i = 0; i < (content.messages || []).length; i++) {
    const msg = content.messages[i];
    const role: 'user' | 'assistant' = msg.type === 'user' ? 'user' : 'assistant';
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content.map((p: any) => p.text || '').join('\n');
    }
    if (text.trim()) {
      messages.push({ line: i + 1, role, content: text, timestamp: msg.timestamp });
    }
  }
  return messages;
}

/**
 * Parse an OpenCode session from SQLite.
 */
export async function getOpenCodeConversation(sessionId: string): Promise<Message[]> {
  const Database = (await import('better-sqlite3')).default;
  const { existsSync } = await import('fs');
  const { homedir } = await import('os');
  const { join } = await import('path');

  const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
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
