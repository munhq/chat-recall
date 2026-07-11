/**
 * Claude Code transcript parser — JSONL sessions + co-located subagents.
 * Ported verbatim from the server's services/parser.ts (the full-fidelity
 * parser) as part of the one-parser architecture reset.
 */
import { open, readdir, readFile, stat } from 'fs/promises';
import { dirname, join, basename } from 'path';
import type { TranscriptMessage as Message, Subagent, ToolCall } from './types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('transcript-claude');

// Client banners Claude Code prepends to user messages on session boundaries.
// Strip them from parsed messages so they don't render as part of the prompt.
const INJECTED_BANNERS: RegExp[] = [
  /MCP issues detected\. ?Run \/mcp list for status\.?/g,
  /Context low[^\n]*Run \/compact[^\n]*/g,
  /API Error:[^\n]{0,120}/g,
  // Slash-command / local-command plumbing Claude Code logs as `user` turns:
  // the caveat banner, the `/command` invocation record, and its stdout. These
  // are UI/tooling noise, not conversation — strip them so a message that is
  // ONLY this plumbing collapses to empty and is dropped (see the user branch).
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  // ANSI SGR escapes that leak into logged stdout (e.g. "[1mSonnet 5[22m").
  // eslint-disable-next-line no-control-regex
  /\[[0-9;]*m/g,
];
function stripBanners(text: string): string {
  let out = text;
  for (const re of INJECTED_BANNERS) out = out.replace(re, ' ');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

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
export async function parseClaudeTranscript(sessionPath: string): Promise<Message[]> {
  return parseMessagesFromFile(sessionPath);
}

/** Same parse over in-memory text — what the server runs on archived raw. */
export function parseClaudeTranscriptText(text: string): Message[] {
  const raw: Array<{ line: number; obj: any }> = [];
  let lineNumber = 0;
  for (const line of text.split('\n')) {
    lineNumber++;
    if (!line.trim()) continue;
    try { raw.push({ line: lineNumber, obj: JSON.parse(line) }); } catch { /* malformed line */ }
  }
  return messagesFromRawLines(raw);
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
      } catch {
        // A live transcript's last line is routinely half-written — skipping
        // it is normal operation, not an error. A stack trace here lands in a
        // brand-new user's face on their first sync. Keep a quiet breadcrumb.
        log.debug({ line: lineNumber, file: sessionPath }, 'skipped malformed transcript line');
      }
    }
  } finally {
    await file.close();
  }
  return messagesFromRawLines(raw);
}

function messagesFromRawLines(raw: Array<{ line: number; obj: any }>): Message[] {

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
      const cleaned = stripBanners(text);
      if (!cleaned) continue; // was ONLY banners / local-command plumbing → drop it
      messages.push({ line, role: 'user', content: cleaned, timestamp });
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
    } else if (obj.type === 'system' && obj.subtype === 'away_summary') {
      // "away_summary" is a handoff/checkpoint record Claude Code writes
      // when it captures a session's goal without persisting the turns
      // (the conversation continued elsewhere). Some sessions consist of
      // ONLY this record — without surfacing it the viewer shows an empty
      // "No messages found". Content may be a plain string or text blocks.
      const c = obj.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
          : '';
      if (text.trim()) messages.push({ line, role: 'summary', content: stripBanners(text), timestamp });
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
export async function parseClaudeSubagents(sessionPath: string): Promise<Subagent[]> {
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
      log.error({ err: e, filePath }, 'Failed to parse subagent');
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

