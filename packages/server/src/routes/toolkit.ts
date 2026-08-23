/**
 * Toolkit routes — config-y primitives that span AI tools (Claude, Gemini,
 * OpenCode, Codex). These are surfaced under the dedicated Toolkit UI tab.
 *
 * Distinct from /api/memory/* which handles "what was said / what happened"
 * primitives (sessions, plans, notes, tasks, paste, history, diary). Both
 * routes back the same MemoryStore but expose different validators so the
 * UI separation is honest at the API layer too.
 */

import express from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { createStore, copyArtifactToTool, rowFromStore, skillsDirFor, currentTenant, createControlPlane } from '../imports.js';
import type { SourceType } from '../imports.js';
import { requireLocalMode } from '../util/mode.js';
import { listItemsPaged } from '../util/paged-items.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import {
  SUPPORTED_TARGETS as ENGINE_SUPPORTED_TARGETS,
  SOURCE_PRECEDENCE as ENGINE_SOURCE_PRECEDENCE,
} from '@chat-recall/engine/core/toolkit-sync.js';

const log = createLogger('toolkit');

const router = express.Router();

const VALID_TOOLKIT_TYPES = ['skill', 'mcp', 'command', 'agent', 'hook', 'plugin', 'instructions'] as const;
type ToolkitType = (typeof VALID_TOOLKIT_TYPES)[number];

function isToolkitType(t: string): t is ToolkitType {
  return (VALID_TOOLKIT_TYPES as readonly string[]).includes(t);
}

