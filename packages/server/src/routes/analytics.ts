/**
 * Analytics routes - aggregated stats across all sessions.
 */

import express from 'express';
import { getAllSessions, parseSessionFile, createMetadataCache, createStore } from '../imports.js';
import type { SessionEntry, SourceType } from '../imports.js';
import { getModelContextLimit } from '@chat-recall/engine/core/utils.js';

const router = express.Router();

// Cache analytics for 60 seconds (expensive to compute)
let analyticsCache: any = null;
let analyticsCacheTime = 0;
const CACHE_TTL_MS = 60_000;

/** Map file extension to language name */
function extToLang(ext: string): string {
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
    rs: 'Rust', go: 'Go', py: 'Python', rb: 'Ruby', java: 'Java',
    kt: 'Kotlin', swift: 'Swift', c: 'C', cpp: 'C++', h: 'C/C++',
    cs: 'C#', php: 'PHP', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
    yml: 'YAML', yaml: 'YAML', json: 'JSON', toml: 'TOML',
    md: 'Markdown', sql: 'SQL', html: 'HTML', css: 'CSS', scss: 'SCSS',
    vue: 'Vue', svelte: 'Svelte', tf: 'Terraform', hcl: 'Terraform',
    dockerfile: 'Docker', nix: 'Nix', lua: 'Lua', zig: 'Zig',
    nu: 'Nushell', kdl: 'KDL',
  };
  return map[ext.toLowerCase()] || ext.toUpperCase();
}

/** Pricing table (cost per million tokens). Only models we have published prices for. */
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-4-6':   { input: 15,  output: 75,  cacheRead: 1.5 },
  'claude-sonnet-4-6': { input: 3,   output: 15,  cacheRead: 0.3 },
  'claude-haiku-4-5':  { input: 0.8, output: 4,   cacheRead: 0.08 },
  'claude-sonnet-4-5': { input: 3,   output: 15,  cacheRead: 0.3 },
};

/** Returns pricing for a model, or null if unknown (Gemini, Ollama, custom). */
function getModelPricing(model: string): { input: number; output: number; cacheRead: number } | null {
  if (!model) return null;
  if (PRICING[model]) return PRICING[model];
  for (const [key, val] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return val;
  }
  return null;
}

/**
 * Estimate session cost from tokens. Returns null when no model in the session
 * has a known price — we don't fabricate dollars. Synthetic models are skipped
 * before falling through to "no price."
 */
function estimateCost(meta: Record<string, any>): number | null {
  const models: string[] = (meta.modelsUsed || []).filter((m: string) => m && m !== '<synthetic>');
  let pricing: ReturnType<typeof getModelPricing> = null;
  for (const m of models) {
    pricing = getModelPricing(m);
    if (pricing) break;
  }
  if (!pricing) return null;
  const input = meta.inputTokens || 0;
  const output = meta.outputTokens || 0;
  const cacheRead = meta.cacheReadTokens || 0;
  const cacheCreate = meta.cacheCreationTokens || 0;
  const nonCached = Math.max(0, input - cacheRead - cacheCreate);
  return (nonCached / 1e6) * pricing.input +
         (output / 1e6) * pricing.output +
         (cacheRead / 1e6) * pricing.cacheRead +
         (cacheCreate / 1e6) * (pricing.input * 1.25);
}

