/**
 * JSONL parser for Claude Code sessions.
 * Reads conversations on-demand without caching.
 */

import { open } from 'fs/promises';

export interface Message {
  line: number;
  role: 'user' | 'assistant' | 'summary';
  content: string;
  thinking?: string;
  toolCalls?: Array<{
    name: string;
    input: any;
    result?: any;
  }>;
  timestamp?: string;
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
 * Parse a session JSONL file and yield messages.
 */
export async function* parseConversation(
  sessionPath: string
): AsyncGenerator<Message> {
  const file = await open(sessionPath);
  let lineNumber = 0;

  try {
    for await (const line of file.readLines()) {
      lineNumber++;

      if (!line.trim()) continue;

      try {
        const obj = JSON.parse(line) as SessionMessage;

        if (obj.type === 'user') {
          const content = typeof obj.message.content === 'string'
            ? obj.message.content
            : obj.message.content
                .filter((c) => c.type === 'text' && c.text)
                .map((c) => c.text)
                .join('\n');

          if (content) {
            yield {
              line: lineNumber,
              role: 'user',
              content,
            };
          }
        } else if (obj.type === 'assistant') {
          const contentArray = obj.message.content;

          const thinking = contentArray.find((c) => c.type === 'thinking')?.thinking;
          const text = contentArray.find((c) => c.type === 'text')?.text;
          const toolUses = contentArray.filter((c) => c.type === 'tool_use');
          const toolResults = contentArray.filter((c) => c.type === 'tool_result');

          // Map tool results to tool uses
          const toolCalls = toolUses.map((toolUse) => {
            const result = toolResults.find(
              (r) => r.tool_use_id === toolUse.name
            );
            return {
              name: toolUse.name || 'unknown',
              input: toolUse.input,
              result: result?.content,
            };
          });

          if (text || thinking || toolCalls.length > 0) {
            yield {
              line: lineNumber,
              role: 'assistant',
              content: text || '',
              thinking,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            };
          }
        } else if (obj.type === 'summary') {
          yield {
            line: lineNumber,
            role: 'summary',
            content: obj.summary,
          };
        }
      } catch (parseError) {
        console.error(`Error parsing line ${lineNumber}:`, parseError);
        // Skip malformed lines
      }
    }
  } finally {
    await file.close();
  }
}

/**
 * Get all messages from a session as an array.
 */
export async function getConversation(sessionPath: string): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const msg of parseConversation(sessionPath)) {
    messages.push(msg);
  }
  return messages;
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
