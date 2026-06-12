/**
 * Codex backend. Owns ~/.codex (overridable via CHAT_RECALL_CODEX_HOME).
 *
 * Codex sessions live as JSONL "rollouts" under <home>/sessions/YYYY/MM/DD/.
 * Each rollout opens with a `session_meta` event; subagent rollouts carry
 * `agent_role` or `agent_nickname` and link to a parent via
 * `payload.source.subagent.thread_spawn.parent_thread_id`.
 *
 * IDs are prefixed: 'codex_<session-uuid>'.
 */

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { basename, dirname, join } from 'path';
import { codexHomeDir } from '../tool-paths.js';

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

import { findCodexSessionFile } from '../live-session-scan.js';
import { createPatch } from 'diff';
import type { FileReplayResult } from '../session-replay.js';
import { computeOutcome } from '../session-outcome.js';
import { getSessionCommits } from '../session-git.js';
import {
  extractTurnsFromEvents,
  liveScanEditsFromEvents,
  replayFromEvents,
} from '../generic-engine.js';

const PREFIX = 'codex_';

export class CodexBackend implements ToolBackend {
  readonly id = 'codex' as const;
  readonly idPrefix = PREFIX;
  readonly displayName = 'Codex';

  homeDir(): string { return codexHomeDir(); }

  // ── Subpath helpers ────────────────────────────────────────────
  sessionsDir(): string { return join(this.homeDir(), 'sessions'); }
  configToml(): string { return join(this.homeDir(), 'config.toml'); }
  pluginsDir(): string { return join(this.homeDir(), '.tmp', 'plugins', 'plugins'); }
  skillsSystemDir(): string { return join(this.homeDir(), 'skills', '.system'); }

  isAvailable(): boolean { return existsSync(this.sessionsDir()); }

  // ── ID handling ────────────────────────────────────────────────
  matchesId(id: string): boolean { return id.startsWith(PREFIX); }
  toRawId(id: string): string { return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id; }
  toPrefixedId(rawId: string): string { return rawId.startsWith(PREFIX) ? rawId : PREFIX + rawId; }

  // ── Location ───────────────────────────────────────────────────
  findSession(id: string): SessionLocation | null {
    const located = findCodexSessionFile(this.toRawId(id));
    if (!located) return null;
    let mtime = 0;
    try { mtime = statSync(located.path).mtimeMs; } catch { /* ignore */ }
    return {
      path: located.path,
      format: 'jsonl',
      projectDir: '',
      projectPath: located.projectPath,
      mtime,
    };
  }

