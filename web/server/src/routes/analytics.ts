/**
 * Analytics routes - aggregated stats across all sessions.
 */

import express from 'express';
import { getAllSessions, parseSessionFile, MetadataCache, MemoryStore } from '../imports.js';
import type { SessionEntry, SourceType } from '../imports.js';
import { getModelContextLimit } from '../../../../src/core/utils.js';

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

/** Pricing table (cost per million tokens) */
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-4-6':   { input: 15,  output: 75,  cacheRead: 1.5 },
  'claude-sonnet-4-6': { input: 3,   output: 15,  cacheRead: 0.3 },
  'claude-haiku-4-5':  { input: 0.8, output: 4,   cacheRead: 0.08 },
  'claude-sonnet-4-5': { input: 3,   output: 15,  cacheRead: 0.3 },
};

function getModelPricing(model: string) {
  if (PRICING[model]) return PRICING[model];
  for (const [key, val] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return val;
  }
  return PRICING['claude-sonnet-4-6'];
}

function estimateCost(meta: Record<string, any>): number {
  const models: string[] = meta.modelsUsed || [];
  const pricing = getModelPricing(models[0] || 'claude-sonnet-4-6');
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
router.get('/', async (_req, res) => {
  try {
    const now = Date.now();
    if (analyticsCache && (now - analyticsCacheTime) < CACHE_TTL_MS) {
      return res.json(analyticsCache);
    }

    const store = new MemoryStore();
    const cache = new MetadataCache();

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

    // Iterate ALL session items from MemoryStore (Claude + Gemini + OpenCode)
    const allItems = store.listItems('session' as SourceType, 10000, 0);
    // Also get Claude sessions from filesystem for those not yet in the store
    const storeIds = new Set(allItems.map(i => i.id));
    const claudeOnlyEntries: Array<{ sessionId: string; filePath: string; projectPath: string; created: string; modified: string; fileMtime: number }> = [];
    for (const [entry, filePath] of getAllSessions()) {
      if (!storeIds.has(entry.sessionId)) {
        claudeOnlyEntries.push({ sessionId: entry.sessionId, filePath, projectPath: entry.projectPath, created: entry.created, modified: entry.modified, fileMtime: entry.fileMtime });
      }
    }

    // Process store items (all tools)
    for (const storeItem of allItems) {
      totalSessions++;
      const extra = JSON.parse(storeItem.extra_json || '{}');
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

      // Per-tool detail
      const td = getToolDetail(tool);
      td.sessions++;
      const pName = entry.projectPath.split('/').pop() || entry.projectPath || '(unknown)';
      td.projects.set(pName, (td.projects.get(pName) || 0) + 1);
      td.cost += cost;
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
      totalCost += cost;
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
      ps.totalCost += cost;
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
      if (cost > 0) {
        sessionsByCost.push({ id: entry.sessionId, slug, project: projectName, cost });
      }
      if (meta.inputTokens > 0) {
        sessionsByTokens.push({ id: entry.sessionId, slug, project: projectName, tokens: meta.inputTokens });
      }

      // Daily cost
      const day = entry.modified?.slice(0, 10) || entry.created?.slice(0, 10);
      if (day) {
        dailyCost.set(day, (dailyCost.get(day) || 0) + cost);
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
        weeklyCost.set(week, (weeklyCost.get(week) || 0) + cost);
        weeklySessions.set(week, (weeklySessions.get(week) || 0) + 1);
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
        cm.cost += cost / Math.max(models.filter(x => x !== '<synthetic>').length, 1);
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
          totalCost += estimateCost(meta);
          totalInput += meta.inputTokens || 0;
          totalOutput += meta.outputTokens || 0;
        }
      } catch {}
    }

    store.close();
    cache.close();

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
        avgCostPerSession: Math.round((totalCost / Math.max(totalSessions, 1)) * 100) / 100,
        avgDurationMin: Math.round(totalDuration / 60000 / Math.max(totalSessions, 1)),
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
            cacheRate: weeklyCacheInput.get(thisWeekKey)
              ? Math.round((weeklyCacheRead.get(thisWeekKey) || 0) / weeklyCacheInput.get(thisWeekKey)! * 100)
              : 0,
          },
          lastWeek: {
            sessions: weeklySessions.get(lastWeekKey) || 0,
            cost: Math.round((weeklyCost.get(lastWeekKey) || 0) * 100) / 100,
            cacheRate: weeklyCacheInput.get(lastWeekKey)
              ? Math.round((weeklyCacheRead.get(lastWeekKey) || 0) / weeklyCacheInput.get(lastWeekKey)! * 100)
              : 0,
          },
        };
      })(),
    };

    analyticsCache = result;
    analyticsCacheTime = now;
    res.json(result);
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to compute analytics',
    });
  }
});

export default router;
