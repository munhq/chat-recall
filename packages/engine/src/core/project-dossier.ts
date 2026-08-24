/**
 * Project dossier builder.
 *
 * Given a project_id (e.g. `git:github.com/me/repo`, `ws:acme`, …), produce
 * a markdown report aggregating everything the index knows about it:
 *
 *   - Overview / purpose          → CLAUDE.md project section
 *   - Tech stack                  → KG `uses` triples (noise-filtered)
 *   - Architecture                → CLAUDE.md `## Architecture` section
 *   - Deployment & build steps    → CLAUDE.md build/run/deploy sections
 *   - Security                    → CLAUDE.md security section + flagged session chunks
 *   - Decisions log               → KG chose/rejected triples (noise-filtered)
 *   - Recent activity             → last N sessions w/ first prompt
 *   - Open work                   → tasks where status != completed
 *   - Plans                       → plan items in this project
 *   - Cost & activity             → token/cost rollup from session metadata
 *
 * Workspace rollup: if the supplied id is a workspace (`ws:...`) and has
 * resolved children (e.g. user-declared sub-projects), the report appends
 * per-child sub-sections after the rollup.
 */

import { existsSync, readFileSync } from 'fs';

import { resumeCommandFor } from './resume-command.js';
import { createStore } from './store/index.js';
import { createKnowledgeGraph, type KnowledgeGraphDriver } from './store/knowledge-graph.js';
import { resolveProjectId } from './project-resolver.js';
import type { MemoryMetadataRow } from '../types/memory.js';

export interface DossierOptions {
  /** Max sessions to enumerate in the activity section. */
  recentSessionLimit?: number;
  /** Max plans to list. */
  planLimit?: number;
  /** Max open tasks to list. */
  taskLimit?: number;
  /** Include the raw KG decisions even when the filter would drop them. */
  includeUnfilteredKG?: boolean;
}

interface SessionExtra {
  tool?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Standard field name from `model-pricing.ts:estimateCostUsd`. */
  costUsd?: number;
  /** Legacy alias from OpenCode source — kept until next index. */
  estimatedCostUsd?: number;
  firstPrompt?: string;
  toolsUsed?: string[];
  filesModified?: string[];
  status?: string;
}

// What TaskSource actually writes to extra_json (parsers/task-source.ts):
// counts, not per-task status. The old shape ({status,content}) was never
// populated, so Open Work rendered every list as "[?]" and never filtered
// completed ones — fixed to use the real counts + the [status] preview lines.
interface TaskExtra { taskCount?: number; completedCount?: number }

/**
 * The only three reads the project resolver needs. Narrower than the full
 * StorageDriver on purpose: it makes the resolver unit-testable without a
 * database, which is why the bug it fixes had no test before.
 */
export interface ProjectLookup {
  listItemsByProjectId(tenant: null, projectId: string, since: number): Promise<MemoryMetadataRow[]>;
  listAllProjectIdPaths(): Promise<Array<{ project_id: string; project_path: string }>>;
  listProjectsSummary(): Promise<Array<{ project_id: string; items: number; last_mtime: number }>>;
}

/* -----------------------------------------------------------------------
 * Public entry points
 * --------------------------------------------------------------------- */

export async function buildProjectDossier(
  input: string,
  opts: DossierOptions = {},
): Promise<string> {
  const store = await createStore();
  const kg = await createKnowledgeGraph();
  try {
    const resolved = await resolveAgainstIndex(store, input);
    if (!resolved) {
      // Say what was tried. The old message reported the unresolvable id as
      // though the project were merely empty, which reads as "you have never
      // worked here" — the worst answer a memory product can give.
      return `# ${deriveDisplayName(input)}\n\n`
        + `No project matches \`${input}\`.\n\n`
        + 'Nothing in the index has that project id, that path, or a name containing it. '
        + 'List the ids that do exist with `chat-recall projects`.\n';
    }
    const displayName = deriveDisplayName(resolved.projectId);
    return await renderDossier(displayName, resolved.projectId, resolved.rows, kg, opts);
  } finally {
    await store.close();
    await kg.close();
  }
}

