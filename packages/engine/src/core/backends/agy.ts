/**
 * Antigravity (agy) CLI backend. Owns ~/.gemini/antigravity-cli (overridable via CHAT_RECALL_AGY_HOME).
 *
 * Antigravity sessions live under <home>/brain/<session-uuid>/, and the transcripts
 * are in .system_generated/logs/transcript.jsonl or transcript_full.jsonl.
 *
 * IDs are prefixed: 'agy_<inner-uuid>'.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import { agyHomeDir, agyBrainDirs } from '../tool-paths.js';
import { readTailFromOffset } from './tail-read.js';

import type {
  ToolBackend,
  SessionLocation,
  SessionRef,
  ListSessionsOpts,
  ExtractTurnsOpts,
  LiveScanEditsResult,
  CanonicalEvent,
  EditDelta,
  CollectRecentEditsOpts,
  RawSessionExport,
} from '../tool-backend.js';
import type { ExtractedTurns } from '../session-turns.js';
import type { SessionDiffResult } from '../session-replay.js';
import { findRepoRoot } from '../session-replay.js';
import type { SessionOutcome } from '../session-outcome.js';
import type { SessionCommitsResult } from '../session-git.js';
import type { EditOp, SessionEdit } from '../live-session-scan.js';

import { computeOutcome } from '../session-outcome.js';
import { getSessionCommits } from '../session-git.js';
import {
  extractTurnsFromEvents,
  liveScanEditsFromEvents,
  replayFromEvents,
} from '../generic-engine.js';
import { flatString } from '../flat-string.js';

const PREFIX = 'agy_';

export class AgyBackend implements ToolBackend {
  readonly id = 'agy' as const;
  readonly idPrefix = PREFIX;
  readonly displayName = 'Antigravity';

  homeDir(): string { return agyHomeDir(); }

  isAvailable(): boolean {
    return agyBrainDirs().length > 0;
  }

  // ── ID handling ────────────────────────────────────────────────
  matchesId(id: string): boolean { return id.startsWith(PREFIX); }
  toRawId(id: string): string { return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id; }
  toPrefixedId(rawId: string): string { return rawId.startsWith(PREFIX) ? rawId : PREFIX + rawId; }

  // ── Location ───────────────────────────────────────────────────
  findSession(id: string): SessionLocation | null {
    const rawId = this.toRawId(id);
    // Every configured Antigravity home, primary first — searching only the
    // first would report a session held by a second profile as missing.
    for (const brainDir of agyBrainDirs()) {
      const found = this.findSessionIn(brainDir, rawId);
      if (found) return found;
    }
    return null;
  }

  /** Resolve a session inside ONE brain root. */
  private findSessionIn(brainDir: string, rawId: string): SessionLocation | null {
    const sessionDir = join(brainDir, rawId);
    if (!existsSync(sessionDir)) return null;

    const path = agyTranscriptPath(join(sessionDir, '.system_generated', 'logs'));
    if (!path) return null;

    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { /* ignore */ }

    const projectPath = resolveAgyProject(dirname(path), this.homeDir());
    const projectDir = projectPath ? basename(projectPath) : '';

    return {
      path,
      format: 'jsonl',
      projectDir,
      projectPath,
      mtime,
    };
  }

  listSessions(opts: ListSessionsOpts = {}): SessionRef[] {
    const cutoff = opts.sinceMs ?? 0;
    const filter = opts.projectFilter?.toLowerCase();
    const out: SessionRef[] = [];
    const seenIds = new Set<string>();

    // Every configured Antigravity home, primary first.
    for (const brainDir of agyBrainDirs()) {
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(brainDir);
    } catch {
      continue;
    }

    for (const rawId of sessionDirs) {
      const sessionPath = join(brainDir, rawId);
      try {
        if (!statSync(sessionPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const filePath = agyTranscriptPath(join(sessionPath, '.system_generated', 'logs'));
      if (!filePath) continue;

      let stat;
      try { stat = statSync(filePath); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;

      const projectPath = resolveAgyProject(dirname(filePath), this.homeDir());
      if (filter && (!projectPath || !projectPath.toLowerCase().includes(filter))) continue;

      const projectDir = projectPath ? basename(projectPath) : '';

      // Read first prompt and message count from events in a fast manner
      let firstPrompt = '';
      let messageCount = 0;
      try {
        const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
        messageCount = lines.length;
        for (const line of lines) {
          const obj = JSON.parse(line);
          if (obj.source === 'USER_EXPLICIT' && obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
            const content = obj.content;
            const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            const rawText = match ? match[1].trim() : content.trim();
            firstPrompt = flatString(rawText.slice(0, 200));
            break;
          }
        }
      } catch { /* ignore */ }

      // A session id appears once even when two profiles hold it.
      if (seenIds.has(rawId)) continue;
      seenIds.add(rawId);

      out.push({
        toolId: 'agy',
        rawId,
        prefixedId: this.toPrefixedId(rawId),
        projectPath,
        projectDir,
        fullPath: filePath,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        mtime: stat.mtimeMs,
        firstPrompt,
        messageCount,
      });
    }
    }

    out.sort((a, b) => b.mtime - a.mtime);
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  // ── Generic-engine inputs ───────────────────────────────────────

  readonly fileToolMap: Record<string, EditOp> = {
    write_to_file: 'write',
    replace_file_content: 'edit',
    multi_replace_file_content: 'multi_edit',
    read_file: 'read',
    view_file: 'read',
  };

  /**
   * For Antigravity, the arguments:
   *   - replace_file_content:   { TargetFile, TargetContent, ReplacementContent }
   *   - write_to_file: { TargetFile, CodeContent }
   */
  extractEditDelta(toolName: string, input: unknown): EditDelta | null {
    if (input == null || typeof input !== 'object') return null;
    const inp = input as Record<string, unknown>;
    if (toolName === 'replace_file_content') {
      const before = typeof inp.TargetContent === 'string' ? inp.TargetContent : null;
      const after = typeof inp.ReplacementContent === 'string' ? inp.ReplacementContent : null;
      if (before === null && after === null) return null;
      return { before, after };
    }
    if (toolName === 'write_to_file') {
      const after = typeof inp.CodeContent === 'string' ? inp.CodeContent : null;
      return { before: '', after };
    }
    if (toolName === 'multi_replace_file_content') {
      // A single file (TargetFile) edited via N chunks, each carrying its own
      // TargetContent (before) + ReplacementContent (after). Concatenate the
      // chunks into one before/after so the diff renders as a real edit.
      const chunks = Array.isArray(inp.ReplacementChunks) ? inp.ReplacementChunks : [];
      if (chunks.length === 0) return null;
      let before = '';
      let after = '';
      for (const c of chunks) {
        if (!c || typeof c !== 'object') continue;
        const cc = c as Record<string, unknown>;
        if (typeof cc.TargetContent === 'string') before += (before ? '\n' : '') + cc.TargetContent;
        if (typeof cc.ReplacementContent === 'string') after += (after ? '\n' : '') + cc.ReplacementContent;
      }
      if (!before && !after) return null;
      return { before: before || null, after: after || null };
    }
    return null;
  }

  readEvents(rawId: string): CanonicalEvent[] {
    const located = this.findSession(rawId);
    if (!located) return [];
    let rawText: string;
    try {
      rawText = readFileSync(located.path, 'utf-8');
    } catch {
      return [];
    }
    return this.readEventsFromText(rawText, located.mtime);
  }

  /**
   * Parse agy transcript text into canonical events. Split out from readEvents
   * so the SAME parser runs on archived/​shadow container bytes (via
   * parseTranscriptFromContainer's generic fallback), not just the live file —
   * without it, a recovered or synced-from-raw agy session parsed to zero
   * messages. `mtimeFallback` stands in for the file mtime when a line has no
   * timestamp.
   */
  readEventsFromText(rawText: string, mtimeFallback = 0): CanonicalEvent[] {
    const events: CanonicalEvent[] = [];
    const lines = rawText.split('\n');
    let lineNum = 0;

    const pendingToolCalls: Array<{ name: string; id: string }> = [];
    let toolUseCounter = 0;

    for (const line of lines) {
      lineNum++;
      if (!line.trim()) continue;

      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const tsIso = typeof obj.created_at === 'string' ? obj.created_at : undefined;
      const ts = tsIso ? Date.parse(tsIso) || mtimeFallback : mtimeFallback;

      if (obj.source === 'USER_EXPLICIT' && obj.type === 'USER_INPUT') {
        const content = typeof obj.content === 'string' ? obj.content : '';
        const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        const text = match ? match[1].trim() : content.trim();
        if (text) {
          events.push({ kind: 'user', ts, tsIso, line: lineNum, text });
        }
      } else if (obj.source === 'MODEL' && obj.type === 'PLANNER_RESPONSE') {
        const content = typeof obj.content === 'string' ? obj.content.trim() : '';
        if (content) {
          events.push({ kind: 'assistant_text', ts, tsIso, line: lineNum, text: content });
        }

        const tcs = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
        for (const tc of tcs) {
          let toolName = String(tc?.name || '');
          if (!toolName) continue;
          if (toolName.includes(':')) {
            toolName = toolName.split(':').pop()!;
          }

          const toolUseId = `agy_tc_${toolUseCounter++}`;
          pendingToolCalls.push({ name: toolName, id: toolUseId });

          const cleanedArgs = cleanArgs(tc?.args) as Record<string, unknown>;
          // Normalize Antigravity's file field to the `file_path` the generic
          // engine reads, so agy edits/reads attribute to a file (and show a
          // filename) instead of rendering as pathless activity.
          if (cleanedArgs && typeof cleanedArgs === 'object' && !('file_path' in cleanedArgs)) {
            const tf = cleanedArgs.TargetFile ?? cleanedArgs.AbsolutePath ?? cleanedArgs.Path;
            if (typeof tf === 'string' && tf) cleanedArgs.file_path = tf;
          }
          const command = toolName === 'run_command' && typeof cleanedArgs?.CommandLine === 'string'
            ? (cleanedArgs.CommandLine as string)
            : undefined;

          events.push({
            kind: 'tool_use', ts, tsIso, line: lineNum,
            toolName, toolUseId, toolInput: cleanedArgs,
            command,
          });
        }
      } else if (obj.source === 'MODEL' && obj.type !== 'PLANNER_RESPONSE') {
        const resultBody = typeof obj.content === 'string' ? obj.content : '';
        const isError = obj.status === 'ERROR' || obj.status === 'FAILED';

        let matchedIndex = -1;
        for (let i = 0; i < pendingToolCalls.length; i++) {
          if (matchesTool(obj.type, pendingToolCalls[i].name)) {
            matchedIndex = i;
            break;
          }
        }

        let toolUseId = '';
        let toolName = '';
        if (matchedIndex !== -1) {
          const matched = pendingToolCalls.splice(matchedIndex, 1)[0];
          toolUseId = matched.id;
          toolName = matched.name;
        } else {
          if (pendingToolCalls.length > 0) {
            const popped = pendingToolCalls.shift()!;
            toolUseId = popped.id;
            toolName = popped.name;
          } else {
            toolUseId = `agy_tc_orphan_${toolUseCounter++}`;
            toolName = obj.type.toLowerCase();
          }
        }

        events.push({
          kind: 'tool_result', ts, tsIso, line: lineNum,
          toolUseId, toolName, resultBody,
          resultIsError: isError,
          resultBytes: resultBody.length,
        });
      }
    }

    return events;
  }

  // ── Per-session operations — all delegate to the generic engine ─

  extractTurns(id: string, opts: ExtractTurnsOpts = {}): ExtractedTurns {
    const events = this.readEvents(this.toRawId(id));
    return extractTurnsFromEvents(this.toPrefixedId(id), events, opts);
  }

  liveScanEdits(id: string): LiveScanEditsResult {
    const located = this.findSession(this.toRawId(id));
    if (!located) {
      return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: 'agy' };
    }
    const events = this.readEvents(this.toRawId(id));
    return liveScanEditsFromEvents(events, this.fileToolMap, {
      sessionId: this.toPrefixedId(id),
      tool: 'agy',
      projectPath: located.projectPath,
      projectDir: located.projectDir,
      fileMtime: located.mtime,
      found: true,
    });
  }

  replay(id: string): SessionDiffResult {
    const located = this.findSession(this.toRawId(id));
    if (!located) {
      return { sessionId: this.toPrefixedId(id), found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };
    }
    const events = this.readEvents(this.toRawId(id));
    return replayFromEvents(this.toPrefixedId(id), events, this.fileToolMap, this.extractEditDelta.bind(this), {
      projectPath: located.projectPath,
      found: true,
    });
  }

  computeOutcome(id: string, opts?: { commitBufferMinutes?: number }): SessionOutcome {
    return computeOutcome(this.toPrefixedId(id), opts);
  }

  collectRecentEdits(opts: CollectRecentEditsOpts): SessionEdit[] {
    // Recent activity must include secondary profiles, or their edits never
    // appear in the timeline.
    const brainRoots = agyBrainDirs();
    if (brainRoots.length === 0) return [];
    const brainDir = brainRoots[0];

    const candidates: { rawId: string; mtime: number }[] = [];
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(brainDir);
    } catch {
      return [];
    }

    for (const rawId of sessionDirs) {
      const sessionPath = join(brainDir, rawId);
      try {
        if (!statSync(sessionPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const filePath = agyTranscriptPath(join(sessionPath, '.system_generated', 'logs'));
      if (!filePath) continue;

      try {
        const st = statSync(filePath);
        if (st.mtimeMs < opts.sinceMs) continue;
        candidates.push({ rawId, mtime: st.mtimeMs });
      } catch { /* skip */ }
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    const limited = opts.limitSessions ? candidates.slice(0, opts.limitSessions) : candidates;

    const edits: SessionEdit[] = [];
    for (const c of limited) {
      const scan = this.liveScanEdits(c.rawId);
      if (scan.found) {
        edits.push(...scan.edits);
      }
    }
    return edits;
  }

  getCommits(
    id: string,
    files: string[],
    startMs: number,
    endMs: number,
    bufferMinutes?: number,
  ): SessionCommitsResult {
    return getSessionCommits(this.toPrefixedId(id), files, startMs, endMs, bufferMinutes);
  }

  exportRawSession(id: string): RawSessionExport | null {
    const loc = this.findSession(id);
    if (!loc) return null;
    try {
      return {
        tool: 'agy',
        mtime: statSync(loc.path).mtimeMs,
        files: [{ name: basename(loc.path), bytes: readFileSync(loc.path) }],
      };
    } catch { return null; }
  }

  isAppendOnly(): boolean { return true; }

  fileSize(prefixedId: string): number {
    const loc = this.findSession(prefixedId);
    if (!loc) return 0;
    try { return statSync(loc.path).size; } catch { return 0; }
  }

  async readFromOffset(prefixedId: string, offset: number): Promise<{ text: string; newOffset: number }> {
    const loc = this.findSession(prefixedId);
    if (!loc) return { text: '', newOffset: offset };
    return readTailFromOffset(loc.path, offset);
  }
}

export const agyBackend = new AgyBackend();

// ── Local helpers ────────────────────────────────────────────────────

function getFallbackProjectPath(homeDir: string): string {
  try {
    const settingsPath = join(homeDir, 'settings.json');
    if (existsSync(settingsPath)) {
      const json = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (Array.isArray(json?.trustedWorkspaces) && json.trustedWorkspaces[0]) {
        return json.trustedWorkspaces[0];
      }
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * The transcript to read for a session. Prefer `transcript_full.jsonl` — it is
 * the COMPLETE event log (every user turn + every tool call). The plain
 * `transcript.jsonl` is a compacted tail: for a real session it held only the
 * last exchange (1 of 6 user turns, 2 of 10 file writes), so reading it dropped
 * most of the conversation AND most edits. Falls back to the plain file when
 * the full one is absent; returns '' when neither exists.
 */
function agyTranscriptPath(logsDir: string): string {
  const full = join(logsDir, 'transcript_full.jsonl');
  if (existsSync(full)) return full;
  const primary = join(logsDir, 'transcript.jsonl');
  if (existsSync(primary)) return primary;
  return '';
}

/**
 * Resolve a session's project from the (full) transcript's referenced file
 * paths, falling back to the settings' trusted workspace only when nothing is
 * found. The clean `transcript.jsonl` only references Antigravity's own
 * `brain/…` artifacts, so we always derive from the full log.
 */
function resolveAgyProject(logsDir: string, homeDir: string): string {
  const deriveFrom = agyTranscriptPath(logsDir);
  if (!deriveFrom) return getFallbackProjectPath(homeDir);
  return extractProjectPathFromTranscript(deriveFrom, homeDir) || getFallbackProjectPath(homeDir);
}

function extractProjectPathFromTranscript(path: string, homeDir: string): string {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return '';
  }

  // 1) An explicit corpus declaration, when present, is authoritative.
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.source === 'USER_EXPLICIT' && obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
      const match = obj.content.match(/format\s+\[URI\]\s*->\s*\[CorpusName\]:\s*\n?\s*([^\s\n]+)\s*->/);
      if (match && match[1]) return match[1].trim();
    }
  }

  // 2) Most Antigravity transcripts have no corpus line — derive the project
  //    from the absolute file paths the session actually touched. Antigravity
  //    references files via TargetFile / AbsolutePath / DirectoryPath fields
  //    and `file://` URIs. We map each to its git repo root and pick the
  //    busiest one; without git, we fall back to the deepest common ancestor.
  return deriveProjectFromPaths(content, homeDir);
}

/** Collect the absolute file paths a transcript references and resolve the
 *  most-referenced project root from them. Paths under `homeDir` (Antigravity's
 *  own brain/ artifacts) are ignored — they're never the user's project. */
function deriveProjectFromPaths(content: string, homeDir: string): string {
  const paths = new Set<string>();
  const fieldRe = /"(?:AbsolutePath|DirectoryPath|TargetFile|Path)"\s*:\s*"([^"]+)"/g;
  // Stop the URI at whitespace/quotes/backtick/brackets — transcripts wrap
  // them like `File Path: \`file:///…/Makefile\``, so backtick must terminate.
  const uriRe = /file:\/\/(\/[^\s"'`\\)<>]+)/g;
  for (const re of [fieldRe, uriRe]) {
    for (const m of content.matchAll(re)) {
      const p = m[1];
      // Skip Antigravity's own artifacts (brain/<id>/… under its home dir).
      if (p && p.startsWith('/') && !p.startsWith(homeDir)) paths.add(p);
    }
  }
  if (paths.size === 0) return '';

  // Tally git repo roots — the same notion of "project" the rest of the
  // system resolves to (git:… project ids), so agy rows cluster with the
  // Claude/Gemini sessions in the same repo.
  const roots = new Map<string, number>();
  for (const p of paths) {
    const root = findRepoRoot(p);
    if (root) roots.set(root, (roots.get(root) || 0) + 1);
  }
  if (roots.size > 0) {
    return [...roots.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  // No git repo — deepest common directory of the referenced paths, as long
  // as it's specific enough to be a project (≥4 path segments).
  const dirs = [...paths].map((p) => (/\.[a-zA-Z0-9]+$/.test(p) ? p.slice(0, p.lastIndexOf('/')) : p));
  let segs = dirs[0].split('/');
  for (const d of dirs.slice(1)) {
    const s = d.split('/');
    let i = 0;
    while (i < segs.length && i < s.length && segs[i] === s[i]) i++;
    segs = segs.slice(0, i);
  }
  return segs.filter(Boolean).length >= 4 ? segs.join('/') : '';
}

function cleanArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === 'string') {
      try {
        cleaned[k] = JSON.parse(v);
      } catch {
        cleaned[k] = v;
      }
    } else {
      cleaned[k] = cleanArgs(v);
    }
  }
  return cleaned;
}

function matchesTool(resultType: string, toolName: string): boolean {
  const normResult = resultType.toLowerCase().replace(/_/g, '');
  const normTool = toolName.toLowerCase().replace(/_/g, '');
  return normResult.includes(normTool) || normTool.includes(normResult) ||
         (normResult === 'codeaction' && ['writetofile', 'replacefilecontent', 'multireplacefilecontent'].includes(normTool)) ||
         (normResult === 'generic' && ['askpermission'].includes(normTool));
}
