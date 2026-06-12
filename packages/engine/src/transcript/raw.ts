/**
 * Raw-container round-trip (Phase 2 step 1c).
 *
 * A RawSessionExport (per-tool capture: file bytes or DB row-dump) is
 * serialized into ONE text container, gzipped, archived, synced, and —
 * crucially — parsed back into the canonical Transcript ANYWHERE, with
 * the same per-tool parsers the live filesystem path uses. This is what
 * lets the server re-render any session from archived bytes forever,
 * with zero client involvement.
 *
 * Container format v1 (all our sources are UTF-8 text):
 *   { v: 1, tool, mtime, files: [{ name, text }] }
 */
import { gzipSync, gunzipSync } from 'zlib';
import type { AiTool, RawSessionExport } from '../core/tool-backend.js';
import type { Transcript, TranscriptMessage, Subagent } from './types.js';
import { parseClaudeTranscriptText } from './claude.js';
import { parseGeminiTranscriptText } from './gemini.js';
import { parseCodexTranscriptText } from './codex.js';

export interface RawContainer {
  v: 1;
  tool: AiTool;
  mtime: number;
  files: Array<{ name: string; text: string }>;
}

export function buildRawContainer(exp: RawSessionExport): RawContainer {
  return {
    v: 1,
    tool: exp.tool,
    mtime: Math.floor(exp.mtime),
    files: exp.files.map((f) => ({ name: f.name, text: f.bytes.toString('utf-8') })),
  };
}

export function gzipContainer(c: RawContainer): { gz: Buffer; size: number } {
  const json = JSON.stringify(c);
  return { gz: gzipSync(json, { level: 6 }), size: Buffer.byteLength(json) };
}

export function gunzipContainer(gz: Buffer): RawContainer | null {
  try {
    const c = JSON.parse(gunzipSync(gz).toString('utf-8'));
    if (c?.v === 1 && Array.isArray(c.files)) return c as RawContainer;
  } catch { /* corrupt */ }
  return null;
}

/** Apply a string transform (e.g. the secret redactor) to every file. */
export function mapContainerText(c: RawContainer, fn: (text: string) => string): RawContainer {
  return { ...c, files: c.files.map((f) => ({ name: f.name, text: fn(f.text) })) };
}

/** Subagent kind from its filename — same heuristics as the FS path. */
function subagentKind(id: string): Subagent['kind'] {
  return id.includes('acompact') ? 'compact'
    : id.includes('aside_question') ? 'aside'
    : id.includes('explore') || /^agent-a[0-9a-f]{16,}$/i.test(id) ? 'explore'
    : 'other';
}

/**
 * Parse the OpenCode row-dump (exportRawSession's deterministic format:
 * one JSON line per row — `{kind:'session'|'part', row}`) with the same
 * message semantics as the live-DB parser.
 */
export function parseOpenCodeDumpText(text: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let lineNum = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.kind !== 'part' || !entry.row) continue;
    try {
      const partData = JSON.parse(entry.row.part_data);
      const msgData = JSON.parse(entry.row.message_data);
      const role: 'user' | 'assistant' = msgData.role === 'user' ? 'user' : 'assistant';
      if (partData.type === 'text' && partData.text?.trim()) {
        lineNum++;
        messages.push({ line: lineNum, role, content: partData.text });
      } else if (partData.type === 'tool' && partData.tool) {
        lineNum++;
        messages.push({
          line: lineNum,
          role: 'assistant',
          content: `Tool: ${partData.tool}`,
          toolCalls: [{ name: partData.tool, input: partData.state || {} }],
        });
      }
    } catch { /* malformed row */ }
  }
  return messages;
}

/**
 * Canonical parse from an archived raw container — the server-side twin of
 * `parseTranscript(sessionId)`. Compaction stitching is applied the same
 * way (compact subagents spliced inline before the tail).
 */
export function parseTranscriptFromContainer(c: RawContainer): Transcript {
  const isSub = (n: string) => n.startsWith('subagents/');

  if (c.tool === 'claude' || c.tool === 'codex') {
    const parseText = c.tool === 'claude' ? parseClaudeTranscriptText : parseCodexTranscriptText;
    const main = c.files.find((f) => !isSub(f.name) && f.name.endsWith('.jsonl'));
    const tail = main ? parseText(main.text) : [];
    const metaByName = new Map<string, any>();
    for (const f of c.files) {
      if (isSub(f.name) && f.name.endsWith('.meta.json')) {
        try { metaByName.set(f.name.replace(/\.meta\.json$/, ''), JSON.parse(f.text)); } catch { /* optional */ }
      }
    }
    const subagents: Subagent[] = [];
    for (const f of c.files) {
      if (!isSub(f.name) || !f.name.endsWith('.jsonl')) continue;
      const id = f.name.replace(/^subagents\//, '').replace(/\.jsonl$/i, '');
      const msgs = parseText(f.text);
      const meta = metaByName.get(f.name.replace(/\.jsonl$/i, ''));
      subagents.push({
        id,
        kind: subagentKind(id),
        agentType: typeof meta?.agentType === 'string' ? meta.agentType : undefined,
        description: typeof meta?.description === 'string' ? meta.description : undefined,
        filePath: '',
        messageCount: msgs.length,
        toolUseCount: msgs.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0),
        messages: msgs,
      });
    }
    // Compaction stitching — identical to parseTranscript's claude branch.
    const compacts = subagents.filter((s) => s.kind === 'compact');
    const panels = subagents.filter((s) => s.kind !== 'compact');
    let messages = tail;
    if (compacts.length > 0) {
      const stitched: TranscriptMessage[] = [];
      for (const s of compacts) {
        stitched.push(...s.messages);
        stitched.push({
          line: 0,
          role: 'summary',
          content: `— conversation compacted here (${s.id}) — earlier history above is the compaction record —`,
        });
      }
      messages = [...stitched, ...tail].map((m, i) => ({ ...m, line: i + 1 }));
    }
    return { messages, subagents: panels };
  }

  if (c.tool === 'gemini') {
    const main = c.files[0];
    return { messages: main ? parseGeminiTranscriptText(main.text) : [], subagents: [] };
  }

  if (c.tool === 'opencode') {
    const main = c.files[0];
    return { messages: main ? parseOpenCodeDumpText(main.text) : [], subagents: [] };
  }

  return { messages: [], subagents: [] };
}

/**
 * Archive a session's raw capture into the local store (index-time hook).
 * Shrink-protection lives in the store; this is fire-and-forget per session.
 */
export async function archiveRawSession(
  store: { putRawSession(id: string, tool: string, mtime: number, gz: Buffer, size: number): Promise<'stored' | 'shrink-protected' | 'unchanged'> | ('stored' | 'shrink-protected' | 'unchanged') },
  sessionId: string,
): Promise<'stored' | 'shrink-protected' | 'unchanged' | 'unavailable'> {
  const { getBackendForId, getBackend } = await import('../core/tool-backend.js');
  const backend = getBackendForId(sessionId) ?? getBackend('claude');
  let exp: RawSessionExport | null = null;
  try { exp = backend.exportRawSession(sessionId); } catch { /* unavailable */ }
  if (!exp) return 'unavailable';
  const { gz, size } = gzipContainer(buildRawContainer(exp));
  return await store.putRawSession(sessionId, exp.tool, Math.floor(exp.mtime), gz, size);
}
