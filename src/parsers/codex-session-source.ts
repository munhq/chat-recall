/**
 * Codex CLI session memory source.
 *
 * Discovers and indexes Codex CLI sessions from:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
} from '../types/memory.js';

const MAX_CHUNK_CHARS = 2000;

interface CodexSessionMeta {
  id: string;
  timestamp: string;
  cwd: string;
  model_provider?: string;
  cli_version?: string;
  // Codex writes a separate rollout file for every sub-agent dispatch the
  // parent makes. Those files carry agent_role / agent_nickname in their
  // session_meta; the human-facing parent rollout does not. We skip them
  // during discovery so a single user conversation doesn't surface as N
  // top-level sessions.
  agent_role?: string;
  agent_nickname?: string;
}

interface CodexEvent {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    message?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    summary?: Array<{ type?: string; text?: string }>;
    name?: string;
    arguments?: string;
    tool_calls?: Array<unknown>;
    [key: string]: unknown;
  };
}

function getCodexSessionsDir(): string {
  return join(homedir(), '.codex', 'sessions');
}

function extractTextFromContent(content?: Array<{ type?: string; text?: string }>): string {
  if (!Array.isArray(content)) return '';
  return content.map((c) => c.text || '').filter(Boolean).join('\n');
}

function extractReasoningText(event: CodexEvent): string {
  const payload = event.payload;
  if (!payload) return '';
  if (Array.isArray(payload.summary)) {
    const text = payload.summary.map((s) => s.text || '').filter(Boolean).join('\n');
    if (text) return text;
  }
  if (typeof payload.content === 'string' && payload.content) {
    return payload.content;
  }
  if (typeof payload.encrypted_content === 'string' && payload.encrypted_content) {
    return payload.encrypted_content;
  }
  return '';
}

function readJsonlLines(filePath: string): CodexEvent[] {
  const text = readFileSync(filePath, 'utf-8');
  const lines = text.split('\n');
  const events: CodexEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as CodexEvent);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

export class CodexSessionSource implements MemorySource {
  readonly sourceType = 'session' as const;

  private sessionsDir: string;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir || getCodexSessionsDir();
  }

  async *discover(): AsyncGenerator<MemoryItem> {
    if (!existsSync(this.sessionsDir)) return;

    const jsonlFiles = this.collectJsonlFiles(this.sessionsDir);

    for (const filePath of jsonlFiles) {
      try {
        const stat = statSync(filePath);
        const lines = readFileSync(filePath, 'utf-8').split('\n');
        const firstLine = lines.find((l) => l.trim());
        if (!firstLine) continue;

        const firstEvent = JSON.parse(firstLine) as CodexEvent;
        if (firstEvent.type !== 'session_meta' || !firstEvent.payload) continue;

        const meta = firstEvent.payload as unknown as CodexSessionMeta;

        // Skip sub-agent rollouts — only the human-facing parent session
        // should appear as a top-level item.
        if (meta.agent_role || meta.agent_nickname) continue;

        const sessionId = meta.id || basename(filePath).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
        const itemId = `codex_${sessionId}`;

        const events = readJsonlLines(filePath);

        // Find first user prompt
        let firstPrompt = '';
        for (const ev of events) {
          if (ev.type === 'event_msg' && ev.payload?.type === 'user_message' && ev.payload.message) {
            firstPrompt = ev.payload.message;
            break;
          }
        }

        // Count messages
        let userMsgCount = 0;
        let assistantMsgCount = 0;
        for (const ev of events) {
          if (ev.type === 'event_msg' && ev.payload?.type === 'user_message') {
            userMsgCount++;
          } else if (ev.type === 'response_item' && ev.payload?.type === 'message') {
            assistantMsgCount++;
          }
        }
        const messageCount = userMsgCount + assistantMsgCount;
        if (messageCount < 2) continue;

        yield {
          id: itemId,
          sourceType: 'session',
          title: firstPrompt.replace(/\n/g, ' ').trim().slice(0, 100) || `Codex Session ${sessionId.slice(0, 8)}`,
          projectPath: meta.cwd || '',
          filePath,
          mtime: stat.mtimeMs,
          contentPreview: firstPrompt.slice(0, 200),
          extra: {
            tool: 'codex',
            modelProvider: meta.model_provider || '',
            cliVersion: meta.cli_version || '',
            messageCount,
          },
        };
      } catch {
        continue;
      }
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(item.filePath)) return [];

    const events = readJsonlLines(item.filePath);
    const chunks: MemoryChunk[] = [];

    const userTexts: string[] = [];
    const assistantTexts: string[] = [];
    const reasoningTexts: string[] = [];
    const toolTexts: string[] = [];

    for (const ev of events) {
      if (ev.type === 'event_msg' && ev.payload?.type === 'user_message') {
        const text = ev.payload.message || '';
        if (text) userTexts.push(text);
      } else if (ev.type === 'response_item') {
        const payload = ev.payload;
        if (!payload) continue;

        if (payload.type === 'message') {
          const text = extractTextFromContent(payload.content);
          if (text) {
            // Only treat assistant-role messages as assistant chunks;
            // skip developer/user context injections.
            if (payload.role === 'assistant') {
              assistantTexts.push(text);
            }
          }
        } else if (payload.type === 'reasoning') {
          const text = extractReasoningText(ev);
          if (text) reasoningTexts.push(text);
        } else if (payload.type === 'function_call') {
          let text = '';
          if (payload.name) text += `Tool: ${payload.name}\n`;
          if (payload.arguments) text += `Args: ${payload.arguments}`;
          if (text) toolTexts.push(text);
        }
      }
    }

    // User chunks
    const userChunkText = userTexts.join('\n\n').slice(0, MAX_CHUNK_CHARS);
    if (userChunkText.length > 20) {
      chunks.push({
        chunkId: `${item.id}_user_0`,
        itemId: item.id,
        sourceType: 'session',
        title: item.title,
        text: userChunkText,
        chunkType: 'user',
        projectPath: item.projectPath,
        filePath: item.filePath,
        mtime: item.mtime,
      });
    }

    // Assistant chunks
    const assistantChunkText = assistantTexts.join('\n\n').slice(0, MAX_CHUNK_CHARS);
    if (assistantChunkText.length > 20) {
      chunks.push({
        chunkId: `${item.id}_assistant_0`,
        itemId: item.id,
        sourceType: 'session',
        title: item.title,
        text: assistantChunkText,
        chunkType: 'assistant',
        projectPath: item.projectPath,
        filePath: item.filePath,
        mtime: item.mtime,
      });
    }

    // Reasoning chunks
    const reasoningChunkText = reasoningTexts.join('\n\n').slice(0, MAX_CHUNK_CHARS);
    if (reasoningChunkText.length > 20) {
      chunks.push({
        chunkId: `${item.id}_thinking_0`,
        itemId: item.id,
        sourceType: 'session',
        title: item.title,
        text: reasoningChunkText,
        chunkType: 'thinking',
        projectPath: item.projectPath,
        filePath: item.filePath,
        mtime: item.mtime,
      });
    }

    // Tool chunks
    const toolChunkText = toolTexts.join('\n\n').slice(0, MAX_CHUNK_CHARS);
    if (toolChunkText.length > 20) {
      chunks.push({
        chunkId: `${item.id}_tool_0`,
        itemId: item.id,
        sourceType: 'session',
        title: item.title,
        text: toolChunkText,
        chunkType: 'tool',
        projectPath: item.projectPath,
        filePath: item.filePath,
        mtime: item.mtime,
      });
    }

    return chunks;
  }

  async extractLinks(_item: MemoryItem): Promise<MemoryLink[]> {
    return [];
  }

  private collectJsonlFiles(dir: string): string[] {
    const results: string[] = [];
    if (!existsSync(dir)) return results;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.collectJsonlFiles(fullPath));
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }

    return results;
  }
}
