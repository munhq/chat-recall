/**
 * Context extraction for conversation continuation.
 * 
 * Provides structured summaries of past conversations:
 * - User inputs/questions
 * - Claude's work/decisions
 * - Outcomes/achievements
 */

import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';

import { resumeCommandFor } from './resume-command.js';
import { listAvailableBackends } from './tool-backend.js';
import './backends/index.js'; // side-effect: registers backends
import type { AiTool } from './tool-backend.js';

export interface ConversationContext {
  sessionId: string;
  projectPath: string;
  created: string;
  modified: string;
  
  // Structured content
  userInputs: string[];        // What the user asked/requested
  claudeWork: string[];        // What Claude did/suggested
  decisions: string[];         // Key decisions made
  toolsUsed: string[];         // Tools/commands used
  filesChanged: string[];      // Files that were modified
  summary?: string;            // Claude-generated summary if available
}

export interface RecentSession {
  sessionId: string;
  projectPath: string;
  projectDir: string;
  fullPath: string;
  created: string;
  modified: string;
  mtime: number;
  firstPrompt: string;
  messageCount: number;
  tool?: AiTool;
}

/**
 * Get recent sessions across every registered AI-tool backend, sorted by
 * modification time descending.
 *
 * The function fans out to `backend.listSessions()` for every available
 * backend — Claude, Gemini, OpenCode, Codex — and unions the results.
 * Adding a fifth tool is zero changes here: register a new ToolBackend
 * and it shows up automatically.
 */
export function getRecentSessions(
  projectFilter?: string,
  limit = 10,
): RecentSession[] {
  const sessions: RecentSession[] = [];

  for (const backend of listAvailableBackends()) {
    let refs;
    try { refs = backend.listSessions({ projectFilter }); }
    catch { continue; }

    for (const ref of refs) {
      sessions.push({
        sessionId: ref.prefixedId,
        projectPath: ref.projectPath,
        projectDir: ref.projectDir,
        fullPath: ref.fullPath,
        created: ref.created,
        modified: ref.modified,
        mtime: ref.mtime,
        firstPrompt: ref.firstPrompt,
        messageCount: ref.messageCount,
        tool: ref.toolId,
      });
    }
  }

  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions.slice(0, limit);
}

/**
 * Extract structured context from a session file.
 */
