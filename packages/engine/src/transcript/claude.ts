/**
 * Claude Code transcript parser — JSONL sessions + co-located subagents.
 * Ported verbatim from the server's services/parser.ts (the full-fidelity
 * parser) as part of the one-parser architecture reset.
 */
import { open, readdir, readFile, stat } from 'fs/promises';
import { dirname, join, basename } from 'path';
import type { TranscriptMessage as Message, Subagent, ToolCall } from './types.js';
import { createLogger } from '../core/logger.js';
import { queuedCommandPrompt, userRecordOrigin } from '../core/claude-prompt-origin.js';
import { capPayload } from './trim.js';

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
export interface ClaudeParseOptions {
  /** Cut each tool input, tool result and thinking body to this many characters
   *  as its line is read. The parse then holds the cut transcript and never the
   *  full payloads, so its memory follows the size of the output and not the
   *  size of the file. */
  payloadCap?: number;
  /** The cut to apply to each payload. It wins over `payloadCap` and carries the budget of a whole session. */
  cut?: (v: unknown) => unknown;
  /** The cut to apply to the text of each message. */
  cutText?: (v: unknown) => unknown;
}

export async function parseClaudeTranscript(sessionPath: string, opts: ClaudeParseOptions = {}): Promise<Message[]> {
  return parseMessagesFromFile(sessionPath, opts);
}

/** Same parse over in-memory text — what the server runs on archived raw. */
export function parseClaudeTranscriptText(text: string, opts: ClaudeParseOptions = {}): Message[] {
  const builder = new MessageBuilder(opts.payloadCap, opts.cut, opts.cutText);
  let lineNumber = 0;
  for (const line of text.split('\n')) {
    lineNumber++;
    if (!line.trim()) continue;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; /* malformed line */ }
    builder.add(lineNumber, obj);
  }
  return builder.messages;
}

async function parseMessagesFromFile(sessionPath: string, opts: ClaudeParseOptions): Promise<Message[]> {
  const file = await open(sessionPath);
  const builder = new MessageBuilder(opts.payloadCap, opts.cut, opts.cutText);
  try {
    let lineNumber = 0;
    for await (const line of file.readLines()) {
      lineNumber++;
      if (!line.trim()) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        // A live transcript's last line is routinely half-written — skipping
        // it is normal operation, not an error. A stack trace here lands in a
        // brand-new user's face on their first sync. Keep a quiet breadcrumb.
        log.debug({ line: lineNumber, file: sessionPath }, 'skipped malformed transcript line');
        continue;
      }
      builder.add(lineNumber, obj);
    }
  } finally {
    await file.close();
  }
  return builder.messages;
}

/**
 * Turns the records of one transcript file into messages, one record at a time.
 *
 * Claude Code stores a tool_result inside the user record that follows the
 * assistant's tool_use, so a call and its result are in two records. This keeps
 * the calls by tool_use id and gives each its result when the result record
 * comes, in either order, and the last result for an id wins. Nothing but the
 * messages, the calls and the results is kept, so a record's body is released
 * as soon as the next record is read.
 */
class MessageBuilder {
  readonly messages: Message[] = [];
  private readonly cap: (v: unknown) => unknown;
  /** The calls of each tool_use id. */
  private readonly calls = new Map<string, ToolCall[]>();
  /** The last result of each tool_use id. */
  private readonly results = new Map<string, { content: unknown; isError: boolean }>();

  private readonly cutText: (v: string) => string;

  constructor(payloadCap?: number, cut?: (v: unknown) => unknown, cutText?: (v: unknown) => unknown) {
    this.cap = cut ?? (payloadCap ? (v) => capPayload(v, payloadCap) : (v) => v);
    this.cutText = cutText ? (v) => cutText(v) as string : (v) => v;
  }

  add(line: number, obj: any): void {
    if (!obj || typeof obj !== 'object') return;
    const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;

    if (obj.type === 'user') {
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result' && block.tool_use_id) {
            this.addResult(block.tool_use_id, this.cap(block.content), block.is_error === true);
          }
        }
      }
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
          .map((c: any) => c.text)
          .join('\n');
      }
      if (!text.trim()) return; // tool_result-only user messages are attached to the preceding assistant
      const cleaned = stripBanners(text);
      if (!cleaned) return; // was ONLY banners / local-command plumbing → drop it
      const origin = userRecordOrigin(obj, cleaned);
      this.messages.push({ line, role: 'user', content: this.cutText(cleaned), timestamp, ...(origin === 'human' ? {} : { origin }) });
    } else if (obj.type === 'attachment') {
      // A prompt typed while the agent works reaches the transcript only as
      // this attachment, so without it the prompt is missing from the view.
      const queued = queuedCommandPrompt(obj);
      if (!queued) return;
      const cleaned = stripBanners(queued.text);
      if (!cleaned) return;
      this.messages.push({ line, role: 'user', content: this.cutText(cleaned), timestamp, ...(queued.origin === 'human' ? {} : { origin: queued.origin }) });
    } else if (obj.type === 'assistant') {
      const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
      const thinkingBlock = blocks.find((c: any) => c?.type === 'thinking');
      const textBlock = blocks.find((c: any) => c?.type === 'text');
      const toolUses = blocks.filter((c: any) => c?.type === 'tool_use');

      const toolCalls: ToolCall[] = toolUses.map((toolUse: any) => {
        const known = toolUse.id ? this.results.get(toolUse.id) : undefined;
        const call: ToolCall = {
          name: toolUse.name || 'unknown',
          input: this.cap(toolUse.input),
          result: known?.content,
          isError: known?.isError,
        };
        if (toolUse.id) {
          const list = this.calls.get(toolUse.id);
          if (list) list.push(call); else this.calls.set(toolUse.id, [call]);
        }
        return call;
      });

      const hasThinking = thinkingBlock !== undefined;
      const text = textBlock?.text ?? '';
      const thinking = thinkingBlock?.thinking != null
        ? this.cap(thinkingBlock.thinking) as string
        : (hasThinking ? '' : undefined);

      if (!text && !hasThinking && toolCalls.length === 0) return;
      this.messages.push({
        line,
        role: 'assistant',
        content: this.cutText(text),
        thinking,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        timestamp,
      });
    } else if (obj.type === 'summary' && typeof obj.summary === 'string') {
      this.messages.push({ line, role: 'summary', content: obj.summary });
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
      if (text.trim()) this.messages.push({ line, role: 'summary', content: stripBanners(text), timestamp });
    }
  }

  private addResult(id: string, content: unknown, isError: boolean): void {
    this.results.set(id, { content, isError });
    const list = this.calls.get(id);
    if (list) for (const call of list) { call.result = content; call.isError = isError; }
  }
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
export async function parseClaudeSubagents(sessionPath: string, opts: ClaudeParseOptions = {}): Promise<Subagent[]> {
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
      messages = await parseMessagesFromFile(filePath, opts);
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

