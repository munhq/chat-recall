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
import { createHash } from 'crypto';
import type { AiTool, RawSessionExport } from '../core/tool-backend.js';
import { tryGetBackend } from '../core/tool-backend.js';
import type { Transcript, TranscriptMessage, Subagent } from './types.js';
import { parseClaudeTranscriptText } from './claude.js';
import { parseCodexTranscriptText } from './codex.js';
import { canonicalEventsToMessages } from './from-events.js';

export interface RawContainer {
  v: 1;
  tool: AiTool;
  mtime: number;
  files: Array<{ name: string; text: string }>;
  /** Content fingerprint (sha1 of tool + every file's name/text, NOT mtime) of
   *  the CURRENT on-disk export that last updated this shadow. Written only into
   *  the shadow copy; lets updateShadow fast-path when disk content is
   *  byte-identical (mtime bumped but nothing changed). Absent on freshly
   *  exported containers and on legacy shadows. See containerSrcHash. */
  srcHash?: string;
  /** SHADOW_MERGE_VERSION of the merge that wrote this shadow. The srcHash
   *  fast path trusts a stored merge only at the current version. */
  mergeVersion?: number;
}

export function buildRawContainer(exp: RawSessionExport): RawContainer {
  return {
    v: 1,
    tool: exp.tool,
    mtime: Math.floor(exp.mtime),
    files: exp.files.map((f) => ({ name: f.name, text: f.bytes.toString('utf-8') })),
  };
}

/**
 * Content fingerprint of a container — sha1 over the tool id and each file's
 * name+text, DELIBERATELY excluding mtime. Two exports of the same session with
 * identical content but different mtimes hash equal, which is exactly what lets
 * the shadow (and the sync ledger) skip redundant re-processing when an upstream
 * tool bumps a timestamp/summary without changing the transcript. */
export function containerSrcHash(c: RawContainer): string {
  const h = createHash('sha1');
  h.update(c.tool);
  for (const f of c.files) { h.update('\u0000'); h.update(f.name); h.update('\u0000'); h.update(f.text); }
  return h.digest('hex');
}

export function gzipContainer(c: RawContainer): { gz: Buffer; size: number } {
  const json = JSON.stringify(c);
  return { gz: gzipSync(json, { level: 6 }), size: Buffer.byteLength(json) };
}

/**
 * The largest archive (uncompressed bytes) the server unpacks whole. Unpacking
 * holds the text, the parsed container and the parsed transcript at once, and a
 * server pod has 512 MiB. The largest archive stored before chunked uploads was
 * 36 MB. A larger one is stored and can be downloaded, and every server path
 * that would unpack it whole skips it.
 */
export const RAW_PARSE_MAX_BYTES = 40 * 1024 * 1024;

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

const MARKER_QUOTE = /\[REDACTED:[A-Za-z0-9_-]+\]"/g;

/**
 * Put back the backslashes that the redactor took from JSONL lines before
 * 0.7.12.
 *
 * A rule that stopped at an escaped quote (`Bearer <token>\"`) replaced the
 * token and its backslash, so the line read `[REDACTED:auth-header]"` and no
 * longer parsed, and every reader dropped the record. The original text had a
 * backslash before that quote, so adding it back restores the line exactly.
 * A rule could also begin on the letter of an escape and leave `\[REDACTED`;
 * that backslash is removed, and the letter it escaped stays lost.
 * A quote after a marker can also be the real end of a string, so a line is
 * repaired one site at a time: the error JSON.parse reports lies after the
 * quote that ended the string early, and the nearest marker quote before it
 * is escaped. A line is kept only if it parses in the end.
 */
