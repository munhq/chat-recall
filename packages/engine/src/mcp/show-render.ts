/**
 * Text rendering for `recall_show` and `chat-recall show`.
 *
 * The server envelope holds every tool input and every tool result, and the
 * reader of a past session needs them: "what did that Read return", "what did
 * the Write put in the file". Some of these bodies are huge (one synced tool
 * result is 675 482 characters), so a body over BODY_LIMIT prints its first
 * and last EDGE characters and names the call that returns it whole.
 *
 * Message text, thinking and Bash commands always print whole. They are what
 * the agent said and ran, and they are short next to the file bodies and
 * command output that carry the size.
 */

export interface ShowToolCall {
  name: string;
  input?: unknown;
  /** A string, or content blocks ({type:'text'|'image'|'tool_reference',…}). Absent when no result was recorded. */
  result?: unknown;
  isError?: boolean;
}

export interface ShowMessage {
  line: number;
  role: string;
  content: string;
  thinking?: string;
  toolCalls?: ShowToolCall[];
}

export interface RenderShowOptions {
  /** Print every body whole. Used for the one message an expand call asks for. */
  full?: boolean;
  /** The instruction that returns message `line` whole, shown where a body is cut. */
  expandHint?: (line: number) => string;
}

/** A tool input field or result longer than this prints as its head and tail. */
export const BODY_LIMIT = 2000;
/** Characters kept at each end of a cut body. */
export const EDGE = 100;

const INDENT = '    ';
const oneLine = (v: unknown) => String(v).replace(/\s*\n\s*/g, ' ⏎ ');
const indent = (text: string) => text.split('\n').map(l => INDENT + l).join('\n');

/** Slice that never splits a surrogate pair at either end. */
function safeSlice(s: string, start: number, end: number): string {
  const lo = start > 0 && /[\uDC00-\uDFFF]/.test(s[start] ?? '') ? start - 1 : start;
  const hi = end < s.length && /[\uD800-\uDBFF]/.test(s[end - 1] ?? '') ? end + 1 : end;
  return s.slice(lo, hi);
}

function body(text: string, line: number, opts: RenderShowOptions): string {
  if (opts.full || text.length <= BODY_LIMIT) return indent(text);
  const lines = text.split('\n').length;
  const cut = text.length - 2 * EDGE;
  const how = opts.expandHint ? ` ${opts.expandHint(line)}` : '';
  return [
    indent(safeSlice(text, 0, EDGE)),
    `${INDENT}… ${cut} characters cut (${text.length} in all, ${lines} lines).${how} …`,
    indent(safeSlice(text, text.length - EDGE, text.length)),
  ].join('\n');
}

/** Tool results arrive as a string or as content blocks. */
export function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result.map((b: any) => {
      if (b?.type === 'text') return String(b.text ?? '');
      if (b?.type === 'image') return '[image]';
      if (b?.type === 'tool_reference') return `[tool_reference: ${b.tool_name ?? ''}]`;
      return JSON.stringify(b);
    }).join('\n');
  }
  return JSON.stringify(result);
}

function renderToolCall(tc: ShowToolCall, line: number, opts: RenderShowOptions): string {
  const inp: Record<string, unknown> =
    tc.input && typeof tc.input === 'object' ? tc.input as Record<string, unknown> : {};
  const out: string[] = [];

  if (tc.name === 'Bash' && inp.command !== undefined) {
    const desc = inp.description ? `  # ${oneLine(inp.description)}` : '';
    out.push(`[Bash]${desc}\n  $ ${oneLine(inp.command)}`);
  } else if (inp.file_path !== undefined) {
    // File tools: the path heads the call, short options sit inline after it,
    // and each text field (content, old_string, new_string, …) prints as a body.
    const inline: Record<string, unknown> = {};
    const blocks: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(inp)) {
      if (k === 'file_path') continue;
      if (typeof v === 'string' && (v.includes('\n') || v.length > 120)) blocks.push([k, v]);
      else inline[k] = v;
    }
    const opts_ = Object.keys(inline).length ? ` ${JSON.stringify(inline)}` : '';
    out.push(`[${tc.name}] ${inp.file_path}${opts_}`);
    for (const [k, v] of blocks) out.push(`  ${k}:`, body(v, line, opts));
  } else if (typeof tc.input === 'string') {
    out.push(`[${tc.name}]`, body(tc.input, line, opts));
  } else {
    const json = JSON.stringify(tc.input ?? {});
    if (opts.full || json.length <= BODY_LIMIT) out.push(`[${tc.name}] ${oneLine(json)}`);
    else out.push(`[${tc.name}]`, body(json, line, opts));
  }

  if (tc.result !== undefined) {
    out.push(tc.isError ? '  → error:' : '  → result:', body(resultText(tc.result), line, opts));
  }
  return out.join('\n');
}

export function renderShowMessages(messages: ShowMessage[], opts: RenderShowOptions = {}): string[] {
  const out: string[] = [];
  for (const msg of messages) {
    const text = msg.content ?? '';
    const thinking = msg.thinking ?? '';
    const calls = msg.toolCalls ?? [];
    // Claude Code writes thinking blocks with the text removed, so a turn that
    // held only one has nothing to show.
    if (!text.trim() && !thinking.trim() && !calls.length && msg.thinking !== undefined) continue;
    out.push(`**${msg.role}** (line ${msg.line})`);
    if (thinking.trim()) out.push(`_(thinking)_\n${thinking}`);
    if (text.trim()) out.push(text);
    for (const tc of calls) out.push(renderToolCall(tc, msg.line, opts));
    if (!text.trim() && !thinking.trim() && !calls.length) out.push('_(empty)_');
    out.push('');
  }
  return out;
}
