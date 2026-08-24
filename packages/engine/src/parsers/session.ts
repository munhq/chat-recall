/**
 * Session parser for Claude Code JSONL files.
 */

import { createReadStream, existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join, basename } from 'path';
import { stripInjectedBanners } from './chunker.js';
import { claudeBackend as CLAUDE } from '../core/backends/claude.js';
import { claudeProjectDirs } from '../core/tool-paths.js';
import { estimateCostUsd, METADATA_VERSION } from '../core/model-pricing.js';

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
  /** Estimated USD cost — `model-pricing.ts` × token totals.
   *  Populated when at least one model in `modelsUsed` is in the pricing
   *  table; unknown models contribute $0 (signal vs noise: clearer than
   *  guessing). */
  costUsd: number;
  /** Bumped when the parser learns to extract a new field. The store's
   *  needsUpdate() compares this with `extra.metadataVersion` so the
   *  auto-indexer re-parses sessions automatically after an upgrade.
   *  See `src/core/model-pricing.ts:METADATA_VERSION`. */
  metadataVersion: number;
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
  const dir = claudeDir || CLAUDE.projectsDir();
  
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
 * Read the first `cwd` field from a session JSONL. Used as a tiebreaker
 * when the dir-name decoder produces a path that doesn't exist on disk
 * (real-dash and dot-prefix folder names like `.claude-pr-bot` or
 * `acme-infrastructure-393` get mangled by the naive `-` → `/` decode).
 *
 * Reads at most ~30 lines — the cwd is set on every user/attachment
 * event so we hit it almost immediately. Returns empty string when no
 * cwd is found (e.g. very short or malformed transcripts).
 */
export function readCwdFromJsonl(sessionPath: string): string {
  try {
    if (!existsSync(sessionPath)) return '';
    // Head-bounded read: transcripts run into the hundreds of MB and this
    // only ever inspects the first ~50 lines — never load the whole file.
    let text: string;
    const fd = openSync(sessionPath, 'r');
    try {
      const buf = Buffer.alloc(262144);
      const n = readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString('utf-8', 0, n);
    } finally { closeSync(fd); }
    const lines = text.split('\n', 50);
    for (const line of lines) {
      if (!line || !line.includes('"cwd"')) continue;
      try {
        const obj = JSON.parse(line) as { cwd?: unknown };
        if (typeof obj.cwd === 'string' && obj.cwd) return obj.cwd;
      } catch { /* skip malformed */ }
    }
  } catch { /* file unreadable — give up */ }
  return '';
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
      costUsd: 0,
      metadataVersion: METADATA_VERSION,
    },
  };

  const modelsUsed = new Set<string>();
  const filesModified = new Set<string>();
  
  if (!existsSync(sessionPath)) {
    return content;
  }

  // Sessions that spawned sub-agents have a subagents/ dir. The main .jsonl
  // may be a tiny stub (rare /explore-style sessions) OR the full primary
  // thread (the common case — Agent/Task tool use, where the main holds all
  // the Edit/Write/Bash work and subagents hold only the spawned agents').
  // Parse BOTH: the main carries the primary thread, subagents carry theirs.
  // They are disjoint transcripts, so there is no double-counting; a stub
  // main just contributes its handful of lines.
  const filesToParse = hasSubagentsDir(sessionPath)
    ? [sessionPath, ...getSubagentPaths(sessionPath)]
    : [sessionPath];

  let userCount = 0;
  /** Text of every prompt already recorded. Used ONLY to stop a QUEUED record
   *  from double-counting a prompt that also landed as a user record — never to
   *  collapse two genuine user turns. */
  const seenPrompts = new Set<string>();
  /**
   * Record one typed prompt.
   *
   * Shared by the `user` records and the `queue-operation` records, because a
   * prompt typed WHILE A TOOL RUNS is stored by Claude Code as
   * `{type:'queue-operation', operation:'enqueue', content}` and never as a
   * `user` record. Reading only `user` records dropped every such prompt — 12 of
   * 61 in one measured session, and they are the interruptions and corrections,
   * the highest-signal turns in the conversation.
   */
  const recordPrompt = (raw: string, line: number, dedupe = false): void => {
    if (userCount >= maxMessages) return;
    // A system reminder is APPENDED to a real prompt, so drop the block and keep
    // the words. Discarding the whole record loses the prompt with it.
    const withoutReminders = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
    if (!withoutReminders.trim() || withoutReminders.trim().length <= 10) return;
    const cleanedText = stripInjectedBanners(withoutReminders).trim();
    if (cleanedText.length < 10) return;
    // Deduplicate the QUEUED path only. Repeating yourself is normal ("continue",
    // "yes", "go on"), and this parser runs for every tool's transcript, so an
    // unconditional dedupe would quietly delete real repeated turns everywhere.
    if (dedupe && seenPrompts.has(cleanedText)) return;
    seenPrompts.add(cleanedText);
    content.userMessages.push({ text: cleanedText, lineNumber: line, contentType: 'user' });
    userCount++;
    if (!content.firstPrompt) content.firstPrompt = cleanedText.slice(0, 1000);
  };
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
        
        if (text) recordPrompt(text, lineNum);
      } else if (msgType === 'queue-operation') {
        // 'enqueue' carries the text; 'remove' is the dequeue half and repeats it.
        if (obj.operation === 'enqueue' && typeof obj.content === 'string') {
          recordPrompt(obj.content, lineNum, true);
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
  content.metadata.costUsd = estimateCostUsd(content.metadata.modelsUsed, {
    inputTokens: content.metadata.inputTokens,
    outputTokens: content.metadata.outputTokens,
    cacheReadTokens: content.metadata.cacheReadTokens,
    cacheCreationTokens: content.metadata.cacheCreationTokens,
  });

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

    // Try single segment first (most common case: /home, /user, /code, etc.)
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

  // Project dirs to scan: an explicit override, else the shared, config-driven
  // discovery (claudeProjectDirs — also used by the Claude backend's
  // listSessions and findSessionFile, so index/sync/lookup stay consistent).
  const projectDirs: string[] = claudeDir ? [claudeDir] : claudeProjectDirs();

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
          // Path resolution priority — JSONL cwd is ground truth and
          // ALWAYS wins when present. Claude's dir-name encoding is
          // lossy by design (every `-` becomes `/`, so paths containing
          // real hyphens or starting with `.` — `.claude-pr-bot`,
          // `acme-infrastructure-393`, `my-project` — get mangled).
          //
          //   1. Subagent cwd majority (new-format only).
          //   2. JSONL's first `cwd` event (ground truth from the tool).
          //   3. Decoded dir name (last-resort heuristic when JSONL is
          //      empty or malformed).
          let projectPath = '';
          if (hasSubagentsDir(fullPath)) {
            projectPath = getSubagentProjectPath(fullPath, derivedProjectPath);
          } else {
            const fromJsonl = readCwdFromJsonl(fullPath);
            if (fromJsonl) projectPath = fromJsonl;
          }
          if (!projectPath) projectPath = derivedProjectPath;

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
