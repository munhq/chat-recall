/**
 * Gemini CLI memory source.
 *
 * Indexes Gemini CLI conversation sessions from ~/.gemini/tmp/<project>/chats/
 * and ~/.gemini/antigravity/brain/<uuid>/session_summary.md
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
} from '../types/memory.js';
import { geminiBackend as GEMINI } from '../core/backends/gemini.js';
import { isSourceEnabled } from '../core/settings.js';

const MAX_CHUNK_CHARS = 2000;

import { createHash } from 'crypto';

/** Build a map of SHA-256(projectPath) -> projectPath from gemini's projects.json */
function loadGeminiProjectMap(): Map<string, string> {
  const map = new Map<string, string>();
  const projectsPath = GEMINI.projectsJson();
  if (!existsSync(projectsPath)) return map;

  try {
    const data = JSON.parse(readFileSync(projectsPath, 'utf-8'));
    const projects = data.projects || {};
    for (const [path] of Object.entries(projects)) {
      // Gemini CLI names dirs by SHA-256 of the project path
      const hash = createHash('sha256').update(path).digest('hex');
      map.set(hash, path);
    }
  } catch {}
  return map;
}

export class GeminiSessionSource implements MemorySource {
  readonly sourceType = 'session' as const;

  private geminiDir: string;
  private projectMap: Map<string, string>;

  constructor(geminiDir?: string) {
    this.geminiDir = geminiDir || GEMINI.homeDir();
    this.projectMap = loadGeminiProjectMap();
  }

  async *discover(): AsyncGenerator<MemoryItem> {
    if (!isSourceEnabled('gemini', 'sessions')) return;
    const tmpDir = join(this.geminiDir, 'tmp');
    if (!existsSync(tmpDir)) return;

    const seen = new Set<string>();

    // Scan ~/.gemini/tmp/*/chats/session-*.json
    try {
      for (const projectDirEntry of readdirSync(tmpDir, { withFileTypes: true })) {
        if (!projectDirEntry.isDirectory()) continue;
        const chatsDir = join(tmpDir, projectDirEntry.name, 'chats');
        if (!existsSync(chatsDir)) continue;

        for (const file of readdirSync(chatsDir)) {
          if (!file.endsWith('.json') || !file.startsWith('session-')) continue;

          const filePath = join(chatsDir, file);
          try {
            const stat = statSync(filePath);
            const content = JSON.parse(readFileSync(filePath, 'utf-8'));
            const sessionId = content.sessionId || basename(file, '.json');

            if (seen.has(sessionId)) continue;
            seen.add(sessionId);

            // Resolve project path from SHA-256 hash dir name
            const projectPath = this.projectMap.get(projectDirEntry.name) || '';

            const messages = content.messages || [];
            if (messages.length < 2) continue; // Skip empty/trivial sessions

            // Skip summary generator artifacts (chat-recall pipes prompts through gemini CLI)
            const firstUserMsg = messages.find((m: any) => m.type === 'user');
            const firstContent = typeof firstUserMsg?.content === 'string'
              ? firstUserMsg.content
              : Array.isArray(firstUserMsg?.content)
                ? (firstUserMsg.content[0]?.text || '')
                : '';
            if (firstContent.includes('summarizing a coding assistant conversation')) continue;

            const firstPrompt = firstContent.slice(0, 200);

            // Extract tokens, models, tools from all gemini messages
            let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, thinkingTokens = 0;
            const modelsUsed = new Set<string>();
            const toolsUsed = new Set<string>();
            const filesModified: string[] = [];

            for (const m of messages) {
              if (m.type !== 'gemini') continue;
              const tok = m.tokens;
              if (tok) {
                inputTokens += (tok.input || 0);
                outputTokens += (tok.output || 0);
                cacheReadTokens += (tok.cached || 0);
                thinkingTokens += (tok.thoughts || 0);
              }
              if (m.model) modelsUsed.add(m.model);
              for (const tc of (m.toolCalls || [])) {
                const name = tc.name || tc.displayName || '';
                if (name) toolsUsed.add(name);
                // Track file modifications from write_file/replace tool calls
                if ((name === 'write_file' || name === 'replace') && tc.args?.path) {
                  filesModified.push(tc.args.path);
                }
              }
            }

            // Compute duration from timestamps
            let durationMs = 0;
            if (content.startTime && content.lastUpdated) {
              durationMs = new Date(content.lastUpdated).getTime() - new Date(content.startTime).getTime();
              if (durationMs < 0) durationMs = 0;
            }

            yield {
              id: GEMINI.toPrefixedId(sessionId),
              sourceType: 'session',
              title: firstPrompt.slice(0, 100) || `Gemini Session ${sessionId.slice(0, 8)}`,
              projectPath,
              filePath,
              mtime: stat.mtimeMs,
              contentPreview: firstPrompt,
              extra: {
                tool: 'gemini',
                messageCount: messages.length,
                startTime: content.startTime || '',
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheCreationTokens: 0,
                peakContextTokens: 0,
                thinkingTokens,
                durationMs,
                modelsUsed: [...modelsUsed],
                toolsUsed: [...toolsUsed],
                filesModified: [...new Set(filesModified)],
                slug: firstPrompt.slice(0, 60),
              },
            };
          } catch {
            continue;
          }
        }
      }
    } catch {}
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(item.filePath)) return [];

    const content = JSON.parse(readFileSync(item.filePath, 'utf-8'));
    const messages = content.messages || [];
    const chunks: MemoryChunk[] = [];

    // Extract text content (handles both string and array formats)
    const getText = (m: any): string => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.map((p: any) => p.text || '').join('\n');
      return '';
    };

    // Chunk 1: Combined user messages
    const userMsgs = messages
      .filter((m: any) => m.type === 'user' && m.content)
      .map(getText)
      .join('\n\n')
      .slice(0, MAX_CHUNK_CHARS);

    if (userMsgs.length > 20) {
      chunks.push({
        chunkId: `${item.id}_user`,
        itemId: item.id,
        sourceType: 'session',
        title: item.title,
        text: userMsgs,
        chunkType: 'user_context',
        projectPath: item.projectPath,
        filePath: item.filePath,
        mtime: item.mtime,
      });
    }

    // Chunk 2: Combined assistant messages
    const assistantMsgs = messages
      .filter((m: any) => m.type === 'gemini' && m.content)
      .slice(0, 10)
      .map(getText)
      .join('\n\n')
      .slice(0, MAX_CHUNK_CHARS);

    if (assistantMsgs.length > 20) {
      chunks.push({
        chunkId: `${item.id}_assistant`,
        itemId: item.id,
        sourceType: 'session',
        title: item.title,
        text: assistantMsgs,
        chunkType: 'assistant',
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
}
