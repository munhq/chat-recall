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
  try { content = JSON.parse(text); } catch { return []; }
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