// GET /api/analytics
router.get('/', async (req, res) => {
  try {
    const toolFilter = (req.query.tool as string | undefined)?.trim().toLowerCase();
    const validTools = new Set(['claude', 'gemini', 'opencode', 'codex']);
    const activeToolFilter = toolFilter && validTools.has(toolFilter) ? toolFilter : null;

    // Cache key includes the tool filter so we don't return the wrong slice.
    const now = Date.now();
    if (!activeToolFilter && analyticsCache && (now - analyticsCacheTime) < CACHE_TTL_MS) {
      return res.json(analyticsCache);
    }

    const store = await createStore();
    const cache = await createMetadataCache();

    // Per-project aggregation
    const projectStats = new Map<string, {
      sessions: number;
      totalCost: number;
      totalDuration: number;
      totalInput: number;
      totalOutput: number;
      languages: Map<string, number>;
      tools: Map<string, number>;
      models: Set<string>;
    }>();

    // Global aggregation
    let totalSessions = 0;
    let totalCost = 0;
    let sessionsWithoutPricing = 0; // models we don't have public prices for (Gemini, Ollama, custom)
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalDuration = 0;
    const globalLanguages = new Map<string, number>();
    const globalTools = new Map<string, number>();
    const globalModels = new Map<string, number>();

    // Top lists
    const sessionsByDuration: Array<{ id: string; slug: string; project: string; durationMs: number }> = [];
    const sessionsByCost: Array<{ id: string; slug: string; project: string; cost: number }> = [];
    const sessionsByTokens: Array<{ id: string; slug: string; project: string; tokens: number }> = [];

    // Daily cost (last 30 days)
    const dailyCost = new Map<string, number>();

    // Activity heatmap: [hour][dayOfWeek] = count
    const activityHeatmap: number[][] = Array.from({ length: 24 }, () => Array(7).fill(0));

    // Weekly trends
    const weeklyCost = new Map<string, number>();
    const weeklySessions = new Map<string, number>();
    const weeklyTokens = new Map<string, number>(); // input + output, exposed via periodComparison

    // Cache efficiency per week
    const weeklyCacheInput = new Map<string, number>();
    const weeklyCacheRead = new Map<string, number>();

    // Session outcomes
    const outcomes = new Map<string, number>();

    // Per-project descriptions from CLAUDE.md
    const projectDescriptions = new Map<string, string>();

    // Sessions by tool (Claude, Gemini, OpenCode)
    const sessionsByTool = new Map<string, number>();

    // Per-tool detailed stats
    const toolDetails = new Map<string, {
      sessions: number; cost: number; inputTokens: number; outputTokens: number;
      duration: number; languages: Map<string, number>; models: Map<string, number>;
      projects: Map<string, number>; tools: Map<string, number>;
    }>();
    const getToolDetail = (t: string) => {
      if (!toolDetails.has(t)) {
        toolDetails.set(t, { sessions: 0, cost: 0, inputTokens: 0, outputTokens: 0, duration: 0, languages: new Map(), models: new Map(), projects: new Map(), tools: new Map() });
      }
      return toolDetails.get(t)!;
    };

    // File hotspots across all sessions
    const fileHotspots = new Map<string, { count: number; projects: Set<string> }>();

    // Cost by model
    const costByModel = new Map<string, { cost: number; sessions: number; tokens: number }>();

    // Per-project weekly sessions (for velocity sparklines)
    const projectWeekly = new Map<string, Map<string, number>>();

    // Context exhaustion tracking
    const contextExhausted: Array<{ id: string; slug: string; project: string; peakTokens: number }> = [];

    // Context utilization distribution (% of context window used)
    const contextUtilBuckets = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 0-10%, 10-20%, ..., 90-100%

    // Iterate ALL session items from MemoryStore (Claude + Gemini + OpenCode + Codex)
    const allItems = await store.listItems('session' as SourceType, 10000, 0);
    // Also get Claude sessions from filesystem for those not yet in the store
    const storeIds = new Set(allItems.map(i => i.id));
    const claudeOnlyEntries: Array<{ sessionId: string; filePath: string; projectPath: string; created: string; modified: string; fileMtime: number }> = [];
    // When tool filter is active and not 'claude', skip the filesystem-only Claude
    // path entirely — those sessions are by definition Claude-only.
    if (!activeToolFilter || activeToolFilter === 'claude') {
      for (const [entry, filePath] of getAllSessions()) {
        if (!storeIds.has(entry.sessionId)) {
          claudeOnlyEntries.push({ sessionId: entry.sessionId, filePath, projectPath: entry.projectPath, created: entry.created, modified: entry.modified, fileMtime: entry.fileMtime });
        }
      }
    }

    // Process store items (all tools, optionally filtered by tool)
    for (const storeItem of allItems) {
      const extra = JSON.parse(storeItem.extra_json || '{}');
      // Apply tool filter before any aggregation so totals only count matching rows.
      const itemTool = (extra.tool as string) || 'claude';
      if (activeToolFilter && itemTool !== activeToolFilter) continue;
      totalSessions++;
      // For non-Claude tools, accept extra even without inputTokens
      const hasMeta = extra.inputTokens !== undefined || extra.tool;
      let meta: Record<string, any> | null = hasMeta ? extra : null;
      const entry = {
        sessionId: storeItem.id,
        projectPath: storeItem.project_path,
        created: new Date(storeItem.mtime).toISOString(),
        modified: new Date(storeItem.mtime).toISOString(),
        fileMtime: storeItem.mtime,
      };

      // Fall back to parsing JSONL for Claude sessions without metadata
      if (!meta && (!extra.tool || extra.tool === 'claude')) {
        try {
          const content = await parseSessionFile(storeItem.file_path);
          meta = content.metadata;
        } catch {
          continue;
        }
      }

      if (!meta) continue;

      // Track tool
      const tool = (meta.tool as string) || 'claude';
      sessionsByTool.set(tool, (sessionsByTool.get(tool) || 0) + 1);

      const cost = estimateCost(meta);
      // Use 0 only for the running totals; we still track unknowns separately so
      // the UI can show "N sessions don't have pricing data" instead of pretending.
      const costForAdd = cost ?? 0;
      if (cost === null) sessionsWithoutPricing++;

      // Per-tool detail
      const td = getToolDetail(tool);
      td.sessions++;
      const pName = entry.projectPath.split('/').pop() || entry.projectPath || '(unknown)';
      td.projects.set(pName, (td.projects.get(pName) || 0) + 1);
      td.cost += costForAdd;
      td.inputTokens += (meta.inputTokens || 0);
      td.outputTokens += (meta.outputTokens || 0);
      td.duration += (meta.durationMs || 0);
      for (const f of (meta.filesModified || [])) {
        const ext = (f as string).split('.').pop();
        if (ext && ext.length <= 10 && !['lock', 'map', 'min'].includes(ext)) {
          const lang = extToLang(ext);
          td.languages.set(lang, (td.languages.get(lang) || 0) + 1);
        }
      }
      for (const m of (meta.modelsUsed || [])) {
        if ((m as string) !== '<synthetic>') {
          td.models.set(m as string, (td.models.get(m as string) || 0) + 1);
        }
      }
      for (const t of (meta.toolsUsed || [])) {
        td.tools.set(t as string, (td.tools.get(t as string) || 0) + 1);
      }
      const projectName = entry.projectPath.split('/').pop() || entry.projectPath;
      const shortProject = entry.projectPath;

      // Global stats
      totalCost += costForAdd;
      totalInput += (meta.inputTokens || 0);
      totalOutput += (meta.outputTokens || 0);
      totalCacheRead += (meta.cacheReadTokens || 0);
      totalDuration += (meta.durationMs || 0);

      // Languages from file extensions
      const files: string[] = meta.filesModified || [];
      for (const f of files) {
        const ext = f.split('.').pop();
        if (ext && ext.length <= 10 && !['lock', 'map', 'min'].includes(ext)) {
          const lang = extToLang(ext);
          globalLanguages.set(lang, (globalLanguages.get(lang) || 0) + 1);
        }
      }

      // Tools
      const tools: string[] = meta.toolsUsed || [];
      for (const t of tools) {
        globalTools.set(t, (globalTools.get(t) || 0) + 1);
      }

      // Models
      const models: string[] = meta.modelsUsed || [];
      for (const m of models) {
        if (m !== '<synthetic>') {
          globalModels.set(m, (globalModels.get(m) || 0) + 1);
        }
      }

      // Per-project
      if (!projectStats.has(shortProject)) {
        projectStats.set(shortProject, {
          sessions: 0, totalCost: 0, totalDuration: 0,
          totalInput: 0, totalOutput: 0,
          languages: new Map(), tools: new Map(), models: new Set(),
        });
      }
      const ps = projectStats.get(shortProject)!;
      ps.sessions++;
      ps.totalCost += costForAdd;
      ps.totalDuration += (meta.durationMs || 0);
      ps.totalInput += (meta.inputTokens || 0);
      ps.totalOutput += (meta.outputTokens || 0);
      for (const f of files) {
        const ext = f.split('.').pop();
        if (ext && ext.length <= 10) {
          const lang = extToLang(ext);
          ps.languages.set(lang, (ps.languages.get(lang) || 0) + 1);
        }
      }
      for (const m of models) {
        if (m !== '<synthetic>') ps.models.add(m);
      }

      // Top lists
      const slug = meta.slug || entry.sessionId.slice(0, 8);
      if (meta.durationMs > 0) {
        sessionsByDuration.push({ id: entry.sessionId, slug, project: projectName, durationMs: meta.durationMs });
      }
      if (cost !== null && cost > 0) {
        sessionsByCost.push({ id: entry.sessionId, slug, project: projectName, cost });
      }
      if (meta.inputTokens > 0) {
        sessionsByTokens.push({ id: entry.sessionId, slug, project: projectName, tokens: meta.inputTokens });
      }

      // Daily cost
      const day = entry.modified?.slice(0, 10) || entry.created?.slice(0, 10);
      if (day) {
        dailyCost.set(day, (dailyCost.get(day) || 0) + costForAdd);
      }

      // Activity heatmap
      const date = new Date(entry.modified || entry.created);
      if (!isNaN(date.getTime())) {
        const hour = date.getHours();
        const dow = date.getDay();
        activityHeatmap[hour][dow]++;
      }

      // Weekly trends
      if (day) {
        const d = new Date(day);
        const weekStart = new Date(d);
        weekStart.setDate(d.getDate() - d.getDay());
        const week = weekStart.toISOString().slice(0, 10);
        weeklyCost.set(week, (weeklyCost.get(week) || 0) + costForAdd);
        weeklySessions.set(week, (weeklySessions.get(week) || 0) + 1);
        weeklyTokens.set(week, (weeklyTokens.get(week) || 0) + (meta.inputTokens || 0) + (meta.outputTokens || 0));
        weeklyCacheInput.set(week, (weeklyCacheInput.get(week) || 0) + (meta.inputTokens || 0));
        weeklyCacheRead.set(week, (weeklyCacheRead.get(week) || 0) + (meta.cacheReadTokens || 0));
      }

      // Session outcomes
      const outcome = meta.lastStopReason || 'unknown';
      outcomes.set(outcome, (outcomes.get(outcome) || 0) + 1);

      // File hotspots
      for (const f of files) {
        if (!fileHotspots.has(f)) {
          fileHotspots.set(f, { count: 0, projects: new Set() });
        }
        const fh = fileHotspots.get(f)!;
        fh.count++;
        fh.projects.add(projectName);
      }

      // Cost by model
      for (const m of models) {
        if (m === '<synthetic>') continue;
        if (!costByModel.has(m)) {
          costByModel.set(m, { cost: 0, sessions: 0, tokens: 0 });
        }
        const cm = costByModel.get(m)!;
        cm.cost += costForAdd / Math.max(models.filter(x => x !== '<synthetic>').length, 1);
        cm.sessions++;
        cm.tokens += (meta.inputTokens || 0) / Math.max(models.length, 1);
      }

      // Per-project weekly velocity
      if (day) {
        const d2 = new Date(day);
        const ws = new Date(d2);
        ws.setDate(d2.getDate() - d2.getDay());
        const weekKey = ws.toISOString().slice(0, 10);
        if (!projectWeekly.has(shortProject)) {
          projectWeekly.set(shortProject, new Map());
        }
        const pw = projectWeekly.get(shortProject)!;
        pw.set(weekKey, (pw.get(weekKey) || 0) + 1);
      }

      // Context exhaustion
      const peak = meta.peakContextTokens || 0;
      if (peak > 150000 || outcome === 'max_tokens') {
        contextExhausted.push({
          id: entry.sessionId,
          slug: meta.slug || entry.sessionId.slice(0, 8),
          project: projectName,
          peakTokens: peak,
        });
      }

      // Context utilization bucket
      if (peak > 0) {
        const primaryModel = (meta.modelsUsed || [])[0] || 'claude-sonnet-4-6';
        const limit = getModelContextLimit(primaryModel as string);
        const utilPct = Math.min((peak / limit) * 100, 100);
        const bucket = Math.min(Math.floor(utilPct / 10), 9);
        contextUtilBuckets[bucket]++;
      }
    }

    // Also process Claude sessions not yet in the store
    for (const claudeEntry of claudeOnlyEntries) {
      totalSessions++;
      sessionsByTool.set('claude', (sessionsByTool.get('claude') || 0) + 1);
      try {
        const content = await parseSessionFile(claudeEntry.filePath);
        const meta = content.metadata;
        if (meta) {
          const c = estimateCost(meta);
          if (c === null) sessionsWithoutPricing++;
          totalCost += c ?? 0;
          totalInput += meta.inputTokens || 0;
          totalOutput += meta.outputTokens || 0;
        }
      } catch {}
    }

    await store.close();
    await cache.close();

    // Load CLAUDE.md descriptions for known projects
    try {
      const { readFileSync, existsSync: exists } = await import('fs');
      for (const [projectPath] of projectStats) {
        const claudeMdPath = `${projectPath}/CLAUDE.md`;
        if (exists(claudeMdPath)) {
          try {
            const content = readFileSync(claudeMdPath, 'utf-8');
            let desc = '';

            // Only accept descriptions that look like actual project descriptions:
            // - From ## Project Overview: line must contain "is a" or "for" or describes what the project does
            // - Must have lowercase words (not all-caps instructions)
            // - Must not be an instruction/command/warning
            const isDescription = (t: string): boolean => {
              // Must have some lowercase
              if (!/[a-z]/.test(t)) return false;
              // Must not start with instruction patterns
              if (/^(NEVER|ALWAYS|DO NOT|CRITICAL|IMPORTANT|MANDATORY|WARNING|READ|STOP|FINISH|THE CORE|YOU |IF YOU|FIX |USE |RUN |CHECK |SET |ADD |INSTALL |FOLLOW |ENSURE |MAKE SURE)/i.test(t)) return false;
              // Must not be code/config
              if (/^["`'{(\[#\-*|>!]/.test(t)) return false;
              if (/gitnexus|claude-md|hooks?\/|TODO|symbols,|relationships,|codebase overview|index freshness/i.test(t)) return false;
              // Should sound like a description (contains "is a", "for", "that", "with", "using", project-descriptive words)
              if (/\b(is a|is an|for |that |which |using |enables? |provides? |manages? |tracks? |platform|system|tool|service|bot|framework|library|cluster|infrastructure)\b/i.test(t)) return true;
              // At least 30 chars and contains both upper and lowercase
              if (t.length >= 30 && /[A-Z]/.test(t) && /[a-z]/.test(t) && !/[:!]{2,}/.test(t)) return true;
              return false;
            };

            // Strategy 1: ## Project Overview section
            const overviewMatch = content.match(/##\s*(?:Project\s+)?Overview\s*\n+([\s\S]*?)(?=\n##|\n```|$)/i);
            if (overviewMatch) {
              for (const line of overviewMatch[1].split('\n')) {
                const t = line.replace(/^\*\*(.+?)\*\*\s*/, '$1 — ').trim();
                if (t.length >= 20 && isDescription(t)) {
                  desc = t.slice(0, 200);
                  break;
                }
              }
            }

            // Strategy 2: README.md first paragraph
            if (!desc) {
              const readmePath = `${projectPath}/README.md`;
              if (exists(readmePath)) {
                try {
                  const readme = readFileSync(readmePath, 'utf-8');
                  for (const line of readme.split('\n')) {
                    const t = line.trim();
                    if (t.length >= 20 && isDescription(t)) {
                      desc = t.slice(0, 200);
                      break;
                    }
                  }
                } catch {}
              }
            }

            if (desc) projectDescriptions.set(projectPath, desc);
          } catch {}
        }
      }
    } catch {}

    // Sort top lists
    sessionsByDuration.sort((a, b) => b.durationMs - a.durationMs);
    sessionsByCost.sort((a, b) => b.cost - a.cost);
    sessionsByTokens.sort((a, b) => b.tokens - a.tokens);

    // Sort daily cost
    const dailyCostSorted = [...dailyCost.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-30);

    // Build project summary
    const projects = [...projectStats.entries()]
      .map(([path, ps]) => ({
        path,
        name: path.split('/').pop() || path,
        sessions: ps.sessions,
        totalCost: Math.round(ps.totalCost * 100) / 100,
        totalDurationMin: Math.round(ps.totalDuration / 60000),
        totalInputTokens: ps.totalInput,
        totalOutputTokens: ps.totalOutput,
        languages: [...ps.languages.entries()].sort((a, b) => b[1] - a[1]).map(([l, c]) => ({ language: l, files: c })),
        models: [...ps.models],
        description: projectDescriptions.get(path) || '',
        weeklyVelocity: (() => {
          const pw = projectWeekly.get(path);
          if (!pw) return [];
          return [...pw.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-8).map(([, count]) => count);
        })(),
      }))
      .sort((a, b) => b.sessions - a.sessions);

    const result = {
      summary: {
        totalSessions,
        totalCostUsd: Math.round(totalCost * 100) / 100,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        totalCacheReadTokens: totalCacheRead,
        totalDurationMin: Math.round(totalDuration / 60000),
        // Average is across sessions that DID have a known model price; otherwise
        // a flood of Gemini/Ollama sessions would drag the avg toward zero.
        avgCostPerSession: (() => {
          const priced = totalSessions - sessionsWithoutPricing;
          if (priced <= 0) return 0;
          return Math.round((totalCost / priced) * 100) / 100;
        })(),
        avgDurationMin: Math.round(totalDuration / 60000 / Math.max(totalSessions, 1)),
        sessionsWithoutPricing,
      },
      topByDuration: sessionsByDuration.slice(0, 10).map(s => ({
        ...s, durationMin: Math.round(s.durationMs / 60000),
      })),
      topByCost: sessionsByCost.slice(0, 10).map(s => ({
        ...s, cost: Math.round(s.cost * 100) / 100,
      })),
      topByTokens: sessionsByTokens.slice(0, 10).map(s => ({
        ...s, tokensM: Math.round(s.tokens / 1e6 * 10) / 10,
      })),
      languages: [...globalLanguages.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([lang, files]) => ({ language: lang, files })),
      tools: [...globalTools.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([tool, sessions]) => ({ tool, sessions })),
      models: [...globalModels.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([model, sessions]) => ({ model, sessions })),
      dailyCost: dailyCostSorted.map(([day, cost]) => ({
        day, cost: Math.round(cost * 100) / 100,
      })),
      projects: projects.slice(0, 20),
      activityHeatmap,
      weeklyTrends: [...weeklyCost.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-12)
        .map(([week, cost]) => ({
          week,
          cost: Math.round(cost * 100) / 100,
          sessions: weeklySessions.get(week) || 0,
          cacheRate: weeklyCacheInput.get(week)
            ? Math.round((weeklyCacheRead.get(week) || 0) / weeklyCacheInput.get(week)! * 100)
            : 0,
        })),
      outcomes: [...outcomes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, count })),
      sessionsByTool: [...sessionsByTool.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([tool, count]) => ({ tool, count })),
      toolDetails: Object.fromEntries(
        [...toolDetails.entries()].map(([tool, d]) => [tool, {
          sessions: d.sessions,
          cost: Math.round(d.cost * 100) / 100,
          inputTokens: d.inputTokens,
          outputTokens: d.outputTokens,
          durationMin: Math.round(d.duration / 60000),
          languages: [...d.languages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([l, c]) => ({ language: l, files: c })),
          models: [...d.models.entries()].sort((a, b) => b[1] - a[1]).map(([m, c]) => ({ model: m, count: c })),
          projects: [...d.projects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([p, c]) => ({ project: p, count: c })),
          tools: [...d.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, c]) => ({ tool: t, count: c })),
        }])
      ),
      fileHotspots: [...fileHotspots.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 20)
        .map(([file, { count, projects }]) => ({
          file: file.length > 80 ? '...' + file.slice(-77) : file,
          count,
          projects: [...projects].slice(0, 3),
        })),
      costByModel: [...costByModel.entries()]
        .sort((a, b) => b[1].cost - a[1].cost)
        .map(([model, { cost, sessions, tokens }]) => ({
          model,
          cost: Math.round(cost * 100) / 100,
          sessions,
          tokensM: Math.round(tokens / 1e6),
        })),
      contextExhausted: contextExhausted
        .sort((a, b) => b.peakTokens - a.peakTokens)
        .slice(0, 10)
        .map(s => ({ ...s, peakK: Math.round(s.peakTokens / 1000) })),
      contextUtilization: contextUtilBuckets.map((count, i) => ({
        range: `${i * 10}-${(i + 1) * 10}%`,
        count,
      })),
      periodComparison: (() => {
        // Use the same week-start logic as the main loop (UTC-based)
        const now = new Date();
        const thisWeekStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
        thisWeekStart.setUTCDate(thisWeekStart.getUTCDate() - thisWeekStart.getUTCDay());
        const lastWeekStart = new Date(thisWeekStart);
        lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 7);

        const thisWeekKey = thisWeekStart.toISOString().slice(0, 10);
        const lastWeekKey = lastWeekStart.toISOString().slice(0, 10);

        return {
          thisWeek: {
            sessions: weeklySessions.get(thisWeekKey) || 0,
            cost: Math.round((weeklyCost.get(thisWeekKey) || 0) * 100) / 100,
            tokens: weeklyTokens.get(thisWeekKey) || 0,
            cacheRate: weeklyCacheInput.get(thisWeekKey)
              ? Math.round((weeklyCacheRead.get(thisWeekKey) || 0) / weeklyCacheInput.get(thisWeekKey)! * 100)
              : 0,
          },
          lastWeek: {
            sessions: weeklySessions.get(lastWeekKey) || 0,
            cost: Math.round((weeklyCost.get(lastWeekKey) || 0) * 100) / 100,
            tokens: weeklyTokens.get(lastWeekKey) || 0,
            cacheRate: weeklyCacheInput.get(lastWeekKey)
              ? Math.round((weeklyCacheRead.get(lastWeekKey) || 0) / weeklyCacheInput.get(lastWeekKey)! * 100)
              : 0,
          },
        };
      })(),
    };

    // Only cache the unfiltered (whole-fleet) result. Per-tool slices are
    // recomputed on demand — they're small relative to the unfiltered run.
    if (!activeToolFilter) {
      analyticsCache = result;
      analyticsCacheTime = now;
    }
    res.json(result);
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to compute analytics',
    });
  }
});