// GET /api/toolkit/status — counts per (type, tool) so the UI can render
// "skill: 43 claude · 43 opencode · 0 gemini" without listing items.
router.get('/status', async (_req, res) => {
  const store = await createStore();
  try {
    const out: Record<string, Record<string, number>> = {};
    for (const t of VALID_TOOLKIT_TYPES) {
      out[t] = Object.fromEntries(TARGET_TOOLS.map((tool) => [tool, 0]));
      // Paged (1000-row chunks) with the pre-existing 5k cap — flat memory.
      const items = await listItemsPaged(store, t as SourceType, { cap: 5000, context: 'toolkit-status' });
      for (const it of items) {
        let tool = 'claude';
        try { tool = JSON.parse(it.extra_json || '{}').tool || 'claude'; } catch {}
        if (tool in out[t]) out[t][tool]++;
      }
    }
    res.json({ counts: out });
  } catch (error) {
    log.error({ err: error }, 'toolkit status error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally { await store.close(); }
});

// GET /api/toolkit/browse/:type?limit=&offset=&tool=
router.get('/browse/:type', async (req, res) => {
  const { type } = req.params;
  if (!isToolkitType(type)) {
    return res.status(400).json({ error: `Invalid toolkit type: ${type}. Allowed: ${VALID_TOOLKIT_TYPES.join(', ')}` });
  }
  const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 200, 5000));
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const toolFilter = (req.query.tool as string | undefined)?.trim().toLowerCase();

  const store = await createStore();
  try {
    let items = await store.listItems(type as SourceType, limit + offset + 100, 0);
    if (toolFilter && toolFilter !== 'all') {
      items = items.filter(it => {
        try { return (JSON.parse(it.extra_json || '{}').tool || 'claude') === toolFilter; }
        catch { return toolFilter === 'claude'; }
      });
    }
    items = items.slice(offset, offset + limit);
    res.json({ items, type, count: items.length });
  } catch (error) {
    log.error({ err: error }, 'toolkit browse error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally { await store.close(); }
});

// GET /api/toolkit/item/:type/:id
router.get('/item/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!isToolkitType(type)) {
    return res.status(400).json({ error: `Invalid toolkit type: ${type}` });
  }
  const store = await createStore();
  try {
    const item = await store.getItem(id, type as SourceType);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (error) {
    log.error({ err: error }, 'toolkit item error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally { await store.close(); }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/toolkit/promote
//
// Body: { type, sourceId, toTool }
// Copies a toolkit primitive from one AI tool's storage into another.
// Skill: cp -r ~/.claude/skills/<name>/ → ~/.config/opencode/skill/<name>/
// MCP:   read source config, merge entry into target tool's config file
// Note:  cp CLAUDE.md → GEMINI.md or AGENTS.md in same project dir
// ─────────────────────────────────────────────────────────────────

const TARGET_TOOLS = ['claude', 'agy', 'gemini', 'opencode', 'codex', 'cursor'] as const;
type TargetTool = (typeof TARGET_TOOLS)[number];

/** Toolkit primitives that have a clean global-scope cross-tool matrix. */
type SyncType = 'skill' | 'mcp' | 'command' | 'agent' | 'instructions';

// Imported, not re-declared. This table used to be copied here and into the
// web client, and the three drifted: the server's SOURCE_PRECEDENCE below had
// lost `agy` entirely. The engine owns it now.
const SUPPORTED_TARGETS = ENGINE_SUPPORTED_TARGETS as Record<SyncType, TargetTool[]>;

/** The extra_json field holding an artifact's display name, per type. */
const NAME_FIELD: Record<SyncType, string> = {
  skill: 'skillName', mcp: 'mcpName', command: 'commandName', agent: 'agentName', instructions: 'filename',
};


router.post('/promote', requireLocalMode, express.json(), async (req, res) => {
  const { type, sourceId, toTool } = req.body || {};
  if (!isToolkitType(type)) return res.status(400).json({ error: `Invalid type: ${type}` });
  if (typeof sourceId !== 'string' || !sourceId) return res.status(400).json({ error: 'sourceId required' });
  if (!(TARGET_TOOLS as readonly string[]).includes(toTool)) {
    return res.status(400).json({ error: `Invalid toTool: ${toTool}. Allowed: ${TARGET_TOOLS.join(', ')}` });
  }

  const store = await createStore();
  try {
    const item = await store.getItem(sourceId, type as SourceType);
    if (!item) return res.status(404).json({ error: 'Source item not found' });

    let extra: Record<string, unknown> = {};
    try { extra = JSON.parse(item.extra_json || '{}'); } catch {}
    const fromTool = (extra.tool as string) || 'claude';
    if (fromTool === toTool) {
      return res.status(400).json({ error: 'Source and target tool are the same' });
    }
    // Read-only sources (Codex `.system` skills, plugin-bundled skills, shared
    // ~/.agents skills) are never a promotion source.
    if (extra.readonly) {
      return res.status(400).json({ error: 'This artifact is read-only (system/bundled) and cannot be promoted.' });
    }

    if (type === 'skill' || type === 'mcp' || type === 'command' || type === 'agent' || type === 'instructions') {
      // The single copy implementation lives in the engine executor (shared
      // with the CLI agent). The route just adapts the store row and delegates.
      const r = copyArtifactToTool(type, rowFromStore(type, item), toTool as TargetTool);
      if (!r.ok) return res.status(r.status || 500).json({ error: r.error });
      return res.json({ ok: true, targetPath: r.targetPath });
    }
    return res.status(400).json({ error: `Promotion not supported for type: ${type}` });
  } catch (error) {
    log.error({ err: error }, 'promote error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally { await store.close(); }
});

interface PromoteResult {
  ok: boolean;
  targetPath?: string;
  error?: string;
  status?: number;
}

// ─────────────────────────────────────────────────────────────────
// DELETE /api/toolkit/item
//
// Body: { type: 'skill'|'mcp', name, tool }
// Removes one entry from one tool. For Skills, deletes the on-disk dir.
// For MCPs in JSON-backed tools (claude/gemini/opencode), deletes the
// keyed entry. For Codex MCPs (TOML), rewrites the file without the
// [mcp_servers.<name>] block.
// ─────────────────────────────────────────────────────────────────

router.delete('/item', requireLocalMode, express.json(), (req, res) => {
  const { type, name, tool } = req.body || {};
  if (type !== 'skill' && type !== 'mcp') return res.status(400).json({ error: 'type must be "skill" or "mcp"' });
  if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'name required' });
  if (!(TARGET_TOOLS as readonly string[]).includes(tool)) {
    return res.status(400).json({ error: `invalid tool: ${tool}` });
  }

  try {
    if (type === 'skill') {
      const r = removeSkillFromTool(name, tool as TargetTool);
      if (!r.ok) return res.status(r.status || 500).json({ error: r.error });
      return res.json({ ok: true, removedPath: r.targetPath });
    }
    const r = removeMcpFromTool(name, tool as TargetTool);
    if (!r.ok) return res.status(r.status || 500).json({ error: r.error });
    return res.json({ ok: true, removedPath: r.targetPath });
  } catch (error) {
    log.error({ err: error }, 'remove error');
    return res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  }
});

function removeSkillFromTool(name: string, tool: TargetTool): PromoteResult {
  const root = skillsDirFor(tool);
  const dir = join(root, name);
  if (!existsSync(dir)) return { ok: false, status: 404, error: `Not found: ${dir}` };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, targetPath: dir };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : 'rm failed' };
  }
}

function removeMcpFromTool(name: string, tool: TargetTool): PromoteResult {
  const home = homedir();

  if (tool === 'codex') {
    const path = join(home, '.codex', 'config.toml');
    if (!existsSync(path)) return { ok: false, status: 404, error: 'config.toml not found' };
    const before = readFileSync(path, 'utf-8');
    const after = stripCodexMcpBlock(before, name);
    if (before === after) return { ok: false, status: 404, error: `MCP "${name}" not found in ${path}` };
    try {
      writeFileSync(path, after);
      return { ok: true, targetPath: path };
    } catch (e) {
      return { ok: false, status: 500, error: e instanceof Error ? e.message : 'write failed' };
    }
  }

  let path: string; let key: string;
  if (tool === 'claude') {
    // ~/.mcp.json is the conventional global file. ~/.claude.json carries
    // user-level entries; we only delete from the file that actually has it.
    const cands = [
      { path: join(home, '.mcp.json'),    key: 'mcpServers' },
      { path: join(home, '.claude.json'), key: 'mcpServers' },
    ];
    for (const c of cands) {
      if (!existsSync(c.path)) continue;
      try {
        const cfg = JSON.parse(readFileSync(c.path, 'utf-8'));
        if (cfg[c.key] && cfg[c.key][name]) {
          delete cfg[c.key][name];
          writeFileSync(c.path, JSON.stringify(cfg, null, 2));
          return { ok: true, targetPath: c.path };
        }
      } catch { /* try next */ }
    }
    return { ok: false, status: 404, error: `MCP "${name}" not found in claude configs` };
  } else if (tool === 'gemini') {
    path = join(home, '.gemini', 'settings.json'); key = 'mcpServers';
  } else {
    // opencode — try both possible locations
    const cands = [
      { path: join(home, '.config', 'opencode', 'config.json'), key: 'mcp' },
      { path: join(home, '.opencode', 'config.json'),           key: 'mcp' },
    ];
    for (const c of cands) {
      if (!existsSync(c.path)) continue;
      try {
        const cfg = JSON.parse(readFileSync(c.path, 'utf-8'));
        if (cfg[c.key] && cfg[c.key][name]) {
          delete cfg[c.key][name];
          writeFileSync(c.path, JSON.stringify(cfg, null, 2));
          return { ok: true, targetPath: c.path };
        }
      } catch { /* try next */ }
    }
    return { ok: false, status: 404, error: `MCP "${name}" not found in opencode configs` };
  }

  if (!existsSync(path)) return { ok: false, status: 404, error: `${path} not found` };
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf-8'));
    if (!cfg[key] || !cfg[key][name]) return { ok: false, status: 404, error: `MCP "${name}" not found in ${path}` };
    delete cfg[key][name];
    writeFileSync(path, JSON.stringify(cfg, null, 2));
    return { ok: true, targetPath: path };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : 'failed' };
  }
}

