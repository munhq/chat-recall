/**
 * Plan memory source.
 *
 * Parses plans from two AI tools:
 *   - Claude Code: ~/.claude/plans/*.md  (flat, +discoverSubdirs)
 *   - Gemini CLI:  ~/.gemini/tmp/<sha256>/<uuid>/plans/*.md
 *
 * Each plan is split by ## headers into chunks for granular search. Claude
 * agent plans (with -agent-<hash> suffix) are linked back to their parent.
 *
 * OpenCode doesn't store plans on disk — its todos live in a SQLite table
 * and are picked up by OpenCodeTodoSource as `task` items.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
import { createHash } from 'crypto';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
} from '../types/memory.js';
import { splitByHeaders, discoverSubdirs } from '../core/utils.js';
import { geminiBackend as GEMINI } from '../core/backends/gemini.js';
import { opencodeBackend as OPENCODE } from '../core/backends/opencode.js';
import { claudeBackend as CLAUDE } from '../core/backends/claude.js';
import { agyBackend as AGY } from '../core/backends/agy.js';
import { isSourceEnabled } from '../core/settings.js';
import { decodeProjectDirName } from '../core/project-dir-name.js';

const MAX_CHUNK_CHARS = 2000;

/** A bare session UUID (Claude plan files are often named `<session-uuid>.md`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse the leading `---` frontmatter block Claude Code writes on newer plans
 * (`session_id`, `cwd`, `timestamp`). Returns the recognised keys plus the
 * body with the frontmatter stripped, so it never pollutes indexed chunks.
 * Content without frontmatter is returned unchanged as `body`.
 */