/**
 * Turn whatever the caller passed into a project_id THAT HAS ROWS.
 *
 * WHY THIS IS NOT JUST `resolveProjectId`. That helper reads the git remote of
 * a directory on the machine it runs on. The dossier runs on the SERVER, and
 * the path belongs to the user's laptop — so on the server the directory does
 * not exist, the resolver falls back to `path:/home/…`, nothing matches it, and
 * the endpoint returned an empty-looking report for a project with thousands of
 * indexed items. Every documented way to call it except the internal
 * `git:` id was broken, silently.
 *
 * The index already knows the answer: the collector stores project_id AND
 * project_path on every row, so the mapping the server cannot compute it can
 * simply look up. Order is most-specific first, and each step must produce rows
 * to win:
 *
 *   1. an explicit project_id  (`git:`, `ws:`, …)
 *   2. every id claiming this exact directory — the local resolution plus
 *      whatever the index recorded against the same path
 *   3. a path prefix           (a subdirectory of a known checkout)
 *   4. a name substring        (`example-app` → `git:github.com/acme/example-app`)
 *
 * Within a step the project with the most indexed items wins, so a stray
 * one-row leftover cannot outrank the real project.
 */
export async function resolveAgainstIndex(
  store: ProjectLookup,
  input: string,
): Promise<{ projectId: string; rows: MemoryMetadataRow[] } | null> {
  const attempt = async (id: string) => {
    if (!id) return null;
    const rows = await store.listItemsByProjectId(null, id, 0);
    return rows.length > 0 ? { projectId: id, rows } : null;
  };

  // 1 — an explicit id. Nothing to resolve; if it has no rows it is genuinely
  // empty, and reporting that against the id the caller named is honest.
  if (looksLikeProjectId(input)) {
    const rows = await store.listItemsByProjectId(null, input, 0);
    return { projectId: input, rows };
  }

  const paths = await store.listAllProjectIdPaths();
  const counts = new Map<string, number>();
  for (const p of await store.listProjectsSummary()) counts.set(p.project_id, p.items);
  const busiest = (ids: string[]) =>
    [...new Set(ids)].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0];

  const needle = input.replace(/\/+$/, '');

  // 2 — every id that claims THIS directory: the local resolution (exact when
  // the dossier runs on the CLI, since it reads the real git remote) and every
  // id the index recorded against the same path.
  //
  // These compete, so the busiest wins rather than the first tried. A repo
  // indexed before it had a remote leaves a `path:` id behind; that leftover
  // holds a handful of rows while the real `git:` id holds thousands, and
  // trying the local resolution FIRST handed the caller the leftover. A test
  // caught it — the ordering looked obviously right and was not.
  const sameDir = [
    resolveProjectId(input).id,
    ...paths.filter(p => p.project_path.replace(/\/+$/, '') === needle).map(p => p.project_id),
  ].filter(Boolean);
  if (sameDir.length) {
    const hit = await attempt(busiest(sameDir));
    if (hit) return hit;
  }

  // 4 — a subdirectory of a known checkout (`…/repo/packages/cli`).
  if (needle.startsWith('/')) {
    const under = paths.filter(p => p.project_path && needle.startsWith(p.project_path.replace(/\/+$/, '') + '/'));
    if (under.length) {
      // Deepest checkout wins: a nested repo is more specific than its parent.
      under.sort((a, b) => b.project_path.length - a.project_path.length);
      const hit = await attempt(under[0].project_id);
      if (hit) return hit;
    }
  }

  // 5 — a name substring, which is what a human types.
  const lower = needle.toLowerCase();
  const byName = paths
    .map(p => p.project_id)
    .filter(id => deriveDisplayName(id).toLowerCase() === lower);
  if (byName.length) {
    const hit = await attempt(busiest(byName));
    if (hit) return hit;
  }
  const loose = paths.map(p => p.project_id).filter(id => id.toLowerCase().includes(lower));
  if (loose.length) {
    const hit = await attempt(busiest(loose));
    if (hit) return hit;
  }

  return null;
}

/* -----------------------------------------------------------------------
 * Rendering
 * --------------------------------------------------------------------- */