/**
 * GET /api/analytics/patterns
 *
 * Cross-session pattern data for the Insights/Patterns panel:
 *  - hotFiles:        files touched in the most sessions (with project + recency)
 *  - filesByProject:  per-project list of most-touched files in the last 30 days
 *  - sessionsByTopic: rough clustering of sessions by frequent classifier-tagged
 *                     keywords (decisions / milestones / preferences)
 *  - redundancyPairs: pairs of sessions in the same project with significant file overlap
 *
 * All computed from existing extra_json metadata — no new indexing needed.
 */
router.get('/patterns', async (_req, res) => {
  try {
    const store = await createStore();
    try {
      const items = await store.listItems('session' as SourceType, 5000, 0);

      // ── Hot files: how many distinct sessions touched this file? ─────
      const fileCount = new Map<string, {
        count: number;
        lastTouch: number;
        projects: Set<string>;
        sessions: string[];
      }>();
      // Per-project recency view + redundancy pairs.
      const filesByProj = new Map<string, Array<{ id: string; mtime: number; files: string[] }>>();

      for (const item of items) {
        let extra: any = {};
        try { extra = JSON.parse(item.extra_json || '{}'); } catch {}
        const files: string[] = Array.isArray(extra.filesModified) ? extra.filesModified : [];
        if (files.length === 0) continue;

        const proj = item.project_path || '(unknown)';
        if (!filesByProj.has(proj)) filesByProj.set(proj, []);
        filesByProj.get(proj)!.push({ id: item.id, mtime: item.mtime, files });

        for (const f of files) {
          if (!fileCount.has(f)) {
            fileCount.set(f, { count: 0, lastTouch: 0, projects: new Set(), sessions: [] });
          }
          const fc = fileCount.get(f)!;
          fc.count++;
          if (item.mtime > fc.lastTouch) fc.lastTouch = item.mtime;
          fc.projects.add(proj);
          if (fc.sessions.length < 6) fc.sessions.push(item.id);
        }
      }

      const hotFiles = [...fileCount.entries()]
        .filter(([, v]) => v.count >= 2)
        .sort((a, b) => b[1].count - a[1].count || b[1].lastTouch - a[1].lastTouch)
        .slice(0, 25)
        .map(([file, v]) => ({
          file,
          touchedInSessions: v.count,
          lastTouch: new Date(v.lastTouch).toISOString(),
          projects: [...v.projects],
          sampleSessionIds: v.sessions,
        }));

      // ── Per-project hot files (last 30 days) ─────────────────────────
      const since = Date.now() - 30 * 86400 * 1000;
      const filesByProjectRecent: Record<string, Array<{ file: string; count: number; lastTouch: string }>> = {};
      for (const [proj, sessions] of filesByProj) {
        const counts = new Map<string, { count: number; lastTouch: number }>();
        for (const s of sessions) {
          if (s.mtime < since) continue;
          for (const f of s.files) {
            if (!counts.has(f)) counts.set(f, { count: 0, lastTouch: 0 });
            const c = counts.get(f)!;
            c.count++;
            if (s.mtime > c.lastTouch) c.lastTouch = s.mtime;
          }
        }
        const top = [...counts.entries()]
          .sort((a, b) => b[1].count - a[1].count || b[1].lastTouch - a[1].lastTouch)
          .slice(0, 8)
          .map(([file, v]) => ({ file, count: v.count, lastTouch: new Date(v.lastTouch).toISOString() }));
        if (top.length > 0) filesByProjectRecent[proj] = top;
      }

      // ── Redundancy pairs: same project, large file-set overlap ───────
      // Compares the ≤40 most-recent sessions per project — older pairs are
      // less actionable for "are we redoing work right now".
      const redundancyPairs: Array<{
        projectPath: string;
        a: { id: string; mtime: string };
        b: { id: string; mtime: string };
        sharedFiles: string[];
        overlap: number;
      }> = [];
      for (const [proj, sessions] of filesByProj) {
        const recent = sessions
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 40);
        for (let i = 0; i < recent.length; i++) {
          for (let j = i + 1; j < recent.length; j++) {
            const a = recent[i];
            const b = recent[j];
            const setA = new Set(a.files);
            const shared = b.files.filter(f => setA.has(f));
            if (shared.length < 3) continue;
            // Jaccard-style overlap, biased by shared count so big files lists rank well.
            const overlap = shared.length / Math.min(a.files.length, b.files.length);
            if (overlap < 0.3) continue;
            redundancyPairs.push({
              projectPath: proj,
              a: { id: a.id, mtime: new Date(a.mtime).toISOString() },
              b: { id: b.id, mtime: new Date(b.mtime).toISOString() },
              sharedFiles: shared.slice(0, 8),
              overlap: Math.round(overlap * 100) / 100,
            });
          }
        }
      }
      redundancyPairs.sort((a, b) => b.overlap - a.overlap || b.sharedFiles.length - a.sharedFiles.length);

      // ── Topic clusters from chunk classifier tags ────────────────────
      // FTS5 already tags chunks like "assistant:decision:imp4". We use the
      // FTS5 search to find the top decisions/milestones/preferences and bucket
      // them by the entity-extractor's per-project KG, falling back to project
      // path when KG entities aren't available.
      const topics: Array<{
        topic: string;
        sessionCount: number;
        sampleSessions: Array<{ id: string; project: string; snippet: string }>;
      }> = [];
      try {
        const kw = ['authentication', 'oauth', 'login', 'database', 'migration', 'docker', 'kubernetes',
                    'deploy', 'test', 'ci', 'refactor', 'api', 'rate limit', 'cache', 'queue',
                    'webhook', 'config', 'session', 'memory', 'embedding', 'vector', 'search'];
        for (const k of kw) {
          // True session count: COUNT(DISTINCT item_id) instead of "topK
          // unique items from a 150-row LIMIT" (which capped every popular
          // keyword at ~30 — the bug Insights surfaced as identical counts).
          const sessionCount = await store.countDistinctItemsMatching(k, {
            sourceTypes: ['session' as SourceType],
          });
          if (sessionCount < 2) continue;

          // Sample 4 ranked hits for the topic snippet preview. We still
          // want ranked rows here, just a small batch — so cap at topK=8.
          const hits = await store.searchFTS(k, { topK: 8, sourceTypes: ['session' as SourceType] });
          const seen = new Set<string>();
          const samples: { id: string; project: string; snippet: string }[] = [];
          for (const h of hits) {
            if (seen.has(h.itemId)) continue;
            seen.add(h.itemId);
            samples.push({
              id: h.itemId,
              project: h.projectPath,
              snippet: (h.text || h.title || '').replace(/\s+/g, ' ').slice(0, 140),
            });
            if (samples.length >= 4) break;
          }

          topics.push({
            topic: k,
            sessionCount,
            sampleSessions: samples,
          });
        }
      } catch { /* FTS not available */ }
      topics.sort((a, b) => b.sessionCount - a.sessionCount);

      res.json({
        hotFiles,
        filesByProjectRecent,
        redundancyPairs: redundancyPairs.slice(0, 10),
        topics: topics.slice(0, 12),
        meta: {
          sessionsAnalyzed: items.filter(i => i.extra_json && i.extra_json !== '{}').length,
          generatedAt: new Date().toISOString(),
        },
      });
    } finally {
      await store.close();
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
