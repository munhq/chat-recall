/**
 * Antigravity (agy) CLI backend. Owns ~/.gemini/antigravity-cli (overridable via CHAT_RECALL_AGY_HOME).
 *
 * Antigravity sessions live under <home>/brain/<session-uuid>/, and the transcripts
 * are in .system_generated/logs/transcript.jsonl or transcript_full.jsonl.
 *
 * IDs are prefixed: 'agy_<inner-uuid>'.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { agyHomeDir } from '../tool-paths.js';
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

const PREFIX = 'agy_';

export class AgyBackend implements ToolBackend {
  readonly id = 'agy' as const;
  readonly idPrefix = PREFIX;
  readonly displayName = 'Antigravity';

  homeDir(): string { return agyHomeDir(); }

  isAvailable(): boolean {
    return existsSync(join(this.homeDir(), 'brain'));
  }

  // ── ID handling ────────────────────────────────────────────────
  matchesId(id: string): boolean { return id.startsWith(PREFIX); }
  toRawId(id: string): string { return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id; }
  toPrefixedId(rawId: string): string { return rawId.startsWith(PREFIX) ? rawId : PREFIX + rawId; }

  // ── Location ───────────────────────────────────────────────────
  findSession(id: string): SessionLocation | null {
    const rawId = this.toRawId(id);
    const brainDir = join(this.homeDir(), 'brain', rawId);
    if (!existsSync(brainDir)) return null;

    let path = join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(path)) {
      path = join(brainDir, '.system_generated', 'logs', 'transcript_full.jsonl');
    }
    if (!existsSync(path)) return null;

    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { /* ignore */ }

    const projectPath = extractProjectPathFromTranscript(path) || getFallbackProjectPath(this.homeDir());
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
    const brainDir = join(this.homeDir(), 'brain');
    if (!existsSync(brainDir)) return [];
    const cutoff = opts.sinceMs ?? 0;
    const filter = opts.projectFilter?.toLowerCase();
    const out: SessionRef[] = [];

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

      let filePath = join(sessionPath, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(filePath)) {
        filePath = join(sessionPath, '.system_generated', 'logs', 'transcript_full.jsonl');
      }
      if (!existsSync(filePath)) continue;

      let stat;
      try { stat = statSync(filePath); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;

      const projectPath = extractProjectPathFromTranscript(filePath) || getFallbackProjectPath(this.homeDir());
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
            firstPrompt = rawText.slice(0, 200);
            break;
          }
        }
      } catch { /* ignore */ }

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
      const ts = tsIso ? Date.parse(tsIso) || located.mtime : located.mtime;

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
          const toolName = String(tc?.name || '');
          if (!toolName) continue;

          const toolUseId = `agy_tc_${toolUseCounter++}`;
          pendingToolCalls.push({ name: toolName, id: toolUseId });

          const cleanedArgs = cleanArgs(tc?.args);
          const command = toolName === 'run_command' && typeof (cleanedArgs as Record<string, unknown>)?.CommandLine === 'string'
            ? ((cleanedArgs as Record<string, unknown>).CommandLine as string)
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
    const brainDir = join(this.homeDir(), 'brain');
    if (!existsSync(brainDir)) return [];

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

      let filePath = join(sessionPath, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(filePath)) {
        filePath = join(sessionPath, '.system_generated', 'logs', 'transcript_full.jsonl');
      }
      if (!existsSync(filePath)) continue;

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

function extractProjectPathFromTranscript(path: string): string {
  try {
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj.source === 'USER_EXPLICIT' && obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
        const text = obj.content;
        const match = text.match(/format\s+\[URI\]\s*->\s*\[CorpusName\]:\s*\n?\s*([^\s\n]+)\s*->/);
        if (match && match[1]) {
          return match[1].trim();
        }
      }
    }
  } catch { /* ignore */ }
  return '';
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
