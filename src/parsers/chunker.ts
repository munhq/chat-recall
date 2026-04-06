/**
 * Smart chunking for Claude Code sessions.
 *
 * Strategy:
 * 1. Primary: Use existing Claude summaries (best signal)
 * 2. Secondary: First user prompt (captures intent)
 * 3. Tertiary: User messages combined (for context)
 * 4. Quaternary: Assistant key responses (what was discovered/explained)
 * 5. Quinary: Tool results and web searches (valuable context)
 */

import type { SessionEntry, SessionContent } from './session.js';

export interface SessionChunk {
  chunkId: string; // session_id + chunk_type + index
  sessionId: string;
  chunkType: 'summary' | 'first_prompt' | 'user_context' | 'assistant' | 'tool_result' | 'web_search';
  text: string;
  
  // Metadata from session entry
  projectPath: string;
  created: string;
  modified: string;
  mtime: number;
  firstPrompt: string; // Always include for display
  
  // Source reference for retrieval
  sourceFile: string;  // Path to session JSONL
  sourceLine: number;  // Line number in file (0 = not applicable)
}

function cleanText(text: string): string {
  // Remove system reminder tags
  let result = text.replace(/<system-reminder>.*?<\/system-reminder>/gs, '');
  
  // Remove ANSI escape codes
  result = result.replace(/\x1b\[[0-9;]*m/g, '');
  
  // Normalize whitespace
  result = result.replace(/\s+/g, ' ');
  
  return result.trim();
}

export function chunkSession(
  entry: SessionEntry,
  content: SessionContent,
  maxChunks = 8,
  maxTokensPerChunk = 500
): SessionChunk[] {
  const chunks: SessionChunk[] = [];
  
  // Estimate ~4 chars per token
  const maxChars = maxTokensPerChunk * 4;
  
  // Common metadata
  const baseData = {
    sessionId: entry.sessionId,
    projectPath: entry.projectPath,
    created: entry.created,
    modified: entry.modified,
    mtime: entry.fileMtime,
    firstPrompt: entry.firstPrompt || content.firstPrompt,
    sourceFile: content.sessionPath,
  };
  
  // 1. Summary chunks (highest priority)
  for (let i = 0; i < Math.min(2, content.summaries.length); i++) {
    const summary = content.summaries[i];
    if (!summary?.trim()) continue;
    
    const chunkText = cleanText(summary.slice(0, maxChars));
    if (chunkText.length > 8000) {
      chunks.push({
        chunkId: `${entry.sessionId}_summary_${i}`,
        chunkType: 'summary',
        text: chunkText.slice(0, 8000),
        sourceLine: 0,
        ...baseData,
      });
    } else {
      chunks.push({
        chunkId: `${entry.sessionId}_summary_${i}`,
        chunkType: 'summary',
        text: chunkText,
        sourceLine: 0,
        ...baseData,
      });
    }
  }
  
  if (chunks.length >= maxChunks) {
    return chunks.slice(0, maxChunks);
  }
  
  // 2. First prompt chunk
  const firstPrompt = entry.firstPrompt || content.firstPrompt;
  if (firstPrompt?.trim()) {
    const firstLine = content.userMessages[0]?.lineNumber || 0;
    
    chunks.push({
      chunkId: `${entry.sessionId}_first_prompt`,
      chunkType: 'first_prompt',
      text: cleanText(firstPrompt.slice(0, maxChars)),
      sourceLine: firstLine,
      ...baseData,
    });
  }
  
  if (chunks.length >= maxChunks) {
    return chunks.slice(0, maxChunks);
  }
  
  // 3. Combined user messages for context
  if (content.userMessages.length > 0) {
    const messagesToUse = firstPrompt
      ? content.userMessages.slice(1, 6)
      : content.userMessages.slice(0, 5);
    
    if (messagesToUse.length > 0) {
      const combined = messagesToUse.map(msg => msg.text.slice(0, 500)).join('\n\n');
      if (combined.trim()) {
        chunks.push({
          chunkId: `${entry.sessionId}_user_context`,
          chunkType: 'user_context',
          text: cleanText(combined.slice(0, maxChars)),
          sourceLine: messagesToUse[0].lineNumber,
          ...baseData,
        });
      }
    }
  }
  
  if (chunks.length >= maxChunks) {
    return chunks.slice(0, maxChunks);
  }
  
  // 4. Assistant key responses (what Claude discovered/explained)
  for (let i = 0; i < Math.min(3, content.assistantMessages.length); i++) {
    if (chunks.length >= maxChunks) break;
    
    const msg = content.assistantMessages[i];
    if (msg.text.trim() && msg.text.length > 50) {
      chunks.push({
        chunkId: `${entry.sessionId}_assistant_${i}`,
        chunkType: 'assistant',
        text: cleanText(msg.text.slice(0, maxChars)),
        sourceLine: msg.lineNumber,
        ...baseData,
      });
    }
  }
  
  if (chunks.length >= maxChunks) {
    return chunks.slice(0, maxChunks);
  }
  
  // 5. Tool results (web searches are especially valuable)
  if (content.toolResults.length > 0) {
    const webSearches = content.toolResults.filter(r => r.contentType === 'web_search');
    const otherResults = content.toolResults.filter(r => r.contentType !== 'web_search');
    
    const resultsToProcess = [...webSearches.slice(0, 2), ...otherResults.slice(0, 1)];
    
    for (let i = 0; i < resultsToProcess.length; i++) {
      if (chunks.length >= maxChunks) break;
      
      const result = resultsToProcess[i];
      if (result.text.trim()) {
        chunks.push({
          chunkId: `${entry.sessionId}_${result.contentType}_${i}`,
          chunkType: result.contentType as SessionChunk['chunkType'],
          text: cleanText(result.text.slice(0, maxChars)),
          sourceLine: result.lineNumber,
          ...baseData,
        });
      }
    }
  }
  
  return chunks.slice(0, maxChunks);
}
