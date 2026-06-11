/**
 * Claude Code backend. Owns ~/.claude (overridable via CHAT_RECALL_CLAUDE_HOME).
 *
 * Claude session ids are bare UUIDs — there is no string prefix. Sessions
 * live as JSONL transcripts under <home>/projects/<encoded-project>/<uuid>.jsonl,
 * with optional sibling subagents/<id>.jsonl files for /explore-style splits.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { claudeHomeDir, claudeProjectDirs } from '../tool-paths.js';

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
} from '../tool-backend.js';
import type { ExtractedTurns } from '../session-turns.js';
import type { SessionDiffResult } from '../session-replay.js';
import type { SessionOutcome } from '../session-outcome.js';
import type { SessionCommitsResult } from '../session-git.js';
import type { EditOp, SessionEdit } from '../live-session-scan.js';

import { findSessionFile, resolveSessionContentPaths } from '../live-session-scan.js';
import { computeOutcome } from '../session-outcome.js';
import { getSessionCommits } from '../session-git.js';
import { extractFirstUserPromptSync } from '../first-prompt.js';
import {
  extractTurnsFromEvents,
  liveScanEditsFromEvents,
  replayFromEvents,
} from '../generic-engine.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ClaudeBackend implements ToolBackend {
  readonly id = 'claude' as const;
  readonly idPrefix = '';
  readonly displayName = 'Claude';

  homeDir(): string { return claudeHomeDir(); }

  // ── Subpath helpers used by the parser/source layer ─────────────
  projectsDir(): string { return join(this.homeDir(), 'projects'); }
  plansDir(): string { return join(this.homeDir(), 'plans'); }
  todosDir(): string { return join(this.homeDir(), 'todos'); }
  /** Legacy task-list directory still used by older Claude Code releases. */
  tasksDir(): string { return join(this.homeDir(), 'tasks'); }
  pasteCacheDir(): string { return join(this.homeDir(), 'paste-cache'); }
  skillsDir(): string { return join(this.homeDir(), 'skills'); }
  agentsDir(): string { return join(this.homeDir(), 'agents'); }
  commandsDir(): string { return join(this.homeDir(), 'commands'); }
  pluginsManifestPath(): string { return join(this.homeDir(), 'plugins', 'installed_plugins.json'); }
  hooksFile(): string { return join(this.homeDir(), 'hooks.json'); }
  settingsFile(): string { return join(this.homeDir(), 'settings.json'); }
  historyFile(): string { return join(this.homeDir(), 'history.jsonl'); }

  isAvailable(): boolean {
    return existsSync(this.projectsDir());
  }

  // ── ID handling ────────────────────────────────────────────────
  /**
   * Claude IDs are bare UUIDs. We don't need to reject sibling-tool
   * prefixes here — `getBackendForId` tries every prefixed backend
   * first, and only falls through to Claude when none match. So this
   * matcher only sees non-prefixed inputs.
   */
  matchesId(id: string): boolean {
    return UUID_RE.test(id);
  }
  toRawId(id: string): string { return id; }
  toPrefixedId(rawId: string): string { return rawId; }

  // ── Location ───────────────────────────────────────────────────
  findSession(id: string): SessionLocation | null {
    const located = findSessionFile(this.toRawId(id));
    if (!located) return null;
    let mtime = 0;
    try { mtime = statSync(located.path).mtimeMs; } catch { /* ignore */ }
    return {
      path: located.path,
      format: 'jsonl',
      projectDir: located.projectDir,
      projectPath: located.projectPath,
      mtime,
    };
  }

  listSessions(opts: ListSessionsOpts = {}): SessionRef[] {
    const cutoff = opts.sinceMs ?? 0;
    const filter = opts.projectFilter?.toLowerCase();
    const seen = new Set<string>();
    const out: SessionRef[] = [];

    // All configured homes (~/.claude, ~/.claude-* profiles, CLAUDE_DIRS) —
    // same set the indexer scans, so index and sync stay consistent.
    for (const root of claudeProjectDirs()) {
      this.collectSessionsFromRoot(root, cutoff, filter, seen, out);
    }

    out.sort((a, b) => b.mtime - a.mtime);
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  private collectSessionsFromRoot(
    root: string,
    cutoff: number,
    filter: string | undefined,
    seen: Set<string>,
    out: SessionRef[],
  ): void {
    if (!existsSync(root)) return;

    for (const proj of readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      if (filter && !proj.name.toLowerCase().includes(filter)) continue;
      const projPath = join(root, proj.name);
      const projectPath = proj.name.replace(/-/g, '/').replace(/^\//, '/');

      // Prefer the indexer's sessions-index.json shortcut when present —
      // it carries pre-computed first-prompt + messageCount so we skip
      // re-reading every transcript header.
      const indexPath = join(projPath, 'sessions-index.json');
      if (existsSync(indexPath)) {
        try {
          const indexData = JSON.parse(readFileSync(indexPath, 'utf-8'));
          const entries = (indexData.entries || []) as Array<{
            sessionId: string;
            fullPath: string;
            projectPath?: string;
            created?: string;
            modified?: string;
            fileMtime?: number;
            firstPrompt?: string;
            messageCount?: number;
          }>;
          for (const entry of entries) {
            if (!entry.fullPath || !existsSync(entry.fullPath)) continue;
            if ((entry.fileMtime ?? 0) < cutoff) continue;
            seen.add(entry.sessionId);
            out.push({
              toolId: 'claude',
              rawId: entry.sessionId,
              prefixedId: entry.sessionId,
              projectPath: entry.projectPath || projectPath,
              projectDir: proj.name,
              fullPath: entry.fullPath,
              created: entry.created || '',
              modified: entry.modified || '',
              mtime: entry.fileMtime || 0,
              firstPrompt: entry.firstPrompt || '',
              messageCount: entry.messageCount || 0,
            });
          }
        } catch { /* malformed index — fall through to direct walk */ }
      }

      // Direct walk for any .jsonl not covered by the index.
      let files: string[];
      try { files = readdirSync(projPath); } catch { continue; }

      for (const f of files) {
        if (!f.endsWith('.jsonl') || f === 'sessions-index.json') continue;
        const sessionId = basename(f, '.jsonl');
        if (seen.has(sessionId)) continue;
        const fullPath = join(projPath, f);
        let stat;
        try { stat = statSync(fullPath); } catch { continue; }
        if (stat.mtimeMs < cutoff) continue;
        const firstPrompt = extractFirstUserPromptSync(fullPath, { maxLength: 200 });

        out.push({
          toolId: 'claude',
          rawId: sessionId,
          prefixedId: sessionId,
          projectPath,
          projectDir: proj.name,
          fullPath,
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          mtime: stat.mtimeMs,
          firstPrompt,
          messageCount: 0,
        });
      }
    }
  }

  // ── Generic-engine inputs ───────────────────────────────────────

  /** Tool-call name → EditOp. Anything else is treated as non-file-touching. */
  readonly fileToolMap: Record<string, EditOp> = {
    Edit:         'edit',
    Write:        'write',
    MultiEdit:    'multi_edit',
    NotebookEdit: 'notebook_edit',
    Read:         'read',
  };

  /**
   * For Claude, the diff is carried inline in the tool input:
   *   - Edit:  { file_path, old_string, new_string, replace_all? }
   *   - Write: { file_path, content }
   *
   * MultiEdit (multiple sequential edits) and NotebookEdit (cell-level)
   * carry richer shapes; we leave them to the legacy replay path until
   * the generic engine grows multi-stage diff support.
   */
  extractEditDelta(toolName: string, input: unknown): EditDelta | null {
    if (input == null || typeof input !== 'object') return null;
    const inp = input as Record<string, unknown>;
    if (toolName === 'Edit') {
      const before = typeof inp.old_string === 'string' ? inp.old_string : null;
      const after  = typeof inp.new_string === 'string' ? inp.new_string : null;
      if (before === null && after === null) return null;
      return { before, after };
    }
    if (toolName === 'Write') {
      const after = typeof inp.content === 'string' ? inp.content : null;
      return { before: '', after }; // Write replaces the file wholesale
    }
    return null;
  }

  /**
   * Stream every line of the session's JSONL transcript into canonical
   * events. Handles:
   *   - type='user'      → 'user' event (skipping system reminders) plus
   *                        any embedded tool_result blocks
   *   - type='assistant' → 'assistant_text' for text parts, 'tool_use'
   *                        for tool invocations
   *
   * Walks subagent transcripts (via resolveSessionContentPaths) so /explore
   * splits show up alongside the parent.
   */
  readEvents(rawId: string): CanonicalEvent[] {
    const located = findSessionFile(rawId);
    if (!located) return [];
    const paths = resolveSessionContentPaths(located.path);
    const events: CanonicalEvent[] = [];
    let lineNum = 0;

    for (const filePath of paths) {
      let mtime = 0;
      try { mtime = statSync(filePath).mtimeMs; } catch { /* ignore */ }
      let raw: string;
      try { raw = readFileSync(filePath, 'utf-8'); } catch { continue; }

      for (const line of raw.split('\n')) {
        lineNum++;
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(line); } catch { continue; }

        const tsIso = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;
        const ts = tsIso ? Date.parse(tsIso) || mtime : mtime;

        if (obj.type === 'user') {
          const msg = obj.message as Record<string, unknown> | undefined;
          const content = msg?.content;
          let text = '';
          const toolResults: Array<{ id: string; body: string; isError: boolean }> = [];
          if (typeof content === 'string') text = content;
          else if (Array.isArray(content)) {
            for (const item of content) {
              if (!item || typeof item !== 'object') continue;
              const it = item as Record<string, unknown>;
              if (it.type === 'text' && typeof it.text === 'string') {
                text += (text ? '\n' : '') + it.text;
              } else if (it.type === 'tool_result') {
                const id = typeof it.tool_use_id === 'string' ? it.tool_use_id : '';
                let body = '';
                const c = it.content;
                if (typeof c === 'string') body = c;
                else if (Array.isArray(c)) {
                  for (const sub of c) {
                    if (sub && typeof sub === 'object' && (sub as Record<string, unknown>).type === 'text') {
                      const t = (sub as Record<string, unknown>).text;
                      if (typeof t === 'string') body += t;
                    }
                  }
                }
                toolResults.push({ id, body, isError: it.is_error === true });
              }
            }
          }
          if (text && !text.includes('<system-reminder>')) {
            events.push({ kind: 'user', ts, tsIso, line: lineNum, text });
          }
          for (const tr of toolResults) {
            events.push({
              kind: 'tool_result', ts, tsIso, line: lineNum,
              toolUseId: tr.id, resultBody: tr.body, resultIsError: tr.isError,
              resultExitCode: parseExitCode(tr.body),
              resultBytes: tr.body.length,
            });
          }
        } else if (obj.type === 'summary') {
          // Claude writes session-summary entries at the top of long
          // transcripts. Surface them as a canonical 'summary' event so
          // recall_show / recall_context can render them.
          const summary = typeof obj.summary === 'string' ? obj.summary : '';
          if (summary) {
            events.push({ kind: 'summary', ts, tsIso, line: lineNum, text: summary });
          }
        } else if (obj.type === 'assistant') {
          const msg = obj.message as Record<string, unknown> | undefined;
          const content = msg?.content;
          if (!Array.isArray(content)) continue;
          for (const item of content) {
            if (!item || typeof item !== 'object') continue;
            const it = item as Record<string, unknown>;
            if (it.type === 'text' && typeof it.text === 'string' && it.text.trim()) {
              events.push({ kind: 'assistant_text', ts, tsIso, line: lineNum, text: it.text });
            } else if (it.type === 'tool_use') {
              const toolName = typeof it.name === 'string' ? it.name : '';
              const id = typeof it.id === 'string' ? it.id : '';
              const command = toolName === 'Bash' && typeof (it.input as Record<string, unknown>)?.command === 'string'
                ? ((it.input as Record<string, unknown>).command as string)
                : undefined;
              events.push({
                kind: 'tool_use', ts, tsIso, line: lineNum,
                toolName, toolUseId: id, toolInput: it.input,
                command,
              });
            }
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
    const rawId = this.toRawId(id);
    const located = findSessionFile(rawId);
    if (!located) {
      return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: 'claude' };
    }
    const events = this.readEvents(rawId);
    let fileMtime = 0;
    try { fileMtime = statSync(located.path).mtimeMs; } catch { /* ignore */ }
    return liveScanEditsFromEvents(events, this.fileToolMap, {
      sessionId: rawId,
      tool: 'claude',
      projectPath: located.projectPath,
      projectDir: located.projectDir,
      fileMtime,
      found: true,
    });
  }

  replay(id: string): SessionDiffResult {
    const rawId = this.toRawId(id);
    const located = findSessionFile(rawId);
    if (!located) {
      return { sessionId: rawId, found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };
    }
    const events = this.readEvents(rawId);
    return replayFromEvents(rawId, events, this.fileToolMap, this.extractEditDelta.bind(this), {
      projectPath: located.projectPath,
      found: true,
    });
  }

  computeOutcome(id: string, opts?: { commitBufferMinutes?: number }): SessionOutcome {
    return computeOutcome(this.toRawId(id), opts);
  }

  /**
   * Walk the projects tree, collect rollups whose own mtime OR any
   * subagent transcript's mtime is past `sinceMs`, run liveScanEdits
   * on each. Subagent mtime is folded into the parent so a session
   * with quiet main + active subagents still surfaces.
   */
  collectRecentEdits(opts: CollectRecentEditsOpts): SessionEdit[] {
    const candidates: { rawId: string; mtime: number }[] = [];
    for (const root of claudeProjectDirs()) {
      if (!existsSync(root)) continue;
      for (const projEntry of readdirSync(root, { withFileTypes: true })) {
        if (!projEntry.isDirectory()) continue;
        if (opts.projectFilter && !projEntry.name.toLowerCase().includes(opts.projectFilter.toLowerCase())) continue;
        const projPath = join(root, projEntry.name);
        let files: string[];
        try { files = readdirSync(projPath); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith('.jsonl') || f === 'sessions-index.json') continue;
          const fp = join(projPath, f);
          try {
            const st = statSync(fp);
            let mtime = st.mtimeMs;
            const subDir = join(projPath, f.slice(0, -6), 'subagents');
            if (existsSync(subDir)) {
              for (const sub of readdirSync(subDir)) {
                try {
                  const subSt = statSync(join(subDir, sub));
                  if (subSt.mtimeMs > mtime) mtime = subSt.mtimeMs;
                } catch { /* ignore */ }
              }
            }
            if (mtime < opts.sinceMs) continue;
            candidates.push({ rawId: basename(f, '.jsonl'), mtime });
          } catch { /* skip */ }
        }
      }
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    const limited = opts.limitSessions ? candidates.slice(0, opts.limitSessions) : candidates;

    const edits: SessionEdit[] = [];
    for (const c of limited) {
      const scan = this.liveScanEdits(c.rawId);
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
    return getSessionCommits(this.toRawId(id), files, startMs, endMs, bufferMinutes);
  }
}

/** Extract `exit code: N` from a tool result body. */
function parseExitCode(text: string): number | undefined {
  const m = text.match(/(?:^|\n)\s*(?:exit\s+code|returncode|exit\s+status|exit)\s*[:=]\s*(\d+)\b/i);
  return m ? Number(m[1]) : undefined;
}

export const claudeBackend = new ClaudeBackend();
