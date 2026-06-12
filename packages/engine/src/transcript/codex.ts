/**
 * Codex transcript parser — rollout JSONL + sibling sub-agent rollouts.
 * Ported verbatim from services/parser.ts.
 */
import { open, readdir, stat } from 'fs/promises';
import { dirname, join, basename } from 'path';
import type { TranscriptMessage as Message, Subagent, ToolCall } from './types.js';

/**
 * Discover Codex sub-agent rollouts spawned by a parent session.
 *
 * Codex writes each sub-agent dispatch as its own `rollout-*.jsonl` file in
 * the same `~/.codex/sessions/YYYY/MM/DD/` directory as the parent. The link
 * is in the first-line session_meta:
 *   payload.source.subagent.thread_spawn.parent_thread_id == <parent uuid>
 * (presence of payload.agent_role / agent_nickname also marks a sub-agent.)
 *
 * Unlike Claude — where sub-agents live in a `<session-id>/subagents/` dir
 * next to the parent jsonl — Codex sub-agents are scattered across the same
 * date dir, so we scan that dir filtering by parent_thread_id.
 */
export async function parseCodexSubagents(sessionPath: string): Promise<Subagent[]> {
  const dayDir = dirname(sessionPath);
  const parentId = basename(sessionPath).match(/([a-f0-9-]{36})\.jsonl$/i)?.[1];
  if (!parentId) return [];

  let entries: string[];
  try { entries = await readdir(dayDir); }
  catch { return []; }

  const subagents: Subagent[] = [];
  for (const fileName of entries) {
    if (!fileName.endsWith('.jsonl') || !fileName.startsWith('rollout-')) continue;
    const filePath = join(dayDir, fileName);
    if (filePath === sessionPath) continue;

    let firstLine = '';
    try {
      const fh = await open(filePath);
      try {
        for await (const line of fh.readLines()) { firstLine = line; break; }
      } finally { await fh.close(); }
    } catch { continue; }
    if (!firstLine) continue;

    let meta: any;
    try { meta = JSON.parse(firstLine); } catch { continue; }
    if (meta?.type !== 'session_meta') continue;
    const payload = meta.payload || {};
    const spawn = payload.source?.subagent?.thread_spawn;
    if (!spawn) continue;
    if (spawn.parent_thread_id !== parentId) continue;

    const id = fileName.replace(/\.jsonl$/i, '');
    const role = String(spawn.agent_role || payload.agent_role || '').toLowerCase();
    const kind: Subagent['kind'] =
        role.includes('compact') ? 'compact'
      : role.includes('aside')   ? 'aside'
      : role.includes('worker') || role.includes('explore') ? 'explore'
      : 'other';

    let messages: Message[] = [];
    try { messages = await parseCodexTranscript(filePath); }
    catch (e) { console.error(`Failed to parse Codex sub-agent ${filePath}:`, e); }

    const toolUseCount = messages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);

    subagents.push({
      id,
      kind,
      agentType: spawn.agent_role || payload.agent_role,
      description: spawn.agent_nickname || payload.agent_nickname,
      filePath,
      messageCount: messages.length,
      toolUseCount,
      messages,
    });
  }

  // Order by mtime so they render in dispatch order.
  const stats = await Promise.all(
    subagents.map(async (s) => {
      try { return (await stat(s.filePath)).mtimeMs; }
      catch { return 0; }
    }),
  );
  return subagents
    .map((s, i) => ({ s, mtime: stats[i] }))
    .sort((a, b) => a.mtime - b.mtime)
    .map(({ s }) => s);
}

/**
 * Codex stores message content as an array of typed segments
 * (`[{type:'input_text', text:'...'}, ...]`). Flatten to a single string
 * the UI can render — joining each segment's `text` and falling back to
 * the raw value for any unknown segment shape.
 */
function flattenCodexContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(seg => {
      if (typeof seg === 'string') return seg;
      if (seg && typeof seg === 'object' && typeof (seg as any).text === 'string') return (seg as any).text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Codex JSONL injects environment-context and permissions blocks as
 * `response_item/message` entries with role `developer` / `system` /
 * `user`. The actual human prompt is recorded once as
 * `event_msg/user_message` and the model's output as
 * `response_item/message` with role `assistant`. This filter keeps the
 * conversation clean by skipping injected wrappers.
 */
function isCodexInjectedWrapper(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('<permissions instructions>') ||
    trimmed.startsWith('<user_instructions>') ||
    trimmed.startsWith('<system_prompt>')
  );
}

/**
 * Parse a Codex session from JSONL.
 */
export async function parseCodexTranscript(sessionPath: string): Promise<Message[]> {
  const { readFile } = await import('fs/promises');
  return parseCodexTranscriptText(await readFile(sessionPath, 'utf-8'));
}

/** Same parse over in-memory text — what the server runs on archived raw. */
export function parseCodexTranscriptText(text: string): Message[] {
  const messages: Message[] = [];
  let lineNum = 0;

  {
    for (const line of text.split('\n')) {
      lineNum++;
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
          const text = String(obj.payload.message || '').trim();
          if (!text || isCodexInjectedWrapper(text)) continue;
          messages.push({
            line: lineNum,
            role: 'user',
            content: text,
            timestamp: obj.timestamp,
          });
        } else if (obj.type === 'response_item' && obj.payload?.type === 'message') {
          // Skip developer/system/user injections — they're environment
          // wrappers, not part of the user-facing transcript.
          if (obj.payload.role !== 'assistant') continue;
          const text = flattenCodexContent(obj.payload.content);
          if (!text.trim()) continue;
          messages.push({
            line: lineNum,
            role: 'assistant',
            content: text,
            timestamp: obj.timestamp,
          });
        } else if (obj.type === 'response_item' && obj.payload?.type === 'reasoning') {
          // Surface model reasoning summaries as a thinking block on the
          // next assistant message slot. Codex emits these between turns.
          const summary = Array.isArray(obj.payload.summary)
            ? obj.payload.summary.map((s: any) => s?.text || '').filter(Boolean).join('\n')
            : '';
          if (!summary.trim()) continue;
          messages.push({
            line: lineNum,
            role: 'assistant',
            content: '',
            thinking: summary,
            timestamp: obj.timestamp,
          });
        } else if (obj.type === 'response_item' && obj.payload?.type === 'function_call') {
          let input: any = obj.payload.arguments || {};
          if (typeof input === 'string') {
            try { input = JSON.parse(input); } catch { /* keep raw string */ }
          }
          messages.push({
            line: lineNum,
            role: 'assistant',
            content: '',
            toolCalls: [{ name: obj.payload.name || '', input }],
            timestamp: obj.timestamp,
          });
        }
      } catch {
        // skip malformed lines
      }
    }
  }
  return messages;
}
