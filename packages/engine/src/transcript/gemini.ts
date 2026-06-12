/**
 * Gemini CLI transcript parser. Ported verbatim from services/parser.ts.
 */
import type { TranscriptMessage as Message, Subagent, ToolCall } from './types.js';

/**
 * Parse a Gemini CLI session JSON file.
 */
export async function parseGeminiTranscript(sessionPath: string): Promise<Message[]> {
  const { readFileSync } = await import('fs');
  return parseGeminiTranscriptText(readFileSync(sessionPath, 'utf-8'));
}

/** Same parse over in-memory text — what the server runs on archived raw. */
export function parseGeminiTranscriptText(text: string): Message[] {
  let content: any;
  try { content = JSON.parse(text); } catch {
    // Not a single JSON document → the JSONL chat format
    // (tmp/<hash>/chats/session-*.jsonl): header line, message lines
    // (type user|gemini, content string or [{text}], thoughts[]), and
    // {$set:…} update lines to skip.
    return parseGeminiChatJsonl(text);
  }
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


function parseGeminiChatJsonl(text: string): Message[] {
  const messages: Message[] = [];
  let lineNum = 0;
  for (const line of text.split('\n')) {
    lineNum++;
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.$set || o.kind === 'main' || (!o.type && o.sessionId)) continue; // header/update lines
    if (o.type !== 'user' && o.type !== 'gemini') continue;
    const role: 'user' | 'assistant' = o.type === 'user' ? 'user' : 'assistant';
    const body = typeof o.content === 'string'
      ? o.content
      : Array.isArray(o.content) ? o.content.map((p: any) => p?.text || '').join('\n') : '';
    const thinking = Array.isArray(o.thoughts) && o.thoughts.length > 0
      ? o.thoughts.map((t: any) => [t?.subject, t?.description].filter(Boolean).join(': ')).join('\n')
      : undefined;
    if (!body.trim() && !thinking) continue;
    messages.push({ line: lineNum, role, content: body, thinking, timestamp: o.timestamp });
  }
  return messages;
}