function parseFrontmatter(content: string): { sessionId?: string; cwd?: string; body: string } {
  if (!content.startsWith('---')) return { body: content };
  // Closing fence: a line that is exactly `---` after the opening one.
  const close = content.indexOf('\n---', 3);
  if (close === -1) return { body: content };
  const header = content.slice(3, close);
  const afterFence = content.indexOf('\n', close + 1);
  const body = afterFence === -1 ? '' : content.slice(afterFence + 1);

  const out: { sessionId?: string; cwd?: string; body: string } = { body };
  for (const line of header.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    if (m[1] === 'session_id') out.sessionId = m[2].trim();
    else if (m[1] === 'cwd') out.cwd = m[2].trim();
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export class PlanSource implements MemorySource {
  readonly sourceType = 'plan' as const;

  private plansDirs: string[];

  private _knownProjectDirs: string[] | null = null;

  /** Cache: subagent id (the `-agent-<hash>` suffix) → its parent session id. */
  private _subagentParents: Map<string, string> | null = null;

  constructor(plansDir?: string) {
    this.plansDirs = plansDir ? [plansDir] : discoverSubdirs('plans');
  }

  /** Lazily discover project directories from ~/.claude/projects/ */
  private getKnownProjectDirs(): string[] {
    if (this._knownProjectDirs) return this._knownProjectDirs;

    const projectsDir = CLAUDE.projectsDir();
    this._knownProjectDirs = [];

    if (!existsSync(projectsDir)) return this._knownProjectDirs;

    try {
      const entries = readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const projectPath = decodeProjectDirName(entry.name);
        if (existsSync(projectPath)) {
          this._knownProjectDirs.push(projectPath);
        }
      }
    } catch {
      // Ignore errors
    }

    return this._knownProjectDirs;
  }

  async *discover(): AsyncGenerator<MemoryItem> {
    // 1) Claude plans (~/.claude/plans/*.md and any ~/.claude-*/plans/)
    if (isSourceEnabled('claude', 'plans')) {
      yield* this.discoverClaudePlans();
    }

    // 2) Gemini plans — ~/.gemini/tmp/<sha256>/<uuid>/plans/*.md
    if (isSourceEnabled('gemini', 'plans')) {
      yield* this.discoverGeminiPlans();
    }

    // 3) OpenCode plans — ~/.local/share/opencode/plans/*.md
    if (isSourceEnabled('opencode', 'plans')) {
      yield* this.discoverOpenCodePlans();
    }

    // 4) Antigravity plans — ~/.gemini/antigravity-cli/brain/<uuid>/*.md
    if (isSourceEnabled('agy', 'plans')) {
      yield* this.discoverAgyPlans();
    }
  }

  private async *discoverClaudePlans(): AsyncGenerator<MemoryItem> {
    const seenClaude = new Set<string>();
    for (const plansDir of this.plansDirs) {
      if (!existsSync(plansDir)) continue;

      const files = readdirSync(plansDir).filter(f => f.endsWith('.md'));

      for (const file of files) {
        if (seenClaude.has(file)) continue;
        seenClaude.add(file);
        const filePath = join(plansDir, file);
        try {
          const stat = statSync(filePath);
          const planName = basename(file, '.md');
          const isAgentPlan = planName.includes('-agent-');

          const content = readFileSync(filePath, 'utf-8');
          const fm = parseFrontmatter(content);
          const body = fm.body;
          const firstLine = body.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim() || planName;
          // `cwd` frontmatter is authoritative; fall back to the content heuristic.
          const projectPath = fm.cwd || this.extractProjectPath(body);

          // Session linkage: prefer the explicit `session_id` frontmatter, else a
          // UUID-named file whose basename IS the session id. Agent plans
          // (`<slug>-agent-<hash>`) carry neither and are resolved from the
          // subagent transcript in extractLinks().
          const baseName = planName.replace(/-agent-[a-z0-9]+$/i, '');
          const claudeSessionId = fm.sessionId || (UUID_RE.test(baseName) ? baseName : undefined);

          yield {
            id: planName,
            sourceType: 'plan',
            title: firstLine.slice(0, 150),
            projectPath,
            filePath,
            mtime: stat.mtimeMs,
            contentPreview: body.slice(0, 300),
            extra: {
              tool: 'claude',
              isAgentPlan,
              fileSize: stat.size,
              ...(claudeSessionId ? { claudeSessionId } : {}),
            },
          };
        } catch {
          continue;
        }
      }
    }
  }

  private async *discoverOpenCodePlans(): AsyncGenerator<MemoryItem> {
    const plansDir = OPENCODE.plansDir();
    if (!existsSync(plansDir)) return;

    let files: string[];
    try { files = readdirSync(plansDir).filter(f => f.endsWith('.md')); } catch { return; }

    for (const file of files) {
      const filePath = join(plansDir, file);
      try {
        const stat = statSync(filePath);
        const content = readFileSync(filePath, 'utf-8');
        const firstLine = content.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim() || file;
        const planName = `${OPENCODE.idPrefix}plan_${basename(file, '.md')}`;

        // OpenCode plans don't carry per-project metadata in the file itself;
        // we leave projectPath empty and let the existing extractor try.
        const projectPath = this.extractProjectPath(content);

        yield {
          id: planName,
          sourceType: 'plan',
          title: firstLine.slice(0, 150),
          projectPath,
          filePath,
          mtime: stat.mtimeMs,
          contentPreview: content.slice(0, 300),
          extra: {
            tool: 'opencode',
            fileSize: stat.size,
          },
        };
      } catch { /* skip */ }
    }
  }

  /** Walk Gemini's per-session plan directories and yield each .md file. */
  private async *discoverGeminiPlans(): AsyncGenerator<MemoryItem> {
    const tmpRoot = GEMINI.tmpDir();
    if (!existsSync(tmpRoot)) return;

    // Resolve project hashes back to paths the same way GeminiSessionSource does.
    const projMap = new Map<string, string>();
    const projectsPath = GEMINI.projectsJson();
    if (existsSync(projectsPath)) {
      try {
        const data = JSON.parse(readFileSync(projectsPath, 'utf-8'));
        for (const path of Object.keys(data.projects || {})) {
          projMap.set(createHash('sha256').update(path).digest('hex'), path);
        }
      } catch { /* tolerate */ }
    }

    let projDirs: string[];
    try { projDirs = readdirSync(tmpRoot); } catch { return; }

    for (const projDir of projDirs) {
      const projPath = projMap.get(projDir) || '';
      const projRoot = join(tmpRoot, projDir);
      let sessions: string[];
      try { sessions = readdirSync(projRoot); } catch { continue; }

      for (const sess of sessions) {
        const plansDir = join(projRoot, sess, 'plans');
        if (!existsSync(plansDir)) continue;
        let files: string[];
        try { files = readdirSync(plansDir).filter(f => f.endsWith('.md')); } catch { continue; }

        for (const file of files) {
          const filePath = join(plansDir, file);
          try {
            const stat = statSync(filePath);
            const content = readFileSync(filePath, 'utf-8');
            const firstLine = content.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim() || file;
            const planName = `${GEMINI.idPrefix}plan_${sess}_${basename(file, '.md')}`;

            yield {
              id: planName,
              sourceType: 'plan',
              title: firstLine.slice(0, 150),
              projectPath: projPath,
              filePath,
              mtime: stat.mtimeMs,
              contentPreview: content.slice(0, 300),
              extra: {
                tool: 'gemini',
                geminiSessionId: sess,
                fileSize: stat.size,
              },
            };
          } catch { /* skip */ }
        }
      }
    }
  }

  /** Extract project path from plan content by matching against known projects */
  private extractProjectPath(content: string): string {
    const knownProjects = this.getKnownProjectDirs();

    // Look for explicit full paths that match known project dirs
    const fullPathPattern = /(?:File|Path|Location|Directory|Working directory|Project|Repository):\s*`?([~/][^\s`\n]+)`?/gi;
    for (const match of content.matchAll(fullPathPattern)) {
      let path = (match[1] || '').trim();
      // Expand ~ to home dir for comparison
      if (path.startsWith('~/')) {
        path = join(homedir(), path.slice(2));
      }
      // Check if this path starts with any known project dir
      for (const projectDir of knownProjects) {
        if (path.startsWith(projectDir)) {
          return projectDir;
        }
      }
    }

    // Also scan for any absolute paths in content that match known projects
    const absolutePathPattern = /(?:^|\s)(\/[\w/.-]+)/gm;
    for (const match of content.matchAll(absolutePathPattern)) {
      const path = match[1];
      for (const projectDir of knownProjects) {
        if (path.startsWith(projectDir)) {
          return projectDir;
        }
      }
    }

    // Look for project name mentions in various formats
    const projectNamePatterns = [
      /(?:project|repo|repository|codebase|application):\s*`?([\w-]+)`?/gi,
      /(?:in|for|on)\s+(?:the\s+)?([\w-]+)\s+(?:project|repo|repository|codebase)/gi,
      /`([\w-]+)\/(?:src|lib|crates|packages|apps)\//g,  // Like `hft-relay/src/`
      /crates\/([\w-]+)\//g,  // Rust workspace crates
      /packages\/([\w-]+)\//g,  // JS monorepo packages
    ];

    const projectNames = new Set<string>();
    for (const pattern of projectNamePatterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        const name = match[1];
        if (name && name.length > 2 && !['src', 'lib', 'test', 'main', 'index'].includes(name)) {
          projectNames.add(name);
        }
      }
    }

    // Search for the project name in known project directories from ~/.claude/projects/
    for (const name of projectNames) {
      for (const projectDir of knownProjects) {
        if (projectDir.endsWith(`/${name}`) || projectDir.endsWith(`\\${name}`)) {
          return projectDir;
        }
      }
    }

    return '';
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(item.filePath)) return [];

    const content = readFileSync(item.filePath, 'utf-8');
    const chunks: MemoryChunk[] = [];

    // Strip `---` frontmatter (session_id/cwd/timestamp) so it isn't indexed.
    const { body } = parseFrontmatter(content);

    // Split by ## headers into sections
    const sections = splitByHeaders(body);

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (!section.text.trim() || section.text.trim().length < 20) continue;

      const text = section.text.slice(0, MAX_CHUNK_CHARS);
      const chunkType = i === 0 ? 'plan_overview' : 'plan_section';

      chunks.push({
        chunkId: `${item.id}_${chunkType}_${i}`,
        itemId: item.id,
        sourceType: 'plan',
        title: section.heading || item.title,
        text,
        chunkType,
        projectPath: item.projectPath,
        filePath: item.filePath,
        mtime: item.mtime,
      });
    }

    // Limit to reasonable number of chunks per plan
    return chunks.slice(0, 10);
  }

  /**
   * Build (once, lazily) a map from subagent id → parent session id by walking
   * `~/.claude/projects/<proj>/<session>/subagents/agent-<hash>.jsonl`. Claude
   * agent plans are named `<slug>-agent-<hash>` where `<hash>` is exactly that
   * subagent id, so this resolves an agent plan back to the session it ran in.
   */
  private getSubagentParents(): Map<string, string> {
    if (this._subagentParents) return this._subagentParents;
    const map = new Map<string, string>();
    const root = CLAUDE.projectsDir();
    for (const proj of safeReaddir(root)) {
      const projPath = join(root, proj);
      for (const sessionEntry of safeReaddir(projPath)) {
        const subDir = join(projPath, sessionEntry, 'subagents');
        if (!existsSync(subDir)) continue;
        for (const f of safeReaddir(subDir)) {
          const m = f.match(/^agent-([a-z0-9_-]+)\.jsonl$/i);
          if (m) map.set(m[1], sessionEntry);
        }
      }
    }
    this._subagentParents = map;
    return map;
  }

  /** Resolve the originating session id (already tool-prefixed) for a plan. */
  private resolveSessionId(item: MemoryItem): string | undefined {
    const tool = (item.extra?.tool as string) || 'claude';
    if (tool === 'claude') {
      // Frontmatter session_id / UUID-named file (claude prefix is '').
      const csid = item.extra?.claudeSessionId as string | undefined;
      if (csid) return CLAUDE.toPrefixedId(csid);
      // Agent plan: hash suffix == subagent id → look up its parent session.
      const agentMatch = item.id.match(/-agent-([a-z0-9]+)$/i);
      if (agentMatch) {
        const parent = this.getSubagentParents().get(agentMatch[1]);
        if (parent) return CLAUDE.toPrefixedId(parent);
      }
      return undefined;
    }
    if (tool === 'gemini') {
      const gid = item.extra?.geminiSessionId as string | undefined;
      return gid ? GEMINI.toPrefixedId(gid) : undefined;
    }
    if (tool === 'agy') {
      const aid = item.extra?.agySessionId as string | undefined;
      return aid ? AGY.toPrefixedId(aid) : undefined;
    }
    return undefined;
  }

  async extractLinks(item: MemoryItem): Promise<MemoryLink[]> {
    const links: MemoryLink[] = [];
    const planName = item.id;

    // 1) The plan's originating conversation — the key relationship. Directly
    //    connects the plan to the session it was written in (any tool).
    const sessionId = this.resolveSessionId(item);
    if (sessionId) {
      links.push({
        sourceType: 'plan',
        sourceId: planName,
        targetType: 'session',
        targetId: sessionId,
        linkType: 'plan_for_session',
        confidence: 1.0,
      });
    }

    // 2) Agent plans also relate to their parent (top-level) plan.
    const agentMatch = planName.match(/^(.+)-agent-[a-z0-9]+$/i);
    if (agentMatch) {
      links.push({
        sourceType: 'plan',
        sourceId: planName,
        targetType: 'plan',
        targetId: agentMatch[1],
        linkType: 'agent_plan_parent',
        confidence: 1.0,
      });
    }

    // 3) Project association. `projectPath` is already resolved in discover()
    //    (cwd frontmatter when present, else the content heuristic) — link to
    //    the project's CLAUDE.md by project name without re-reading the file.
    if (item.projectPath) {
      const projectName = basename(item.projectPath);
      if (projectName) {
        links.push({
          sourceType: 'plan',
          sourceId: planName,
          targetType: 'claude_md',
          targetId: projectName,
          linkType: 'plan_for_project',
          confidence: sessionId ? 1.0 : 0.8,
        });
      }
    }

    return links;
  }

  private async *discoverAgyPlans(): AsyncGenerator<MemoryItem> {
    const brainDir = join(AGY.homeDir(), 'brain');
    if (!existsSync(brainDir)) return;

    let sessionDirs: string[];
    try { sessionDirs = readdirSync(brainDir); } catch { return; }

    for (const rawId of sessionDirs) {
      const sessionPath = join(brainDir, rawId);
      try {
        if (!statSync(sessionPath).isDirectory()) continue;
      } catch {
        continue;
      }

      let files: string[];
      try {
        files = readdirSync(sessionPath).filter(f => f.endsWith('.md'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = join(sessionPath, file);
        try {
          const stat = statSync(filePath);
          const content = readFileSync(filePath, 'utf-8');
          const firstLine = content.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim() || file;

          const sessionLoc = AGY.findSession(rawId);
          const projectPath = sessionLoc?.projectPath || this.extractProjectPath(content);

          const planName = `${AGY.idPrefix}plan_${rawId}_${basename(file, '.md')}`;

          yield {
            id: planName,
            sourceType: 'plan',
            title: firstLine.slice(0, 150),
            projectPath,
            filePath,
            mtime: stat.mtimeMs,
            contentPreview: content.slice(0, 300),
            extra: {
              tool: 'agy',
              agySessionId: rawId,
              fileSize: stat.size,
            },
          };
        } catch { /* skip */ }
      }
    }
  }
}