export function extractConversationContext(sessionPath: string): ConversationContext {
  const sessionId = basename(sessionPath, '.jsonl');
  
  const context: ConversationContext = {
    sessionId,
    projectPath: '',
    created: '',
    modified: '',
    userInputs: [],
    claudeWork: [],
    decisions: [],
    toolsUsed: [],
    filesChanged: [],
  };
  
  if (!existsSync(sessionPath)) {
    return context;
  }
  
  const lines = readFileSync(sessionPath, 'utf-8').split('\n');
  const toolsSet = new Set<string>();
  const filesSet = new Set<string>();
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const msgType = obj.type as string;
      
      // Extract summary
      if (msgType === 'summary') {
        const summary = obj.summary as string;
        if (summary) {
          context.summary = summary;
        }
      }
      
      // Extract user inputs
      if (msgType === 'user') {
        const msg = obj.message as Record<string, unknown>;
        if (msg && typeof msg === 'object') {
          const content = msg.content;
          let text = '';
          
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            for (const item of content) {
              if (typeof item === 'object' && item !== null) {
                const itemObj = item as Record<string, unknown>;
                if (itemObj.type === 'text') {
                  text = itemObj.text as string || '';
                  break;
                }
              }
            }
          }
          
          // Skip system reminders and tool results
          if (text && !text.includes('<system-reminder>') && !text.includes('tool_result')) {
            // Clean and truncate
            text = text.replace(/\n+/g, ' ').trim();
            if (text.length > 200) {
              text = text.slice(0, 200) + '...';
            }
            if (text.length > 10) {
              context.userInputs.push(text);
            }
          }
        }
      }
      
      // Extract Claude's work and decisions
      if (msgType === 'assistant') {
        const msg = obj.message as Record<string, unknown>;
        if (msg && typeof msg === 'object') {
          const content = msg.content;
          
          if (Array.isArray(content)) {
            for (const item of content) {
              if (typeof item !== 'object' || item === null) continue;
              const itemObj = item as Record<string, unknown>;
              
              // Extract tool uses
              if (itemObj.type === 'tool_use') {
                const toolName = itemObj.name as string;
                if (toolName) {
                  toolsSet.add(toolName);
                  
                  // Extract file paths from tool inputs
                  const input = itemObj.input as Record<string, unknown>;
                  if (input) {
                    const filePath = input.file_path || input.path || input.file;
                    if (typeof filePath === 'string' && filePath.includes('/')) {
                      filesSet.add(filePath);
                    }
                  }
                }
              }
              
              // Extract text responses (Claude's explanations/decisions)
              if (itemObj.type === 'text') {
                const text = itemObj.text as string;
                if (text && typeof text === 'string') {
                  // Look for decision indicators
                  const decisionPatterns = [
                    /(?:I'll|I will|Let me|Going to|We should|The solution is|The fix is|This means|In conclusion|To summarize|Key point|Decision:|Conclusion:)[^.!?]*[.!?]/gi,
                    /(?:Fixed|Implemented|Created|Updated|Added|Removed|Changed|Resolved)[^.!?]*[.!?]/gi,
                  ];
                  
                  for (const pattern of decisionPatterns) {
                    const matches = text.match(pattern);
                    if (matches) {
                      for (const match of matches.slice(0, 3)) {
                        const cleaned = match.replace(/\n/g, ' ').trim();
                        if (cleaned.length > 20 && cleaned.length < 300) {
                          if (!context.claudeWork.includes(cleaned)) {
                            context.claudeWork.push(cleaned);
                          }
                        }
                      }
                    }
                  }
                  
                  // Look for explicit decisions/conclusions
                  if (text.includes('##') || text.includes('**')) {
                    const headings = text.match(/(?:#{1,3}|^\*\*)[^#*\n]+/gm);
                    if (headings) {
                      for (const heading of headings.slice(0, 5)) {
                        const cleaned = heading.replace(/[#*]/g, '').trim();
                        if (cleaned.length > 5 && cleaned.length < 100) {
                          if (!context.decisions.includes(cleaned)) {
                            context.decisions.push(cleaned);
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }
  
  context.toolsUsed = Array.from(toolsSet);
  context.filesChanged = Array.from(filesSet).slice(0, 20);
  
  // Limit arrays
  context.userInputs = context.userInputs.slice(0, 15);
  context.claudeWork = context.claudeWork.slice(0, 10);
  context.decisions = context.decisions.slice(0, 10);
  
  return context;
}

/**
 * Format context for display.
 */
export function formatContext(context: ConversationContext): string {
  const lines: string[] = [];
  
  lines.push(`# Session: ${context.sessionId}`);
  lines.push('');
  
  if (context.summary) {
    lines.push('## Summary');
    lines.push(context.summary);
    lines.push('');
  }
  
  if (context.userInputs.length > 0) {
    lines.push('## Your Requests');
    for (const input of context.userInputs) {
      lines.push(`- ${input}`);
    }
    lines.push('');
  }
  
  if (context.decisions.length > 0) {
    lines.push('## Key Topics/Decisions');
    for (const decision of context.decisions) {
      lines.push(`- ${decision}`);
    }
    lines.push('');
  }
  
  if (context.claudeWork.length > 0) {
    lines.push('## Work Done');
    for (const work of context.claudeWork) {
      lines.push(`- ${work}`);
    }
    lines.push('');
  }
  
  if (context.toolsUsed.length > 0) {
    lines.push('## Tools Used');
    lines.push(context.toolsUsed.join(', '));
    lines.push('');
  }
  
  if (context.filesChanged.length > 0) {
    lines.push('## Files Touched');
    for (const file of context.filesChanged.slice(0, 10)) {
      lines.push(`- ${file}`);
    }
    lines.push('');
  }
  
  // Not every tool resumes by id, and none of the prefixed ones take
  // `claude --resume`. resumeCommandFor() owns that mapping.
  const resume = resumeCommandFor(context.sessionId);
  if (resume) lines.push(`**Resume:** \`${resume}\``);
  
  return lines.join('\n');
}
