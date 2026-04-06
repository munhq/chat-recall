/**
 * Session parser for Claude Code JSONL files.
 */

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join, basename } from 'path';

export interface SessionEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

export interface ExtractedContent {
  text: string;
  lineNumber: number;
  contentType: 'user' | 'assistant' | 'tool_result' | 'web_search';
}

export interface SessionMetadata {
  toolsUsed: string[];
  gitBranch: string;
  slug: string;
  durationMs: number;
  lastStopReason: string;
  filesModified: string[];
  modelsUsed: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  peakContextTokens: number;
  messageCount: number;
}

export interface SessionContent {
  sessionId: string;
  sessionPath: string;
  summaries: string[];
  userMessages: ExtractedContent[];
  assistantMessages: ExtractedContent[];
  toolResults: ExtractedContent[];
  toolsUsed: Set<string>;
  firstPrompt: string;
  metadata: SessionMetadata;
}

function removeCodeBlocks(text: string): string {
  // Remove fenced code blocks
  let result = text.replace(/```[\s\S]*?```/g, '[code block]');
  // Remove inline code
  result = result.replace(/`[^`]+`/g, '[code]');
  return result;
}

function extractKeyText(text: string, maxLength = 800): string {
  // Remove code blocks
  let result = removeCodeBlocks(text);
  
  // Remove common boilerplate phrases
  const boilerplate = [
    /^Let me /i,
    /^I'll /i,
    /^I will /i,
    /^Now I'll /i,
    /^Here's what /i,
  ];
  for (const pattern of boilerplate) {
    result = result.replace(pattern, '');
  }
  
  // Normalize whitespace
  result = result.replace(/\s+/g, ' ').trim();
  
  return result.slice(0, maxLength);
}

function isValuableToolResult(content: string, toolName = ''): boolean {
  if (!content || content.length < 20) {
    return false;
  }
  
  // Skip common low-value results
  const skipPatterns = [
    /^Tool ran without output/i,
    /^No (?:matches|results) found/i,
    /^File (?:created|updated|deleted)/i,
    /^Command completed/i,
    /^\s*$/,
  ];
  
  for (const pattern of skipPatterns) {
    if (pattern.test(content)) {
      return false;
    }
  }
  
  // Prioritize web search results
  if (['WebSearch', 'WebFetch'].includes(toolName) || content.toLowerCase().includes('http')) {
    return true;
  }
  
  // Skip very long outputs (likely file contents or logs)
  if (content.length > 5000) {
    return false;
  }
  
  return true;
}

export function parseSessionsIndex(indexPath: string): SessionEntry[] {
  if (!existsSync(indexPath)) {
    return [];
  }
  
  const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
  const entries = data.entries || [];
  
  return entries.map((e: Record<string, unknown>) => ({
    sessionId: e.sessionId as string || '',
    fullPath: e.fullPath as string || '',
    fileMtime: e.fileMtime as number || 0,
    firstPrompt: e.firstPrompt as string || '',
    messageCount: e.messageCount as number || 0,
    created: e.created as string || '',
    modified: e.modified as string || '',
    gitBranch: e.gitBranch as string || '',
    projectPath: e.projectPath as string || '',
    isSidechain: e.isSidechain as boolean || false,
  }));
}

export function* iterAllSessionIndices(claudeDir?: string): Generator<[string, SessionEntry[]]> {
  const dir = claudeDir || join(homedir(), '.claude', 'projects');
  
  if (!existsSync(dir)) {
    return;
  }
  
  const entries = readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    const projectDir = join(dir, entry.name);
    const indexPath = join(projectDir, 'sessions-index.json');
    
    if (existsSync(indexPath)) {
      const sessions = parseSessionsIndex(indexPath);
      if (sessions.length > 0) {
        yield [projectDir, sessions];
      }
    }
  }
}

/**
 * Returns true if this is a new-format session with subagents dir.
 * New format: {uuid}.jsonl (stub) + {uuid}/subagents/agent-*.jsonl (real content)
 */
export function hasSubagentsDir(sessionPath: string): boolean {
  const dir = sessionPath.slice(0, -6); // strip .jsonl
  return existsSync(join(dir, 'subagents'));
}

/**
 * Get all agent-*.jsonl paths from {uuid}/subagents/, sorted by name for stable ordering.
 */
function getSubagentPaths(sessionPath: string): string[] {
  const subagentsDir = join(sessionPath.slice(0, -6), 'subagents');
  if (!existsSync(subagentsDir)) return [];
  return readdirSync(subagentsDir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .map(f => join(subagentsDir, f));
}

/**
 * For new-format sessions, derive the project path from the most common cwd
 * across subagent user-message entries. Falls back to folderDerivedPath if
 * no cwd data is found (e.g., all subagents ran without cwd field).
 */
export function getSubagentProjectPath(sessionPath: string, folderDerivedPath: string): string {
  const subagentPaths = getSubagentPaths(sessionPath);
  if (subagentPaths.length === 0) return folderDerivedPath;

  const cwdCounts = new Map<string, number>();

  for (const filePath of subagentPaths) {
    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.type === 'user' && typeof entry.cwd === 'string' && entry.cwd) {
            cwdCounts.set(entry.cwd, (cwdCounts.get(entry.cwd) ?? 0) + 1);
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  }

  if (cwdCounts.size === 0) return folderDerivedPath;

  // Pick the most frequent cwd
  let best = folderDerivedPath;
  let bestCount = 0;
  for (const [cwd, count] of cwdCounts) {
    if (count > bestCount) {
      best = cwd;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Get the effective mtime for a session — for new-format sessions with subagents,
 * use the newest subagent file's mtime instead of the stub's mtime.
 */
export function getSessionMtime(sessionPath: string): number {
  const subagentPaths = getSubagentPaths(sessionPath);
  if (subagentPaths.length === 0) {
    return statSync(sessionPath).mtimeMs;
  }
  let maxMtime = statSync(sessionPath).mtimeMs;
  for (const p of subagentPaths) {
    try {
      const m = statSync(p).mtimeMs;
      if (m > maxMtime) maxMtime = m;
    } catch { /* skip */ }
  }
  return maxMtime;
}

export async function parseSessionFile(
  sessionPath: string,
  maxMessages = 50
): Promise<SessionContent> {
  const sessionId = basename(sessionPath, '.jsonl');
  const content: SessionContent = {
    sessionId,
    sessionPath,
    summaries: [],
    userMessages: [],
    assistantMessages: [],
    toolResults: [],
    toolsUsed: new Set(),
    firstPrompt: '',
    metadata: {
      toolsUsed: [],
      gitBranch: '',
      slug: '',
      durationMs: 0,
      lastStopReason: '',
      filesModified: [],
      modelsUsed: [],
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      peakContextTokens: 0,
      messageCount: 0,
    },
  };

  const modelsUsed = new Set<string>();
  const filesModified = new Set<string>();
  
  if (!existsSync(sessionPath)) {
    return content;
  }

  // New-format sessions store content in subagents/ dir, not in the stub .jsonl
  const filesToParse = hasSubagentsDir(sessionPath)
    ? getSubagentPaths(sessionPath)
    : [sessionPath];

  let userCount = 0;
  let assistantCount = 0;
  let toolCount = 0;
  let lineNum = 0;

  for (const filePath of filesToParse) {
  const fileStream = createReadStream(filePath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;
    
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    
    try {
      const msgType = obj.type as string;
      
      // --- Metadata extraction (single-pass, all entry types) ---
      // Git branch + slug from first user entry
      if (!content.metadata.gitBranch && obj.gitBranch) {
        content.metadata.gitBranch = obj.gitBranch as string;
      }
      if (!content.metadata.slug && obj.slug) {
        content.metadata.slug = obj.slug as string;
      }

      // Duration from system entries
      if (msgType === 'system' && (obj.subtype as string) === 'turn_duration' && obj.durationMs) {
        content.metadata.durationMs += obj.durationMs as number;
      }

      // Files modified from file-history-snapshot entries
      if (msgType === 'file-history-snapshot') {
        const snapshot = obj.snapshot as Record<string, unknown>;
        if (snapshot && typeof snapshot === 'object') {
          const backups = snapshot.trackedFileBackups as Record<string, unknown>;
          if (backups && typeof backups === 'object') {
            for (const filePath of Object.keys(backups)) {
              filesModified.add(filePath);
            }
          }
        }
      }

      if (msgType === 'summary') {
        const summary = obj.summary as string;
        if (summary) {
          content.summaries.push(summary);
        }
      } else if (msgType === 'user') {
        if (userCount >= maxMessages) continue;
        
        const msg = obj.message as Record<string, unknown>;
        let text = '';
        
        if (msg && typeof msg === 'object') {
          const msgContent = msg.content;
          
          if (typeof msgContent === 'string') {
            text = msgContent;
          } else if (Array.isArray(msgContent)) {
            const textParts: string[] = [];
            
            for (const item of msgContent) {
              if (typeof item === 'object' && item !== null) {
                const itemObj = item as Record<string, unknown>;
                if (itemObj.type === 'text') {
                  textParts.push(itemObj.text as string || '');
                } else if (itemObj.type === 'tool_result') {
                  const result = itemObj.content as string;
                  if (typeof result === 'string' && isValuableToolResult(result) && toolCount < maxMessages) {
                    content.toolResults.push({
                      text: result.slice(0, 2000),
                      lineNumber: lineNum,
                      contentType: 'tool_result',
                    });
                    toolCount++;
                  }
                }
              }
            }
            text = textParts.join('\n');
          }
        }
        
        // Skip system reminders, sidechain-injected task prompts, and very short messages
        if (text && !text.includes('<system-reminder>') && text.trim().length > 10) {
          content.userMessages.push({
            text,
            lineNumber: lineNum,
            contentType: 'user',
          });
          userCount++;
          
          // Capture first prompt
          if (!content.firstPrompt) {
            content.firstPrompt = text.slice(0, 1000);
          }
        }
      } else if (msgType === 'assistant') {
        const msg = obj.message as Record<string, unknown>;
        if (!msg || typeof msg !== 'object') continue;

        // Extract model
        if (msg.model && typeof msg.model === 'string') {
          modelsUsed.add(msg.model);
        }
        // Extract stop reason (keep last)
        if (msg.stop_reason && typeof msg.stop_reason === 'string') {
          content.metadata.lastStopReason = msg.stop_reason;
        }
        // Extract token usage
        const usage = msg.usage as Record<string, unknown>;
        if (usage && typeof usage === 'object') {
          const inputTok = (usage.input_tokens as number) || 0;
          const cacheRead = (usage.cache_read_input_tokens as number) || 0;
          const cacheCreate = (usage.cache_creation_input_tokens as number) || 0;
          const outputTok = (usage.output_tokens as number) || 0;
          // input_tokens is only non-cached; full context = input + cache_read + cache_creation
          const totalContext = inputTok + cacheRead + cacheCreate;
          content.metadata.inputTokens += totalContext;
          content.metadata.outputTokens += outputTok;
          content.metadata.cacheReadTokens += cacheRead;
          content.metadata.cacheCreationTokens += cacheCreate;
          if (totalContext > content.metadata.peakContextTokens) {
            content.metadata.peakContextTokens = totalContext;
          }
        }

        if (assistantCount >= maxMessages) continue;
        const msgContent = msg.content;
        
        if (Array.isArray(msgContent)) {
          for (const item of msgContent) {
            if (typeof item !== 'object' || item === null) continue;
            const itemObj = item as Record<string, unknown>;
            const itemType = itemObj.type as string;
            
            if (itemType === 'text') {
              const text = itemObj.text as string;
              if (text && typeof text === 'string') {
                const keyText = extractKeyText(text);
                if (keyText && keyText.length > 50) {
                  content.assistantMessages.push({
                    text: keyText,
                    lineNumber: lineNum,
                    contentType: 'assistant',
                  });
                  assistantCount++;
                }
                break;
              }
            } else if (itemType === 'tool_use') {
              const toolName = itemObj.name as string;
              if (toolName) {
                content.toolsUsed.add(toolName);
              }
            }
          }
        } else if (typeof msgContent === 'string') {
          const keyText = extractKeyText(msgContent);
          if (keyText && keyText.length > 50) {
            content.assistantMessages.push({
              text: keyText,
              lineNumber: lineNum,
              contentType: 'assistant',
            });
            assistantCount++;
          }
        }
      }
      
      // Also check for toolUseResult (web search results, etc.)
      const toolResult = obj.toolUseResult as Record<string, unknown>;
      if (toolResult && typeof toolResult === 'object' && toolCount < maxMessages) {
        const resultText = toolResult.result as string;
        const query = toolResult.query as string;
        
        if (resultText && typeof resultText === 'string' && isValuableToolResult(resultText, 'WebSearch')) {
          const searchText = query ? `Search: ${query}\n${resultText}` : resultText;
          content.toolResults.push({
            text: searchText.slice(0, 2000),
            lineNumber: lineNum,
            contentType: 'web_search',
          });
          toolCount++;
        }
      }
    } catch {
      // Skip malformed messages
      continue;
    }
  }
  } // end for (const filePath of filesToParse)

  // Finalize metadata collections
  content.metadata.toolsUsed = [...content.toolsUsed];
  content.metadata.modelsUsed = [...modelsUsed];
  content.metadata.filesModified = [...filesModified];
  content.metadata.messageCount = content.userMessages.length + content.assistantMessages.length;

  return content;
}

/**
 * Decode a Claude Code project directory name back to a real filesystem path.
 *
 * Claude Code encodes paths by replacing '/' with '-', but this is lossy:
 * both path separators and hyphens/underscores in folder names become '-'.
 * e.g., /home/user/code/personal/k8s_gpu → -home-user-code-personal-k8s-gpu
 *
 * Strategy: split on '-', then greedily join segments checking which path exists.
 */
function decodeDirName(dirName: string): string {
  // Remove leading '-' and split into segments
  const segments = dirName.replace(/^-/, '').split('-');

  // Greedily build path by checking filesystem
  let currentPath = '/';
  let i = 0;

  while (i < segments.length) {
    // Try joining progressively more segments with hyphens/underscores
    let matched = false;

    // Try single segment first (most common case: /home, /adi, /code, etc.)
    const singleCandidate = join(currentPath, segments[i]);
    if (existsSync(singleCandidate)) {
      currentPath = singleCandidate;
      i++;
      matched = true;
      continue;
    }

    // Try joining 2, 3, ... segments with common separators (-, _)
    for (let len = 2; len <= segments.length - i; len++) {
      const joinedSegments = segments.slice(i, i + len);

      for (const sep of ['-', '_', '.']) {
        const candidate = join(currentPath, joinedSegments.join(sep));
        if (existsSync(candidate)) {
          currentPath = candidate;
          i += len;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }

    if (!matched) {
      // No match found — just use '/' like the naive approach
      currentPath = join(currentPath, segments[i]);
      i++;
    }
  }

  return currentPath;
}

/**
 * Get all sessions across one or more Claude directories.
 * @param claudeDir - Single projects dir path, OR undefined to auto-discover all Claude dirs
 */
export function* getAllSessions(claudeDir?: string): Generator<[SessionEntry, string]> {
  const seenSessionIds = new Set<string>();

  // Determine which project directories to scan
  const projectDirs: string[] = [];
  if (claudeDir) {
    projectDirs.push(claudeDir);
  } else {
    // Auto-discover all Claude directories (~/.claude, ~/.claude-work, etc.)
    const home = homedir();
    const addDir = (d: string) => {
      const p = join(d, 'projects');
      if (existsSync(p) && !projectDirs.includes(p)) projectDirs.push(p);
    };

    // Standard
    addDir(join(home, '.claude'));

    // Discover ~/.claude-* profiles
    try {
      for (const entry of readdirSync(home, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('.claude-') && entry.name !== '.claude-code') {
          addDir(join(home, entry.name));
        }
      }
    } catch {}

    // CLAUDE_DIRS env var override
    if (process.env.CLAUDE_DIRS) {
      for (const d of process.env.CLAUDE_DIRS.split(',')) {
        const trimmed = d.trim();
        if (trimmed) addDir(trimmed.startsWith('~/') ? join(home, trimmed.slice(2)) : trimmed);
      }
    }

    if (projectDirs.length === 0) {
      projectDirs.push(join(home, '.claude', 'projects'));
    }
  }

  for (const dir of projectDirs) {
    // Yield sessions from sessions-index.json files
    for (const [, entries] of iterAllSessionIndices(dir)) {
      for (const entry of entries) {
        if (!seenSessionIds.has(entry.sessionId) && existsSync(entry.fullPath)) {
          seenSessionIds.add(entry.sessionId);
          yield [entry, entry.fullPath];
        }
      }
    }

    // Scan for .jsonl files not in any index
    if (!existsSync(dir)) continue;

    const dirEntries = readdirSync(dir, { withFileTypes: true });

    for (const projDirEntry of dirEntries) {
      if (!projDirEntry.isDirectory()) continue;

      const projectPath = join(dir, projDirEntry.name);
      const files = readdirSync(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        if (file.startsWith('agent-')) continue;
        if (file === 'sessions-index.json') continue;

        const sessionId = basename(file, '.jsonl');
        if (seenSessionIds.has(sessionId)) continue;

        const fullPath = join(projectPath, file);

        try {
          const stat = statSync(fullPath);
          const derivedProjectPath = decodeDirName(projDirEntry.name);
          // For new-format sessions, use the newest subagent file's mtime so
          // the indexer detects updates even when the stub hasn't changed.
          const effectiveMtime = getSessionMtime(fullPath);
          // For new-format sessions, derive project path from where subagents
          // actually did their work (most common cwd), not where the session was launched.
          const projectPath = hasSubagentsDir(fullPath)
            ? getSubagentProjectPath(fullPath, derivedProjectPath)
            : derivedProjectPath;

          const entry: SessionEntry = {
            sessionId,
            fullPath,
            fileMtime: effectiveMtime,
            firstPrompt: '',
            messageCount: 0,
            created: stat.birthtime.toISOString(),
            modified: new Date(effectiveMtime).toISOString(),
            gitBranch: '',
            projectPath,
            isSidechain: false,
          };

          seenSessionIds.add(sessionId);
          yield [entry, fullPath];
        } catch {
          continue;
        }
      }
    }
  }
}
