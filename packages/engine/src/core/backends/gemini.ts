/**
 * Gemini CLI backend. Owns ~/.gemini (overridable via CHAT_RECALL_GEMINI_HOME).
 *
 * Gemini sessions live under <home>/tmp/<sha256(projectPath)>/chats/, in two
 * formats: legacy `.json` (single blob with a `messages` array) and current
 * `.jsonl` (one event per line, first line is metadata).
 *
 * IDs are prefixed: 'gemini_<inner-uuid>'. The inner uuid is the file's
 * sessionId field, which usually matches the basename's trailing UUID
 * fragment but can diverge — `findSession` accepts both.
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join } from 'path';
import { geminiHomeDir } from '../tool-paths.js';

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

import {
  findGeminiSessionFile,
  readGeminiMessages,
} from '../live-session-scan.js';
import { computeOutcome } from '../session-outcome.js';
import { getSessionCommits } from '../session-git.js';
import {
  extractTurnsFromEvents,
  liveScanEditsFromEvents,
  replayFromEvents,
} from '../generic-engine.js';

const PREFIX = 'gemini_';

export class GeminiBackend implements ToolBackend {
  readonly id = 'gemini' as const;
  readonly idPrefix = PREFIX;
  readonly displayName = 'Gemini';

  homeDir(): string { return geminiHomeDir(); }

  // ── Subpath helpers ────────────────────────────────────────────
  tmpDir(): string { return join(this.homeDir(), 'tmp'); }
  projectsJson(): string { return join(this.homeDir(), 'projects.json'); }
  settingsFile(): string { return join(this.homeDir(), 'settings.json'); }
  extensionsDir(): string { return join(this.homeDir(), 'extensions'); }
  antigravityBrainDir(): string { return join(this.homeDir(), 'antigravity', 'brain'); }
  // Toolkit-artifact dirs. Gemini gained first-class Skills + Agents + (TOML)
  // Commands; all live directly under the home dir, mirroring Claude's layout.
  skillsDir(): string { return join(this.homeDir(), 'skills'); }
  commandsDir(): string { return join(this.homeDir(), 'commands'); }
  agentsDir(): string { return join(this.homeDir(), 'agents'); }

  isAvailable(): boolean {
    return existsSync(this.tmpDir());
  }

  // ── ID handling ────────────────────────────────────────────────
  matchesId(id: string): boolean { return id.startsWith(PREFIX); }
  toRawId(id: string): string { return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id; }
  toPrefixedId(rawId: string): string { return rawId.startsWith(PREFIX) ? rawId : PREFIX + rawId; }

  // ── Location ───────────────────────────────────────────────────
  findSession(id: string): SessionLocation | null {
    const located = findGeminiSessionFile(this.toRawId(id));
    if (!located) return null;
    let mtime = 0;
    try { mtime = statSync(located.path).mtimeMs; } catch { /* ignore */ }
    return {
      path: located.path,
      format: located.format,
      projectDir: located.projectDir,
      projectPath: located.projectPath,
      mtime,
    };
  }

  listSessions(opts: ListSessionsOpts = {}): SessionRef[] {
    const root = this.tmpDir();
    if (!existsSync(root)) return [];
    const projMap = this.loadProjectMap();
    const cutoff = opts.sinceMs ?? 0;
    const filter = opts.projectFilter?.toLowerCase();
    const out: SessionRef[] = [];

    for (const projDir of readdirSync(root, { withFileTypes: true })) {
      if (!projDir.isDirectory()) continue;
      const projectPath = projMap.get(projDir.name) || '';
      if (filter && !projectPath.toLowerCase().includes(filter)) continue;

      const chatsDir = join(root, projDir.name, 'chats');
      if (!existsSync(chatsDir)) continue;

      let files: string[];
      try { files = readdirSync(chatsDir); } catch { continue; }

      for (const f of files) {
        if (!f.startsWith('session-') || (!f.endsWith('.json') && !f.endsWith('.jsonl'))) continue;
        const fullPath = join(chatsDir, f);
        let stat;
        try { stat = statSync(fullPath); } catch { continue; }
        if (stat.mtimeMs < cutoff) continue;

        const format: 'json' | 'jsonl' = f.endsWith('.jsonl') ? 'jsonl' : 'json';
        const innerId = readSessionId(fullPath, format) || basename(f).replace(/\.jsonl?$/, '');
        const messages = readGeminiMessages(fullPath, format);
        const firstUser = messages.find((m: { type?: string; text?: string; content?: unknown }) => m.type === 'user');
        const firstPrompt = (typeof firstUser?.text === 'string' ? firstUser.text : flatten(firstUser?.content)).slice(0, 200);

        out.push({
          toolId: 'gemini',
          rawId: innerId,
          prefixedId: this.toPrefixedId(innerId),
          projectPath,
          projectDir: projDir.name,
          fullPath,
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          mtime: stat.mtimeMs,
          firstPrompt,
          messageCount: messages.length,
        });
      }
    }

    out.sort((a, b) => b.mtime - a.mtime);
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  // ── Generic-engine inputs ───────────────────────────────────────

  readonly fileToolMap: Record<string, EditOp> = {
    write_file:      'write',
    replace:         'edit',
    read_file:       'read',
    read_many_files: 'read',
  };

  /**
   * For Gemini, the diff lives inline:
   *   - replace:    { file_path, old_string, new_string }
   *   - write_file: { file_path, content }
   */
  extractEditDelta(toolName: string, input: unknown): EditDelta | null {
    if (input == null || typeof input !== 'object') return null;
    const inp = input as Record<string, unknown>;
    if (toolName === 'replace') {
      const before = typeof inp.old_string === 'string' ? inp.old_string
                  : typeof inp.oldString  === 'string' ? inp.oldString : null;
      const after  = typeof inp.new_string === 'string' ? inp.new_string
                  : typeof inp.newString  === 'string' ? inp.newString : null;
      if (before === null && after === null) return null;
      return { before, after };
    }
    if (toolName === 'write_file') {
      const after = typeof inp.content === 'string' ? inp.content : null;
      return { before: '', after };
    }
    return null;
  }

  /**
   * Read every gemini message into canonical events. Handles both the
   * legacy `.json` (single blob with `messages: []`) and the current
   * `.jsonl` (one event per line) — `readGeminiMessages` normalizes
   * both.
   */
  readEvents(rawId: string): CanonicalEvent[] {
    const located = findGeminiSessionFile(rawId);
    if (!located) return [];
    let mtime = 0;
    try { mtime = statSync(located.path).mtimeMs; } catch { /* ignore */ }

    const messages = readGeminiMessages(located.path, located.format);
    const events: CanonicalEvent[] = [];
    let lineNum = 0;

    for (const m of messages) {
      lineNum++;
      const tsIso = typeof m?.timestamp === 'string' ? m.timestamp : undefined;
      const ts = tsIso ? Date.parse(tsIso) || mtime : mtime;

      if (m?.type === 'user') {
        const text = (
          typeof m.text === 'string' ? m.text :
          Array.isArray(m.content) ? flatten(m.content) :
          typeof m.content === 'string' ? m.content : ''
        ).trim();
        if (text) events.push({ kind: 'user', ts, tsIso, line: lineNum, text });
      } else if (m?.type === 'gemini') {
        const text = (typeof m.text === 'string' ? m.text : flatten(m.content)).trim();
        if (text) events.push({ kind: 'assistant_text', ts, tsIso, line: lineNum, text });
        const tcs = Array.isArray(m.toolCalls) ? (m.toolCalls as any[]) : [];
        for (const tc of tcs) {
          const toolName = String(tc?.name || '');
          if (!toolName) continue;
          const id = String(tc?.id || '');
          events.push({
            kind: 'tool_use', ts, tsIso, line: lineNum,
            toolName, toolUseId: id, toolInput: tc?.args,
          });
          if (tc?.result !== undefined) {
            const body = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result);
            events.push({
              kind: 'tool_result', ts, tsIso, line: lineNum,
              toolUseId: id, toolName, resultBody: body,
              resultIsError: tc?.status === 'error',
              resultBytes: body.length,
            });
          }
        }
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
    const located = findGeminiSessionFile(this.toRawId(id));
    if (!located) {
      return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: 'gemini' };
    }
    let fileMtime = 0;
    try { fileMtime = statSync(located.path).mtimeMs; } catch { /* ignore */ }
    const events = this.readEvents(this.toRawId(id));
    return liveScanEditsFromEvents(events, this.fileToolMap, {
      sessionId: this.toPrefixedId(id),
      tool: 'gemini',
      projectPath: located.projectPath,
      projectDir: located.projectDir,
      fileMtime,
      found: true,
    });
  }

  replay(id: string): SessionDiffResult {
    const located = findGeminiSessionFile(this.toRawId(id));
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

  /**
   * Walk the gemini chats tree (both .json + .jsonl formats) and run
   * liveScanEdits on each transcript modified since `sinceMs`.
   */
  collectRecentEdits(opts: CollectRecentEditsOpts): SessionEdit[] {
    const tmpRoot = this.tmpDir();
    if (!existsSync(tmpRoot)) return [];
    const projMap = this.loadProjectMap();

    const candidates: { rawIdHint: string; mtime: number }[] = [];
    for (const proj of readdirSync(tmpRoot, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const projectPath = projMap.get(proj.name) || '';
      if (opts.projectFilter) {
        const haystack = (projectPath + ' ' + proj.name).toLowerCase();
        if (!haystack.includes(opts.projectFilter.toLowerCase())) continue;
      }
      const chats = join(tmpRoot, proj.name, 'chats');
      if (!existsSync(chats)) continue;
      let files: string[];
      try { files = readdirSync(chats); } catch { continue; }
      for (const f of files) {
        if (!f.startsWith('session-')) continue;
        const isJsonl = f.endsWith('.jsonl');
        const isJson = !isJsonl && f.endsWith('.json');
        if (!isJsonl && !isJson) continue;
        try {
          const st = statSync(join(chats, f));
          if (st.mtimeMs < opts.sinceMs) continue;
          const trimLen = isJsonl ? 6 : 5;
          // findGeminiSessionFile resolves either the file basename
          // (e.g. 'session-2026-…-de4e8d4c') or the inner sessionId.
          candidates.push({ rawIdHint: f.slice(0, -trimLen), mtime: st.mtimeMs });
        } catch { /* skip */ }
      }
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    const limited = opts.limitSessions ? candidates.slice(0, opts.limitSessions) : candidates;

    const edits: SessionEdit[] = [];
    for (const c of limited) {
      const scan = this.liveScanEdits(c.rawIdHint);
      edits.push(...scan.edits);
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
    // git-layer is tool-agnostic — pass the prefixed id straight through
    return getSessionCommits(this.toPrefixedId(id), files, startMs, endMs, bufferMinutes);
  }

  // ── Internals ──────────────────────────────────────────────────
  /** Map sha256(projectPath) → projectPath using ~/.gemini/projects.json. */
  private loadProjectMap(): Map<string, string> {
    const map = new Map<string, string>();
    const path = this.projectsJson();
    if (!existsSync(path)) return map;
    try {
      const json = JSON.parse(readFileSync(path, 'utf-8'));
      const projects = json?.projects ?? {};
      for (const projectPath of Object.keys(projects)) {
        const hash = createHash('sha256').update(projectPath).digest('hex');
        map.set(hash, projectPath);
      }
    } catch { /* projects.json malformed — empty map is fine */ }
    return map;
  }
  exportRawSession(id: string): RawSessionExport | null {
    const loc = this.findSession(id);
    if (!loc) return null;
    try {
      return {
        tool: 'gemini',
        mtime: statSync(loc.path).mtimeMs,
        files: [{ name: basename(loc.path), bytes: readFileSync(loc.path) }],
      };
    } catch { return null; }
  }
}

export const geminiBackend = new GeminiBackend();

// ── Local helpers ────────────────────────────────────────────────────

function readSessionId(path: string, format: 'json' | 'jsonl'): string | null {
  try {
    if (format === 'json') {
      const json = JSON.parse(readFileSync(path, 'utf-8'));
      return typeof json?.sessionId === 'string' ? json.sessionId : null;
    }
    const head = readFileSync(path, 'utf-8').split('\n', 1)[0] || '';
    const meta = JSON.parse(head);
    return typeof meta?.sessionId === 'string' ? meta.sessionId : null;
  } catch { return null; }
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((seg) => {
      if (typeof seg === 'string') return seg;
      if (seg && typeof seg === 'object' && typeof (seg as { text?: string }).text === 'string') {
        return (seg as { text: string }).text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