export function repairRedactedJsonl(text: string): { text: string; repaired: number } {
  // The self-heal sweep runs this over every archive in a worker that peaks at
  // about 400 MiB of its 512 MiB, and one pod was OOM-killed during the first
  // repair pass. So only the lines that hold a marker are read, and the text is
  // rebuilt only when one of them changes.
  let repaired = 0;
  const parts: string[] = [];
  let copied = 0;
  let at = text.indexOf('[REDACTED:');
  while (at >= 0) {
    const start = text.lastIndexOf('\n', at) + 1;
    let end = text.indexOf('\n', at);
    if (end < 0) end = text.length;
    const fixed = repairLine(text.slice(start, end));
    if (fixed !== null) {
      parts.push(text.slice(copied, start), fixed);
      copied = end;
      repaired++;
    }
    at = text.indexOf('[REDACTED:', end);
  }
  if (repaired === 0) return { text, repaired: 0 };
  parts.push(text.slice(copied));
  return { text: parts.join(''), repaired };
}

function parseError(line: string): number | null {
  try { JSON.parse(line); return null; } catch (e) {
    const m = /position (\d+)/.exec(e instanceof Error ? e.message : '');
    return m ? Number(m[1]) : line.length;
  }
}

function repairLine(line: string): string | null {
  if (!line.includes('[REDACTED:') || parseError(line) === null) return null;
  // A match that began on the letter of an escape (`\n`) left its backslash
  // in front of the marker. `\[` is never valid JSON, so that backslash is
  // damage wherever it appears. The letter it escaped is gone, so the
  // backslash goes too.
  let out = line.replace(/(?<!\\)((?:\\\\)*)\\(\[REDACTED:)/g, '$1$2');
  // An escaped site reads `]\"` and no longer matches MARKER_QUOTE, so each
  // pass considers only the sites still bare.
  for (let attempt = 0; attempt < 64; attempt++) {
    const at = parseError(out);
    if (at === null) return out;
    let site = -1;
    for (const m of out.matchAll(MARKER_QUOTE)) {
      const q = m.index! + m[0].length - 1;
      if (q < at) site = q;
    }
    if (site < 0) return null;
    out = out.slice(0, site) + '\\' + out.slice(site);
  }
  return null;
}

/**
 * Redact one JSONL line by the text its strings hold.
 *
 * The raw line is not the text a rule should see. Inside a JSON string a
 * newline is `\n` and a quote is `\"`, so `API_KEY=\"value\"` fails the
 * env-secret rule and a key that starts a line reads as `nsk-…` to a
 * word-bounded one. On one machine that sent a secret in clear text from 582
 * lines in 203 sessions. So a string that holds an escape is decoded,
 * redacted and written back when it changed. The raw pass then runs over the
 * line for context that spans strings, such as `"API_KEY": "value"`. If that
 * pass left the line unparseable, the line is redacted string by string, so
 * it always stays valid JSON.
 */
export function redactJsonLine(line: string, redact: (text: string) => string): string {
  if (!line.includes('"')) return redact(line);
  try { JSON.parse(line); } catch { return redact(line); }
  const decoded = mapJsonStrings(line, redact, true);
  const out = redact(decoded);
  try { JSON.parse(out); return out; } catch { return mapJsonStrings(decoded, redact, false); }
}

/**
 * Apply `fn` to the decoded value of each JSON string token in `line`, and
 * write a token back only when its value changed. With `escapedOnly`, a
 * token without a backslash is skipped: its raw text is its value.
 */
function mapJsonStrings(line: string, fn: (value: string) => string, escapedOnly: boolean): string {
  let out = '';
  let i = 0;
  for (;;) {
    const q = line.indexOf('"', i);
    if (q < 0) return out + line.slice(i);
    let j = q + 1;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if (c === 92 /* \ */) j += 2;
      else if (c === 34 /* " */) break;
      else j++;
    }
    const token = line.slice(q, j + 1);
    out += line.slice(i, q);
    i = j + 1;
    const body = token.slice(1, -1);
    const escaped = body.includes('\\');
    if (escapedOnly && !escaped) { out += token; continue; }
    let value = body;
    if (escaped) {
      try { value = JSON.parse(token) as string; } catch { out += token; continue; }
    }
    const next = fn(value);
    out += next === value ? token : JSON.stringify(next);
  }
}

/** The container with each JSONL file redacted line by line (redactJsonLine)
 *  and every other file redacted as plain text. */