async function renderDossier(
  displayName: string,
  projectId: string,
  rows: MemoryMetadataRow[],
  kg: KnowledgeGraphDriver,
  opts: DossierOptions,
): Promise<string> {
  const sessions = rows.filter(r => r.source_type === 'session');
  const tasks = rows.filter(r => r.source_type === 'task');
  const plans = rows.filter(r => r.source_type === 'plan');
  const claudeMds = rows.filter(r => r.source_type === 'claude_md');
  const diaries = rows.filter(r => r.source_type === 'diary');

  const parts: string[] = [];
  parts.push(headerSection(displayName, projectId, rows, sessions));
  parts.push(overviewSection(claudeMds));
  parts.push(await techStackSection(displayName, kg));
  parts.push(architectureSection(claudeMds));
  parts.push(deploymentSection(claudeMds));
  parts.push(securitySection(claudeMds));
  parts.push(await decisionsSection(displayName, kg, opts));
  parts.push(activitySection(sessions, opts.recentSessionLimit ?? 10));
  parts.push(openWorkSection(tasks, opts.taskLimit ?? 20));
  parts.push(plansSection(plans, opts.planLimit ?? 20));
  parts.push(conclusionsSection(diaries, sessions));
  parts.push(costSection(sessions));

  return parts.filter(s => s.trim()).join('\n\n');
}

/* ----- Sections --------------------------------------------------------- */

function headerSection(
  displayName: string,
  projectId: string,
  rows: MemoryMetadataRow[],
  sessions: MemoryMetadataRow[],
): string {
  const lastMtime = rows.reduce((m, r) => Math.max(m, r.mtime || 0), 0);
  const lastActive = lastMtime ? new Date(lastMtime).toISOString().slice(0, 10) : 'unknown';
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.source_type] = (counts[r.source_type] || 0) + 1;
  const sourceLine = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${t}`)
    .join(' · ');
  return [
    `# ${displayName}`,
    ``,
    `**Project id:** \`${projectId}\`  `,
    `**Last activity:** ${lastActive}  `,
    `**Sessions:** ${sessions.length}  `,
    `**Indexed items:** ${rows.length} (${sourceLine})`,
  ].join('\n');
}

function overviewSection(claudeMds: MemoryMetadataRow[]): string {
  const text = pickClaudeMdSection(claudeMds, ['overview', 'about', 'project overview']);
  if (text) return `## Overview\n\n${text}`;
  // Fallback: any claude_md's content preview
  const previews = claudeMds.map(c => c.content_preview).filter(Boolean).slice(0, 1);
  if (!previews.length) return '';
  return `## Overview\n\n${previews[0]}`;
}

async function techStackSection(displayName: string, kg: KnowledgeGraphDriver): Promise<string> {
  const candidates = kgEntitiesForProject(displayName);
  const uses = new Map<string, number>(); // tool → confidence accumulator
  for (const c of candidates) {
    for (const r of await kg.queryEntity(c, undefined, 'outgoing')) {
      if (r.predicate !== 'uses') continue;
      uses.set(r.object, Math.max(uses.get(r.object) || 0, r.confidence));
    }
  }
  if (uses.size === 0) return '';
  const sorted = [...uses.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => `\`${t}\``);
  return `## Tech Stack\n\n${sorted.join(' · ')}`;
}

function architectureSection(claudeMds: MemoryMetadataRow[]): string {
  const text = pickClaudeMdSection(claudeMds, ['architecture', 'system architecture', 'design']);
  return text ? `## Architecture\n\n${text}` : '';
}

function deploymentSection(claudeMds: MemoryMetadataRow[]): string {
  const text = pickClaudeMdSection(claudeMds, [
    'deployment', 'deploy', 'build', 'build and run', 'running', 'setup', 'install',
  ]);
  return text ? `## Deployment & Build\n\n${text}` : '';
}

function securitySection(claudeMds: MemoryMetadataRow[]): string {
  const text = pickClaudeMdSection(claudeMds, ['security', 'security practices', 'auth', 'authentication']);
  return text ? `## Security\n\n${text}` : '';
}