  listSessions(opts: ListSessionsOpts = {}): SessionRef[] {
    const root = this.sessionsDir();
    if (!existsSync(root)) return [];
    const cutoff = opts.sinceMs ?? 0;
    const filter = opts.projectFilter?.toLowerCase();
    const out: SessionRef[] = [];

    for (const filePath of walkRollouts(root)) {
      let stat;
      try { stat = statSync(filePath); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;

      const meta = readFirstLine(filePath);
      if (!meta || meta.type !== 'session_meta' || !meta.payload) continue;
      const payload = meta.payload as {
        id?: string;
        cwd?: string;
        agent_role?: string;
        agent_nickname?: string;
      };
      // Skip sub-agent rollouts — they're internal to a parent's run.
      if (payload.agent_role || payload.agent_nickname) continue;

      const rawId = payload.id || basename(filePath).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
      const projectPath = payload.cwd || '';
      if (filter && !projectPath.toLowerCase().includes(filter)) continue;

      // First user prompt + message count
      let firstPrompt = '';
      let messageCount = 0;
      try {
        const lines = readFileSync(filePath, 'utf-8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: { type?: string; payload?: { type?: string; message?: string; role?: string } };
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'event_msg' && ev.payload?.type === 'user_message') {
            messageCount++;
            if (!firstPrompt && ev.payload.message) {
              firstPrompt = String(ev.payload.message).slice(0, 200);
            }
          } else if (ev.type === 'response_item' && ev.payload?.type === 'message') {
            messageCount++;
          }
        }
      } catch { /* unreadable — leave defaults */ }

      out.push({
        toolId: 'codex',
        rawId,
        prefixedId: this.toPrefixedId(rawId),
        projectPath,
        projectDir: '',
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

  /**
   * Codex mutates files via two distinct tool_use shapes:
   *   - `apply_patch` — args.input is a unified patch text covering one or
   *     more files (`*** Add/Update/Delete File: <path>` headers).
   *   - `shell` / `exec_command` / `local_shell` — files are written via
   *     embedded heredoc patterns (`cat > foo <<EOF…EOF`,
   *     `apply_patch '<<…'`, `tee` redirects, etc.). `parseShellWrites`
   *     extracts those.
   *
   * All map to 'edit' since the engine treats them as mutating ops; the
   * actual diff comes from `extractEditDelta` below.
   */
  readonly fileToolMap: Record<string, EditOp> = {
    apply_patch:   'edit',
    shell:         'edit',
    exec_command:  'edit',
    local_shell:   'edit',
  };

  /**
   * Multi-file delta for codex tools. `apply_patch` carries a unified
   * patch covering many files in one tool_use; the shell tools may write
   * files via heredoc. Both produce a list of per-file (before, after)
   * pairs the generic engine can accumulate.
   *
   * For `update` patches we don't have full file content — we only have
   * the +/- lines from the patch body. We synthesize before/after strings
   * from those lines: a diff between them reproduces the exact
   * linesAdded/linesRemoved counts the original patch carried.
   */
  extractEditDelta(toolName: string, input: unknown): EditDelta | null {
    if (input == null || typeof input !== 'object') return null;
    const inp = input as Record<string, unknown>;

    if (toolName === 'apply_patch') {
      const patchText = typeof inp.input === 'string' ? inp.input : '';
      if (!patchText) return null;
      return { perFile: codexPatchToDeltas(patchText) };
    }

    if (toolName === 'shell' || toolName === 'exec_command' || toolName === 'local_shell') {
      // Codex versions vary: some store `command`, others `cmd`. Both can be
      // a string or an argv array.
      const raw = inp.command ?? inp.cmd;
      const cmd = Array.isArray(raw) ? (raw as string[]).join(' ')
                : typeof raw === 'string' ? raw
                : '';
      if (!cmd) return null;

      // Special-case: `apply_patch <<EOF…EOF` shell commands carry a unified
      // patch we can fully decode (parseShellWrites would lose the +/- lines
      // for update sections, since its `content` field only captures full
      // file bodies). Pull the heredoc body and feed it to codexPatchToDeltas
      // so update/delete sections report correct line counts.
      const firstLine = cmd.split('\n', 1)[0].trim();
      const heredocMatch = cmd.match(/<<['"]?(\w+)['"]?\n([\s\S]*?)\n\1\b/);
      if (/^apply_patch\b/.test(firstLine) && heredocMatch) {
        return { perFile: codexPatchToDeltas(heredocMatch[2]) };
      }

      // General path: cat-redirect / tee / sed shell writes.
      const writes = parseShellWrites(cmd);
      if (writes.length === 0) return null;
      return {
        perFile: writes.map(w => ({
          file: w.file,
          before: w.kind === 'write' ? '' : null,
          after: typeof w.content === 'string' ? w.content : null,
        })),
      };
    }

    return null;
  }

  /**
   * Stream a Codex JSONL rollout into canonical events. Codex separates:
   *   - event_msg + payload.type='user_message'        → user
   *   - response_item + payload.type='message'         → assistant_text
   *   - response_item + payload.type='function_call'   → tool_use
   *   - response_item + payload.type='function_call_output' → tool_result
   *
   * Filters Codex's wrapper-bearing user messages (environment_context etc.).
   *
   * **Subagent fan-out:** Codex orchestrates work via `spawn_agent` calls
   * that produce sibling rollout files in the same YYYY/MM/DD directory.
   * Sub-agent rollouts carry `payload.source.subagent.thread_spawn` linking
   * back to the parent. The actual file edits often happen inside those
   * subagent rollouts — without folding their events into the parent's
   * stream, replay/scan would see the parent as edit-free. We append every
   * subagent rollout's events here so the generic engine sees one unified
   * stream per user-facing session.
   */
  readEvents(rawId: string): CanonicalEvent[] {
    const located = findCodexSessionFile(this.toRawId(rawId));
    if (!located) return [];
    const parentUuid = this.toRawId(rawId);

    // 1. Parent rollout
    const events = this.parseRollout(located.path);

    // 2. Subagent rollouts — siblings in the same day-dir whose
    // `thread_spawn.parent_thread_id` matches parentUuid.
    const dayDir = located.path.substring(0, located.path.lastIndexOf('/'));
    let entries: string[] = [];
    try { entries = readdirSync(dayDir); } catch { /* day-dir gone */ }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl') || !entry.startsWith('rollout-')) continue;
      const path = `${dayDir}/${entry}`;
      if (path === located.path) continue;
      let firstLine = '';
      try { firstLine = readFileSync(path, 'utf-8').split('\n', 1)[0] || ''; } catch { continue; }
      if (!firstLine) continue;
      let meta: { payload?: { source?: { subagent?: { thread_spawn?: { parent_thread_id?: string } } } } };
      try { meta = JSON.parse(firstLine); } catch { continue; }
      const spawn = meta?.payload?.source?.subagent?.thread_spawn;
      if (!spawn || spawn.parent_thread_id !== parentUuid) continue;
      events.push(...this.parseRollout(path));
    }

    return events;
  }

  /** Parse one rollout JSONL file into canonical events. */
  private parseRollout(path: string): CanonicalEvent[] {
    let raw = '';
    let mtime = 0;
    try { raw = readFileSync(path, 'utf-8'); mtime = statSync(path).mtimeMs; }
    catch { return []; }

    const events: CanonicalEvent[] = [];
    let lineNum = 0;

    for (const line of raw.split('\n')) {
      lineNum++;
      if (!line.trim()) continue;
      let obj: any; try { obj = JSON.parse(line); } catch { continue; }

      const tsIso = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;
      const ts = tsIso ? Date.parse(tsIso) || mtime : mtime;
      const payload = obj.payload || {};

      if (obj.type === 'event_msg' && payload.type === 'user_message') {
        const text = String(payload.message || '').trim();
        if (text && !isCodexInjectedWrapper(text)) {
          events.push({ kind: 'user', ts, tsIso, line: lineNum, text });
        }
      } else if (obj.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
        const text = flattenContent(payload.content).trim();
        if (text) events.push({ kind: 'assistant_text', ts, tsIso, line: lineNum, text });
      } else if (obj.type === 'response_item' && payload.type === 'function_call') {
        const toolName = String(payload.name || '');
        const callId = String(payload.call_id || '');
        let args: any = payload.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep string */ } }
        const command = (toolName === 'shell' || toolName === 'exec_command' || toolName === 'local_shell')
          ? (() => {
              const raw = args?.command ?? args?.cmd;
              return Array.isArray(raw) ? raw.join(' ') : String(raw ?? '');
            })()
          : undefined;
        events.push({
          kind: 'tool_use', ts, tsIso, line: lineNum,
          toolName, toolUseId: callId, toolInput: args, command,
        });
      } else if (obj.type === 'response_item' && payload.type === 'function_call_output') {
        const callId = String(payload.call_id || '');
        const out = payload.output;
        let body = '';
        let isError = false;
        let exitCode: number | undefined;
        if (typeof out === 'string') body = out;
        else if (out && typeof out === 'object') {
          body = String(out.content ?? out.output ?? out.stdout ?? out.text ?? '');
          if (typeof out.exit_code === 'number') {
            exitCode = out.exit_code;
            isError = exitCode !== 0;
          }
        }
        events.push({
          kind: 'tool_result', ts, tsIso, line: lineNum,
          toolUseId: callId, resultBody: body,
          resultIsError: isError, resultExitCode: exitCode,
          resultBytes: body.length,
        });
      }
    }
    return events;
  }

  // ── Per-session operations ─────────────────────────────────────

  extractTurns(id: string, opts: ExtractTurnsOpts = {}): ExtractedTurns {
    const events = this.readEvents(this.toRawId(id));
    return extractTurnsFromEvents(this.toPrefixedId(id), events, opts);
  }

  liveScanEdits(id: string): LiveScanEditsResult {
    const located = findCodexSessionFile(this.toRawId(id));
    if (!located) {
      return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: 'codex' };
    }
    const events = this.readEvents(this.toRawId(id));
    let fileMtime = 0;
    try { fileMtime = statSync(located.path).mtimeMs; } catch { /* ignore */ }
    // Pass extractEditDelta so the engine can enumerate apply_patch's
    // multi-file payload and shell-heredoc writes.
    return liveScanEditsFromEvents(events, this.fileToolMap, {
      sessionId: this.toPrefixedId(id),
      tool: 'codex',
      projectPath: located.projectPath,
      projectDir: '',
      fileMtime,
      found: true,
    }, this.extractEditDelta.bind(this));
  }

  replay(id: string): SessionDiffResult {
    const located = findCodexSessionFile(this.toRawId(id));
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
   * Walk YYYY/MM/DD/ rollouts and emit recent file edits.
   *
   * Sub-agent rollouts (carrying `agent_role`/`agent_nickname` or a
   * `thread_spawn.parent_thread_id`) are skipped here — their events are
   * already merged into the parent's stream by `readEvents`. Walking
   * subagents separately would double-count edits that came from
   * spawn-and-orchestrate flows.
   *
   * To preserve "fresh subagent → surface the parent" behavior, each
   * parent's effective mtime is bumped to max(self, subagents). A
   * session whose parent rollout went idle but whose subagents kept
   * touching files still passes the `sinceMs` cutoff.
   */
  collectRecentEdits(opts: CollectRecentEditsOpts): SessionEdit[] {
    const root = this.sessionsDir();
    if (!existsSync(root)) return [];

    interface RolloutMeta {
      rawId: string;
      mtime: number;
      projectPath: string;
      parentId: string | null;
    }
    const parents: RolloutMeta[] = [];
    const subagentMtimeByParent = new Map<string, number>();

    const scanDir = (dir: string): void => {
      let entries: import('fs').Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          scanDir(join(dir, entry.name));
          continue;
        }
        if (!entry.name.endsWith('.jsonl')) continue;
        const p = join(dir, entry.name);
        let st: import('fs').Stats;
        try { st = statSync(p); } catch { continue; }
        const uuidMatch = entry.name.match(/([a-f0-9-]{36})\.jsonl$/);
        const rawId = uuidMatch ? uuidMatch[1] : '';
        if (!rawId) continue;

        // First-line metadata: cwd + sub-agent detection.
        let projectPath = '';
        let parentId: string | null = null;
        let isSubagent = false;
        try {
          const first = readFileSync(p, 'utf-8').split('\n')[0];
          if (first) {
            const meta = JSON.parse(first);
            const payload = meta?.payload || {};
            projectPath = payload.cwd || '';
            const spawn = payload.source?.subagent?.thread_spawn;
            if (spawn || payload.agent_role || payload.agent_nickname) {
              isSubagent = true;
              parentId = spawn?.parent_thread_id || null;
            }
          }
        } catch { /* ignore */ }

        if (isSubagent) {
          // Bump parent's effective mtime; don't walk this rollout.
          if (parentId) {
            const prev = subagentMtimeByParent.get(parentId) ?? 0;
            if (st.mtimeMs > prev) subagentMtimeByParent.set(parentId, st.mtimeMs);
          }
          continue;
        }

        if (opts.projectFilter && !projectPath.toLowerCase().includes(opts.projectFilter.toLowerCase())) continue;
        parents.push({ rawId, mtime: st.mtimeMs, projectPath, parentId: null });
      }
    };
    scanDir(root);

    // Apply sinceMs filter using the bumped mtime so a fresh subagent
    // surfaces its parent.
    const fresh = parents.filter(p => {
      const eff = Math.max(p.mtime, subagentMtimeByParent.get(p.rawId) ?? 0);
      return eff >= opts.sinceMs;
    });
    fresh.sort((a, b) => {
      const aEff = Math.max(a.mtime, subagentMtimeByParent.get(a.rawId) ?? 0);
      const bEff = Math.max(b.mtime, subagentMtimeByParent.get(b.rawId) ?? 0);
      return bEff - aEff;
    });
    const limited = opts.limitSessions ? fresh.slice(0, opts.limitSessions) : fresh;

    const edits: SessionEdit[] = [];
    for (const c of limited) {
      // liveScanEdits → readEvents which fans out across subagents,
      // so each parent walk emits parent + subagent edits exactly once.
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
    return getSessionCommits(this.toPrefixedId(id), files, startMs, endMs, bufferMinutes);
  }
  exportRawSession(id: string): RawSessionExport | null {
    const loc = this.findSession(id);
    if (!loc) return null;
    const files: RawSessionExport['files'] = [];
    let mtime = 0;
    const push = (path: string, name: string) => {
      try {
        const st = statSync(path);
        files.push({ name, bytes: readFileSync(path) });
        if (st.mtimeMs > mtime) mtime = st.mtimeMs;
      } catch { /* skip unreadable part */ }
    };
    push(loc.path, basename(loc.path));
    // Sibling sub-agent rollouts: same day-dir, first-line session_meta
    // whose thread_spawn.parent_thread_id names this session.
    const parentId = basename(loc.path).match(/([a-f0-9-]{36})\.jsonl$/i)?.[1];
    if (parentId) {
      const dayDir = dirname(loc.path);
      try {
        for (const f of readdirSync(dayDir)) {
          if (!f.endsWith('.jsonl') || !f.startsWith('rollout-')) continue;
          const p = join(dayDir, f);
          if (p === loc.path) continue;
          try {
            const fd = openSync(p, 'r');
            const buf = Buffer.alloc(4096);
            const n = readSync(fd, buf, 0, 4096, 0);
            closeSync(fd);
            const head = buf.toString('utf-8', 0, n);
            if (head.includes(parentId) && head.includes('parent_thread_id')) push(p, `subagents/${f}`);
          } catch { /* skip */ }
        }
      } catch { /* day dir unreadable */ }
    }
    return files.length > 0 ? { tool: 'codex', mtime, files } : null;
  }
}

export const codexBackend = new CodexBackend();

// ── Codex apply_patch replay (multi-file unified-diff, doesn't fit the generic engine's per-file model) ─

/**
 * Heuristic shell-command parser that extracts file writes Codex
 * sub-agents emit. Recognized patterns:
 *   sed -i [-e] '…' /path/file        → edit
 *   cat   > /path/file [<<'EOF' …EOF] → write (heredoc captures content)
 *   cat  >> /path/file [<<'EOF' …EOF] → edit
 *   tee  [-a] /path/file [<<'EOF']    → write/edit
 *   printf …  >  /path/file           → write
 *   printf … >> /path/file            → edit
 *   echo   …  >  /path/file           → write
 *   echo   … >> /path/file            → edit
 *   apply_patch '<<EOF…EOF'           → patch payload (parsed via parseCodexPatch)
 * False positives are filtered out: lines that are clearly grep/awk/etc.
 */
function parseShellWrites(cmd: string): Array<{ file: string; kind: 'write' | 'edit'; content: string | null }> {
  const out: Array<{ file: string; kind: 'write' | 'edit'; content: string | null }> = [];

  // Only inspect the first physical line of the command — anything past the
  // first newline is the heredoc body / multi-line script and should not be
  // parsed for redirects (that's what produced spurious files like 'PATCH'
  // or `{` from script bodies).
  const firstLine = cmd.split('\n', 1)[0].trim();
  if (!firstLine) return out;

  // Heredoc body, captured for content recovery on writes.
  const heredocMatch = cmd.match(/<<\s*-?['"]?([A-Za-z_][\w]*)['"]?\s*\n([\s\S]*?)\n\1\s*$/m);

  // Strip a single matching pair of surrounding quotes (heredoc filenames
  // in shell often look like `> "file.txt"` or `> 'file.txt'`).
  const stripQuotes = (s: string): string => {
    const m = s.match(/^(['"`])(.*)\1$/);
    return m ? m[2] : s;
  };

  // Path validity: must contain a slash OR be a relative path with a known
  // file extension. Reject brace-bits, redirect operators, devices.
  const looksLikeFile = (raw: string): boolean => {
    const s = stripQuotes(raw);
    if (!s || s.length < 2) return false;
    if (/^[{}()[\]<>|&;]/.test(s)) return false;
    if (s === '/dev/null' || s === '/dev/stdout' || s === '/dev/stderr') return false;
    return s.includes('/') || /\.\w{1,8}$/.test(s);
  };

  // 0) apply_patch heredoc — capture and parse the patch payload.
  if (/^apply_patch\b/.test(firstLine) && heredocMatch) {
    for (const sec of parseCodexPatch(heredocMatch[2])) {
      out.push({
        file: sec.file,
        kind: sec.kind === 'add' ? 'write' : 'edit',
        content: sec.kind === 'add' ? sec.added.join('\n') : null,
      });
    }
    return out;
  }

  // 1) sed -i [-e '…']* /path/file
  //    Captures the last argument; tolerates double-quoted scripts too.
  const sedMatch = firstLine.match(/^sed\s+-i\S*\s+(?:-e\s+(?:'[^']*'|"[^"]*")\s+)*(?:'[^']*'|"[^"]*"|\S+)\s+(\S+)\s*$/);
  if (sedMatch && looksLikeFile(sedMatch[1])) {
    out.push({ file: stripQuotes(sedMatch[1]), kind: 'edit', content: null });
    return out;
  }

  // 2) Redirection on the first line: `cmd > file`, `cmd >> file`. Only the
  //    last redirect on the line is interesting.
  const redirMatches = [...firstLine.matchAll(/(>{1,2})\s+(\S+)/g)];
  const lastRedir = redirMatches[redirMatches.length - 1];
  if (lastRedir && looksLikeFile(lastRedir[2])) {
    const file = stripQuotes(lastRedir[2]);
    const kind: 'write' | 'edit' = lastRedir[1] === '>>' ? 'edit' : 'write';
    const content = heredocMatch ? heredocMatch[2] : null;
    out.push({ file, kind, content });
  }

  // 3) `tee [-a] file` (with or without piping in). No `>` arrow.
  const teeMatch = firstLine.match(/(?:^|\|\s*)tee\s+(?:(-a)\s+)?(\S+)/);
  const teeFile = teeMatch ? stripQuotes(teeMatch[2]) : '';
  if (teeMatch && looksLikeFile(teeMatch[2]) && !out.find(w => w.file === teeFile)) {
    const kind: 'write' | 'edit' = teeMatch[1] ? 'edit' : 'write';
    const content = heredocMatch ? heredocMatch[2] : null;
    out.push({ file: teeFile, kind, content });
  }

  return out;
}


/**
 * Convert a Codex apply_patch payload into per-file (before, after) pairs
 * for the generic engine. The patch carries +/- lines per section but not
 * the full file contents — we synthesize before/after from those lines so
 * a unified diff between them reproduces the exact line counts the
 * original patch represented. For 'add' sections before is empty (file
 * didn't exist); for 'delete' sections after is empty.
 */
function codexPatchToDeltas(patchText: string): Array<{ file: string; before: string | null; after: string | null }> {
  const sections = parseCodexPatch(patchText);
  return sections.map(s => {
    if (s.kind === 'add') return { file: s.file, before: '', after: s.added.join('\n') };
    if (s.kind === 'delete') return { file: s.file, before: s.removed.join('\n'), after: '' };
    // 'update': we don't have full content. Use the +/- lines as stand-in
    // pre/post so diff stats come out correct.
    return { file: s.file, before: s.removed.join('\n'), after: s.added.join('\n') };
  });
}

/**
 * Parse a Codex apply_patch payload into per-file sections with
 * exact added/removed line counts. We deliberately don't try to
 * reconstruct full file content — patch bodies don't carry it.
 */
function parseCodexPatch(input: string): Array<{ file: string; kind: 'add' | 'update' | 'delete'; added: string[]; removed: string[] }> {
  const sections: Array<{ file: string; kind: 'add' | 'update' | 'delete'; added: string[]; removed: string[] }> = [];
  let current: { file: string; kind: 'add' | 'update' | 'delete'; added: string[]; removed: string[] } | null = null;

  for (const line of input.split('\n')) {
    const m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (m) {
      if (current) sections.push(current);
      current = {
        file: m[2].trim(),
        kind: m[1].toLowerCase() as 'add' | 'update' | 'delete',
        added: [], removed: [],
      };
      continue;
    }
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch') || line.startsWith('*** End of File') || line.startsWith('@@')) continue;
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.added.push(line.slice(1));
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed.push(line.slice(1));
  }
  if (current) sections.push(current);
  return sections;
}


// ── Local helpers ────────────────────────────────────────────────────

/** Recursively yield rollout-*.jsonl files under root. */
function* walkRollouts(root: string): Generator<string> {
  let entries: import('fs').Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      yield* walkRollouts(full);
    } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      yield full;
    }
  }
}

/**
 * Codex injects environment + permission wrappers as fake "user_message"
 * payloads. Filtering them keeps the user-input stream clean.
 */
function isCodexInjectedWrapper(text: string): boolean {
  const t = text.trim();
  return t.startsWith('<environment_context>')
      || t.startsWith('<permissions instructions>')
      || t.startsWith('<user_instructions>')
      || t.startsWith('<system_prompt>');
}

/** Concatenate string + {text} parts in a content array into one string. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(seg => {
      if (typeof seg === 'string') return seg;
      if (seg && typeof seg === 'object' && typeof (seg as { text?: string }).text === 'string') {
        return (seg as { text: string }).text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function readFirstLine(path: string): { type?: string; payload?: unknown } | null {
  try {
    const head = readFileSync(path, 'utf-8').split('\n', 1)[0] || '';
    if (!head) return null;
    return JSON.parse(head);
  } catch { return null; }
}