export function redactContainer(c: RawContainer, redact: (text: string) => string): RawContainer {
  return {
    ...c,
    files: c.files.map((f) => ({
      name: f.name,
      text: f.name.endsWith('.jsonl')
        ? f.text.split('\n').map((l) => (l ? redactJsonLine(l, redact) : l)).join('\n')
        : redact(f.text),
    })),
  };
}

/** The container with every JSONL file passed through repairRedactedJsonl. */
export function repairContainer(c: RawContainer): { container: RawContainer; repaired: number } {
  let repaired = 0;
  const files = c.files.map((f) => {
    if (!f.name.endsWith('.jsonl')) return f;
    const r = repairRedactedJsonl(f.text);
    repaired += r.repaired;
    return r.repaired > 0 ? { name: f.name, text: r.text } : f;
  });
  return repaired > 0 ? { container: { ...c, files }, repaired } : { container: c, repaired: 0 };
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


  if (c.tool === 'opencode') {
    const main = c.files[0];
    return { messages: main ? parseOpenCodeDumpText(main.text) : [], subagents: [] };
  }

  // Generic fallback for any tool without a hardcoded branch (e.g. agy, and
  // future single-file tools): if its backend can parse raw text into canonical
  // events, use that — the container twin of parseTranscript()'s generic
  // readEvents fallback. Without this an agy session reconstructed from an
  // archived/shadow container parsed to ZERO messages. Backend registration is
  // a side-effect import the callers (sync/server/repair) already perform; if
  // the registry is empty we degrade to empty, same as before.
  try {
    const main = c.files.find((f) => !isSub(f.name)) ?? c.files[0];
    // tryGetBackend is non-throwing and does NOT trigger registration; the
    // callers that reconstruct containers (sync/server/repair) already import
    // the backends. Empty registry → null → we degrade to empty, as before.
    const backend = main ? tryGetBackend(c.tool) : null;
    if (main && backend?.readEventsFromText) {
      const messages = canonicalEventsToMessages(backend.readEventsFromText(main.text, c.mtime));
      if (messages.length > 0) return { messages, subagents: [] };
    }
  } catch { /* unparseable — fall through to empty */ }

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

/**
 * Fork-lineage detection (Phase 2 step 2). A resumed/forked Claude session's
 * FIRST content line carries a parentUuid that exists only in the
 * predecessor session's file. Returns the predecessor session id when the
 * head parent is dangling and a sibling file in the same project dir
 * contains it; null otherwise (no fork, or predecessor pruned).
 */
export function detectForkPredecessor(sessionPath: string): string | null {
  // Lazy fs/path to keep this module import-light for the server bundle.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync, readdirSync } = requireFs();
  const { dirname, join, basename } = requirePath();
  let text: string;
  try { text = readFileSync(sessionPath, 'utf-8'); } catch { return null; }
  const lines = text.split('\n');
  let headParent: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if ((o.type === 'user' || o.type === 'assistant') && o.message) {
        headParent = typeof o.parentUuid === 'string' ? o.parentUuid : null;
        break;
      }
    } catch { /* skip */ }
  }
  if (!headParent) return null;
  if (text.includes(`"uuid":"${headParent}"`)) return null; // parent is in-file: not a fork head
  const dir = dirname(sessionPath);
  const self = basename(sessionPath);
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return null; }
  for (const f of entries) {
    if (!f.endsWith('.jsonl') || f === self || f === 'sessions-index.json') continue;
    try {
      if (readFileSync(join(dir, f), 'utf-8').includes(`"uuid":"${headParent}"`)) {
        return basename(f, '.jsonl');
      }
    } catch { /* unreadable sibling */ }
  }
  return null; // predecessor pruned or elsewhere
}

function requireFs(): typeof import('fs') {
  // node:module createRequire keeps ESM compatibility for sync requires
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return fsMod;
}
function requirePath(): typeof import('path') {
  return pathMod;
}
import * as fsMod from 'fs';
import * as pathMod from 'path';