async function decisionsSection(displayName: string, kg: KnowledgeGraphDriver, _opts: DossierOptions): Promise<string> {
  // KG is authoritative now: write-time filter in entity-extractor blocks
  // new junk, and `scripts/cleanup-kg-triples.ts` scrubs the existing
  // graph. No read-time filter needed.
  const entities = kgEntitiesForProject(displayName);
  const decisions: Array<{ predicate: string; object: string; valid_from: string | null }> = [];
  for (const e of entities) {
    for (const r of await kg.queryEntity(e, undefined, 'outgoing')) {
      if (r.predicate !== 'chose' && r.predicate !== 'rejected') continue;
      decisions.push({ predicate: r.predicate, object: r.object, valid_from: r.valid_from });
    }
  }
  if (decisions.length === 0) return '';
  const lines = decisions.map(d => {
    const date = d.valid_from ? ` _(${d.valid_from.slice(0, 10)})_` : '';
    const verb = d.predicate === 'chose' ? '✔ Chose' : '✘ Rejected';
    return `- ${verb} **${d.object}**${date}`;
  });
  return `## Decisions\n\n${lines.join('\n')}`;
}

function activitySection(sessions: MemoryMetadataRow[], limit: number): string {
  if (sessions.length === 0) return '';
  const recent = sessions.slice(0, limit);
  const lines = recent.map(s => {
    const extra = parseExtra<SessionExtra>(s.extra_json);
    const prompt = (extra.firstPrompt || s.content_preview || '').trim().slice(0, 140);
    const date = s.mtime ? new Date(s.mtime).toISOString().slice(0, 10) : '????';
    // A gemini session has no resume-by-id, so it gets the entry without a
    // command rather than a command that cannot work.
    const resume = resumeCommandFor(s.id);
    const head = `- **${date}** — ${prompt || '_(no first prompt)_'}`;
    return resume ? `${head}  \n  \`${resume}\`` : head;
  });
  return `## Recent Activity (${recent.length} of ${sessions.length} sessions)\n\n${lines.join('\n')}`;
}

function openWorkSection(tasks: MemoryMetadataRow[], limit: number): string {
  // A task-list row carries {taskCount, completedCount}; it has open work when
  // not everything is done (or when counts are absent, e.g. agent todos — treat
  // as open so we don't silently hide them). content_preview holds the actual
  // "[status] subject" lines the parser captured.
  const open = tasks
    .map(t => ({ row: t, extra: parseExtra<TaskExtra>(t.extra_json) }))
    .filter(t => {
      const total = t.extra.taskCount ?? 0;
      const done = t.extra.completedCount ?? 0;
      return total === 0 || done < total;
    });
  if (open.length === 0) return '';
  const lines = open.slice(0, limit).map(t => {
    const total = t.extra.taskCount ?? 0;
    const done = t.extra.completedCount ?? 0;
    const progress = total > 0 ? ` (${done}/${total} done)` : '';
    const title = (t.row.title || t.row.content_preview || 'tasks').slice(0, 140);
    return `- ${title}${progress}`;
  });
  return `## Open Work (${open.length})\n\n${lines.join('\n')}`;
}

function plansSection(plans: MemoryMetadataRow[], limit: number): string {
  if (plans.length === 0) return '';
  const lines = plans.slice(0, limit).map(p => {
    const date = p.mtime ? new Date(p.mtime).toISOString().slice(0, 10) : '????';
    return `- **${date}** — ${p.title}`;
  });
  return `## Plans (${plans.length})\n\n${lines.join('\n')}`;
}

function conclusionsSection(diaries: MemoryMetadataRow[], sessions: MemoryMetadataRow[]): string {
  const items: string[] = [];
  for (const d of diaries.slice(0, 5)) {
    const content = (d.content_preview || '').trim().slice(0, 300);
    if (content) items.push(`- _${d.title || 'diary'}_: ${content}`);
  }
  // Pull the latest 3 session summaries from extra.summary if available
  for (const s of sessions.slice(0, 3)) {
    const extra = parseExtra<{ summary?: string }>(s.extra_json);
    if (extra.summary) items.push(`- _${new Date(s.mtime).toISOString().slice(0, 10)}_: ${extra.summary.slice(0, 300)}`);
  }
  if (items.length === 0) return '';
  return `## Conclusions & Recent Insights\n\n${items.join('\n')}`;
}