/**
 * Strip a `[mcp_servers.<name>]` section (and its `.env` sub-section)
 * from a Codex config.toml without disturbing other entries.
 */
function stripCodexMcpBlock(content: string, name: string): string {
  const out: string[] = [];
  let inTarget = false;
  for (const line of content.split('\n')) {
    const m = line.match(/^\[mcp_servers\.([^\.\]]+)(?:\.([^\]]+))?\]$/);
    if (m) {
      inTarget = m[1] === name;
      if (inTarget) continue;
    }
    if (!inTarget) out.push(line);
  }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────
// GET /api/toolkit/matrix
//
// Returns { skill, mcp } × name × tool presence map for the cross-tool
// matrix UI. Avoids the client having to scan every row.
// ─────────────────────────────────────────────────────────────────

router.get('/matrix', async (_req, res) => {
  const store = await createStore();
  const tenant = currentTenant() || 'default';
  const cp = await createControlPlane();
  try {
    const types: SyncType[] = ['skill', 'mcp', 'command', 'agent', 'instructions'];
    // Each cell holds the source row id (so the UI can promote a precise
    // item), not just a boolean. Truthiness still answers "is it present?".
    const out: Record<SyncType, Record<string, Record<string, string>>> =
      { skill: {}, mcp: {}, command: {}, agent: {}, instructions: {} };
    const deviceSet = new Set<string>();
    // Liveness per device: a column whose agent hasn't checked in can't apply
    // anything you queue into it, and the grid gave no hint of that — so a
    // dead machine looked exactly like a live one with missing artifacts.
    const deviceMeta: Record<string, { lastSeenAt: number | null; cliVersion: string | null; os: string | null }> = {};

    try {
      const tokens = await cp.listAgentTokens(tenant);
      for (const t of tokens) {
        if (t.revoked) continue;
        deviceSet.add(t.deviceId);
        deviceMeta[t.deviceId] = { lastSeenAt: t.lastSeenAt, cliVersion: t.cliVersion, os: t.os };
      }
    } catch {
      // ignore control plane errors
    }

    for (const type of types) {
      // Paged in 1000-row chunks, 20k hard cap (was a single 100k fetch) —
      // the helper warns when the cap truncates the matrix for a tenant.
      const rows = await listItemsPaged(store, type as SourceType, { cap: 20_000, context: 'toolkit-matrix' });
      for (const row of rows) {
        let extra: any = {};
        try { extra = JSON.parse(row.extra_json || '{}'); } catch { /* skip */ }
        // System/bundled/shared artifacts aren't sync candidates — keep them
        // out of the matrix so the UI never offers to fan them out.
        if (extra.readonly || extra.shared) continue;
        const tool = String(extra.tool || 'claude');
        const name = String(extra[NAME_FIELD[type]] || row.title);
        if (!name) continue;
        const deviceId = String(extra.syncedDeviceId || 'local');
        deviceSet.add(deviceId);

        out[type][name] = out[type][name] || {};
        const key = `${deviceId}:${tool}`;
        // First writer wins per tool — stable id for the cell.
        if (!out[type][name][key]) out[type][name][key] = row.id;
      }
    }

    let pendingIntents: any[] = [];
    try {
      pendingIntents = await store.listAllPendingSyncIntents(1000);
    } catch { /* ignore */ }

    res.json({ ...out, supportedTargets: SUPPORTED_TARGETS, devices: Array.from(deviceSet), deviceMeta, pendingIntents });
  } catch (error) {
    log.error({ err: error }, 'matrix error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally {
    await store.close();
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/toolkit/sync-all
//
// Body: { types?: ['skill'|'mcp'][], dryRun?: boolean }
//
// For each (type, name) pair the indexer knows about, decide which tools
// should have it (every tool that supports the type) and copy the source
// content into every tool that's missing it. Idempotent: existing entries
// are reported as "skipped: already_exists", never overwritten. Conflicts
// where two source tools have the same name are resolved by precedence:
//   skill: claude > codex > opencode  (gemini has no skills surface)
//   mcp:   claude > codex > gemini > opencode
//
// dryRun returns the plan without writing anything.
// ─────────────────────────────────────────────────────────────────

const SOURCE_PRECEDENCE = ENGINE_SOURCE_PRECEDENCE as Record<SyncType, TargetTool[]>;

interface SyncPlanEntry {
  type: SyncType;
  name: string;
  source: TargetTool;       // tool we'll copy from
  presentIn: TargetTool[];  // tools that already have this row
  copyTo: TargetTool[];     // tools we'll write to (when not dryRun)
}

interface SyncResultEntry extends SyncPlanEntry {
  copied: { tool: TargetTool; targetPath?: string }[];
  skipped: { tool: TargetTool; reason: string }[];
  errors: { tool: TargetTool; error: string }[];
}

function readField(item: any, key: string): unknown {
  try { return JSON.parse(item.extra_json || '{}')[key]; }
  catch { return undefined; }
}

const ALL_SYNC_TYPES: SyncType[] = ['skill', 'mcp', 'command', 'agent', 'instructions'];

/** True for rows that must never act as a sync source (system/bundled/shared). */
function isReadonlyRow(row: any): boolean {
  return readField(row, 'readonly') === true || readField(row, 'shared') === true;
}

router.post('/sync-all', requireLocalMode, express.json(), async (req, res) => {
  const requested: SyncType[] = Array.isArray(req.body?.types) && req.body.types.length > 0
    ? req.body.types.filter((t: string): t is SyncType => (ALL_SYNC_TYPES as string[]).includes(t))
    : ALL_SYNC_TYPES;
  const dryRun = !!req.body?.dryRun;

  const store = await createStore();
  try {
    const plan: SyncPlanEntry[] = [];

    for (const type of requested) {
      // Index every (name, tool) → row for this type. Read-only rows
      // (Codex .system, plugin-bundled, shared ~/.agents) never act as a
      // source, so they're skipped entirely. Paged, 20k cap (warns on truncate).
      const rows = await listItemsPaged(store, type as SourceType, { cap: 20_000, context: 'toolkit-sync-plan' });
      const byName = new Map<string, Partial<Record<TargetTool, any>>>();
      for (const row of rows) {
        if (isReadonlyRow(row)) continue;
        const tool = String(readField(row, 'tool') || 'claude') as TargetTool;
        const name = String(readField(row, NAME_FIELD[type]) || row.title);
        if (!name) continue;
        const slot = byName.get(name) || {};
        slot[tool] = row;
        byName.set(name, slot);
      }

      for (const [name, slot] of byName.entries()) {
        const presentIn = (Object.keys(slot) as TargetTool[]).filter(t => SUPPORTED_TARGETS[type].includes(t));
        if (presentIn.length === 0) continue;
        // Pick best source by precedence.
        const source = SOURCE_PRECEDENCE[type].find(t => presentIn.includes(t));
        if (!source) continue;
        const copyTo = SUPPORTED_TARGETS[type].filter(t => !presentIn.includes(t));
        if (copyTo.length === 0) continue;
        plan.push({ type, name, source, presentIn, copyTo });
      }
    }

    if (dryRun) {
      return res.json({ dryRun: true, plan, totalToCopy: plan.reduce((n, p) => n + p.copyTo.length, 0) });
    }

    const results: SyncResultEntry[] = [];
    const rowsByType = new Map<string, Awaited<ReturnType<typeof listItemsPaged>>>();
    for (const entry of plan) {
      // Same paged bounded scan as the planning pass above (20k cap + warn).
      if (!rowsByType.has(entry.type)) rowsByType.set(entry.type, await listItemsPaged(store, entry.type as SourceType, { cap: 20_000, context: 'toolkit-sync-exec' }));
      const sourceRow = rowsByType.get(entry.type)!
        .find(r => {
          if (isReadonlyRow(r)) return false;
          const tool = String(readField(r, 'tool') || 'claude');
          const name = String(readField(r, NAME_FIELD[entry.type]) || r.title);
          return tool === entry.source && name === entry.name;
        });
      if (!sourceRow) {
        results.push({ ...entry, copied: [], skipped: [],
          errors: entry.copyTo.map(t => ({ tool: t, error: 'source row vanished from store' })) });
        continue;
      }
      const extra = (() => { try { return JSON.parse(sourceRow.extra_json || '{}'); } catch { return {}; } })();

      const copied: SyncResultEntry['copied'] = [];
      const skipped: SyncResultEntry['skipped'] = [];
      const errors: SyncResultEntry['errors'] = [];

      for (const target of entry.copyTo) {
        const r = copyArtifactToTool(entry.type, rowFromStore(entry.type, sourceRow), target);
        if (r.ok) {
          copied.push({ tool: target, targetPath: r.targetPath });
        } else if (r.status === 409) {
          skipped.push({ tool: target, reason: r.error || 'already exists' });
        } else {
          errors.push({ tool: target, error: r.error || 'failed' });
        }
      }
      results.push({ ...entry, copied, skipped, errors });
    }

    const summary = {
      itemsConsidered: plan.length,
      itemsCopied: results.reduce((n, r) => n + r.copied.length, 0),
      itemsSkipped: results.reduce((n, r) => n + r.skipped.length, 0),
      itemsFailed: results.reduce((n, r) => n + r.errors.length, 0),
    };
    return res.json({ dryRun: false, summary, results });
  } catch (error) {
    log.error({ err: error }, 'sync-all error');
    return res.status(500).json({ error: error instanceof Error ? error.message : 'failed' });
  } finally {
    await store.close();
  }
});

export default router;