function costSection(sessions: MemoryMetadataRow[]): string {
  let inputTok = 0, outputTok = 0, cacheRead = 0, cacheCreate = 0, cost = 0;
  for (const s of sessions) {
    const e = parseExtra<SessionExtra>(s.extra_json);
    inputTok += e.inputTokens || 0;
    outputTok += e.outputTokens || 0;
    cacheRead += e.cacheReadTokens || 0;
    cacheCreate += e.cacheCreationTokens || 0;
    cost += e.costUsd ?? e.estimatedCostUsd ?? 0;
  }
  const totalTokens = inputTok + outputTok + cacheRead + cacheCreate;
  if (totalTokens === 0 && cost === 0) return '';
  return [
    `## Cost & Activity`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Total cost | $${cost.toFixed(2)} |`,
    `| Input tokens | ${fmt(inputTok)} |`,
    `| Output tokens | ${fmt(outputTok)} |`,
    `| Cache read | ${fmt(cacheRead)} |`,
    `| Cache create | ${fmt(cacheCreate)} |`,
  ].join('\n');
}

/* -----------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------- */

function looksLikeProjectId(s: string): boolean {
  return /^(git:|git-local:|ws:|path:|ignored:)/.test(s);
}

function deriveDisplayName(projectId: string): string {
  // git:host/owner/repo → repo
  const m = /^git:[^/]+\/[^/]+\/(.+)$/.exec(projectId);
  if (m) return m[1];
  const ws = /^ws:(.+)$/.exec(projectId);
  if (ws) return ws[1] + ' (workspace)';
  const local = /^git-local:(.+)$/.exec(projectId);
  if (local) return `local repo ${local[1]}`;
  const path = /^path:(.+)$/.exec(projectId);
  if (path) {
    const segs = path[1].split('/').filter(Boolean);
    return segs[segs.length - 1] || projectId;
  }
  return projectId;
}

function parseExtra<T = Record<string, unknown>>(json: string): T {
  try { return JSON.parse(json || '{}') as T; } catch { return {} as T; }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

/**
 * Pick a section from any CLAUDE.md file. We re-read from disk because
 * `memory_metadata.content_preview` is a short snippet — the actual
 * Architecture / Deployment / Security sections almost never fit. If
 * the file is gone we silently fall back to the stored preview.
 */
function pickClaudeMdSection(claudeMds: MemoryMetadataRow[], headings: string[]): string {
  for (const c of claudeMds) {
    const body = readClaudeMdBody(c);
    if (!body) continue;
    for (const h of headings) {
      const section = extractSectionFromHeading(body, h);
      if (section) return section;
    }
  }
  // Last-resort fallback: first preview that mentions any heading.
  for (const h of headings) {
    const re = new RegExp(`(^|\\n)#+\\s*${escapeRe(h)}`, 'i');
    for (const c of claudeMds) {
      const text = c.content_preview || '';
      if (re.test(text)) return text.slice(0, 800);
    }
  }
  return '';
}

const bodyCache = new Map<string, string>();
function readClaudeMdBody(row: MemoryMetadataRow): string {
  if (bodyCache.has(row.file_path)) return bodyCache.get(row.file_path)!;
  if (!row.file_path || !existsSync(row.file_path)) {
    bodyCache.set(row.file_path, '');
    return '';
  }
  try {
    const text = readFileSync(row.file_path, 'utf-8');
    bodyCache.set(row.file_path, text);
    return text;
  } catch {
    bodyCache.set(row.file_path, '');
    return '';
  }
}

function extractSectionFromHeading(text: string, heading: string): string {
  const re = new RegExp(`(^|\\n)#+\\s*${escapeRe(heading)}[^\\n]*\\n`, 'i');
  const start = text.search(re);
  if (start < 0) return '';
  const after = text.slice(start).replace(re, '');
  // Stop at the next heading of equal or higher level — keep it simple and
  // just cut at the next "#" header line.
  const next = after.search(/\n#+\s/);
  const body = next > 0 ? after.slice(0, next) : after;
  return body.trim().slice(0, 1500);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Candidate KG entity names that could represent the project. */
function kgEntitiesForProject(displayName: string): string[] {
  // The entity-extractor uses the last path segment as the project name,
  // so we try the display name as-is plus a few common variants.
  const lower = displayName.toLowerCase();
  return Array.from(new Set([displayName, lower, lower.replace(/[-_]/g, '')]));
}

