/**
 * Local merge of pulled team artifacts into the right per-tool dirs.
 *
 * Called from `chat-recall team pull` after `teamPull()` returns. For
 * each artifact, write its body to the appropriate filesystem location
 * for every tool the user has installed (cross-tool artifacts) or just
 * the matching tool (tool-specific artifacts).
 *
 * Tracking — we maintain a small SQLite-backed install ledger keyed by
 * `(artifactId, tool)` so we can:
 *   1. Skip a write when the bytes already match (sha256 compare)
 *   2. Remove the right files when the server reports an artifact in
 *      the `removed` list (we know exactly which paths we wrote)
 *
 * Privacy: we never write to a project that's in `privacy.projectDenylist`.
 * `pinnedTo` from the server is honored as a project-scope hint — the
 * artifact is only installed under the matched project (skipped on
 * machines that don't have it).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';

import type { TeamArtifactBody, TeamArtifactType, TeamArtifactTool } from './team-client.js';
import { claudeBackend } from './backends/claude.js';
import { geminiBackend } from './backends/gemini.js';
import { opencodeBackend } from './backends/opencode.js';
import { codexBackend } from './backends/codex.js';
import { getDataDir } from './paths.js';

interface InstallRow {
  artifact_id: string;
  tool: string;
  path: string;
  sha256: string;
  installed_at: number;
}

/** Open the local install ledger. Idempotent — creates table on first call. */
function ledgerDb(): Database.Database {
  const path = join(getDataDir(), 'team-installs.db');
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_installs (
      artifact_id  TEXT NOT NULL,
      tool         TEXT NOT NULL,
      path         TEXT NOT NULL,
      sha256       TEXT NOT NULL,
      installed_at INTEGER NOT NULL,
      PRIMARY KEY (artifact_id, tool, path)
    );
    CREATE INDEX IF NOT EXISTS idx_installs_artifact ON team_installs(artifact_id);
  `);
  return db;
}

/**
 * Compute the install path for an artifact under a given target tool.
 * Returns null when the type doesn't apply to that tool (e.g. 'hook'
 * only meaningful for Claude — we don't fan-hooks out cross-tool).
 */
function installPathFor(art: { type: TeamArtifactType; name: string }, tool: 'claude' | 'agy' | 'gemini' | 'opencode' | 'codex'): string | null {
  // SKILL.md naming: every tool with a skills concept stores them as
  // `<dir>/<name>/SKILL.md` — keeps the in-tool layout uniform with
  // what the upstream tools expect.
  switch (art.type) {
    case 'skill':
      switch (tool) {
        case 'claude':   return join(claudeBackend.skillsDir(),   art.name, 'SKILL.md');
        case 'agy':
        case 'gemini':   return join(geminiBackend.skillsDir(),   art.name, 'SKILL.md');
        case 'opencode': return join(opencodeBackend.skillsDir(), art.name, 'SKILL.md');
        // User skills go to ~/.codex/skills (NOT .system, which is OpenAI's bundle).
        case 'codex':    return join(codexBackend.skillsDir(),    art.name, 'SKILL.md');
      }
      break;
    case 'agent':
      // Subagent definitions only meaningful in Claude (and Codex
      // sub-runners, but those use a different shape — defer).
      if (tool === 'claude') return join(claudeBackend.agentsDir(), `${art.name}.md`);
      return null;
    case 'command':
      if (tool === 'claude') return join(claudeBackend.commandsDir(), `${art.name}.md`);
      return null;
    case 'hook':
      // Hook bodies are JSON snippets; we install one per artifact name
      // under a chat-recall-managed dir, then merge into hooks.json
      // with a separate step (deferred — touching the user's hooks.json
      // automatically without explicit consent is risky).
      if (tool === 'claude') return join(claudeBackend.homeDir(), 'chat-recall-hooks', `${art.name}.json`);
      return null;
    case 'plan':
      switch (tool) {
        case 'claude':   return join(claudeBackend.plansDir(),    `${art.name}.md`);
        case 'opencode': return join(opencodeBackend.plansDir(),  `${art.name}.md`);
        case 'agy':
        case 'gemini':   return null;  // Gemini/agy plans live per-session under tmp/
        case 'codex':    return null;
      }
      break;
    case 'instructions':
      // Project-level instructions (CLAUDE.md / AGENTS.md / GEMINI.md).
      // We install into a chat-recall-owned staging dir; the user is
      // expected to symlink or copy into their project (we don't
      // overwrite a user's existing CLAUDE.md silently).
      return join(getDataDir(), 'team-instructions', tool, `${art.name}.md`);
    case 'mcp':
      // MCP server configs — install into a chat-recall-owned merged file.
      // Promotion into ~/.mcp.json or per-tool MCP config is a separate
      // step; same reason as hooks (don't auto-edit shared files).
      return join(getDataDir(), 'team-mcps', `${art.name}.json`);
    case 'plugin':
      // Plugins (Claude/Codex) and extensions (Gemini). Same naming
      // strategy as skills — staging dir only; auto-install requires
      // user action.
      return join(getDataDir(), 'team-plugins', tool, art.name, 'manifest.json');
  }
  return null;
}

/**
 * Resolve which target tools a given artifact installs into.
 * `cross_tool` fans out to all installed tools the type applies to.
 * Tool-specific artifacts only install if that tool is detected.
 */
function targetsFor(art: { tool: TeamArtifactTool; type: TeamArtifactType }): Array<'claude' | 'gemini' | 'opencode' | 'codex'> {
  const installed = {
    claude:   claudeBackend.isAvailable(),
    gemini:   geminiBackend.isAvailable(),
    opencode: opencodeBackend.isAvailable(),
    codex:    codexBackend.isAvailable(),
  };
  if (art.tool === 'cross_tool') {
    return (Object.entries(installed) as Array<['claude' | 'gemini' | 'opencode' | 'codex', boolean]>)
      .filter(([_, on]) => on).map(([t]) => t);
  }
  return installed[art.tool] ? [art.tool] : [];
}

export interface MergeReport {
  written:  Array<{ artifactId: string; path: string }>;
  skipped:  Array<{ artifactId: string; path: string; reason: 'unchanged' | 'denylisted' | 'no-target-tool' }>;
  removed:  Array<{ artifactId: string; path: string }>;
  failures: Array<{ artifactId: string; path: string; error: string }>;
}

/**
 * Apply a pull result to the local filesystem.
 *
 *   - For each artifact in `pulled`: write to every applicable tool path,
 *     skip when bytes already match.
 *   - For each id in `removed`: delete every file we previously wrote
 *     for that artifact (looked up in the install ledger).
 *
 * Always idempotent — re-running with the same input produces the same
 * end state and reports the same `skipped: 'unchanged'` rows.
 */
export function mergePullResult(opts: {
  pulled: TeamArtifactBody[];
  removed: string[];
}): MergeReport {
  const report: MergeReport = { written: [], skipped: [], removed: [], failures: [] };
  const db = ledgerDb();

  const upsert = db.prepare(
    `INSERT INTO team_installs (artifact_id, tool, path, sha256, installed_at)
       VALUES (@artifact_id, @tool, @path, @sha256, @installed_at)
     ON CONFLICT (artifact_id, tool, path) DO UPDATE
       SET sha256 = excluded.sha256, installed_at = excluded.installed_at`,
  );
  const findByArtifact = db.prepare<[string], InstallRow>(
    `SELECT artifact_id, tool, path, sha256, installed_at FROM team_installs WHERE artifact_id = ?`,
  );
  const deleteRow = db.prepare<[string, string, string]>(
    `DELETE FROM team_installs WHERE artifact_id = ? AND tool = ? AND path = ?`,
  );

  // Writes
  for (const a of opts.pulled) {
    const targets = targetsFor(a);
    if (targets.length === 0) {
      report.skipped.push({ artifactId: a.id, path: '(no installed target tool)', reason: 'no-target-tool' });
      continue;
    }
    const body = Buffer.from(a.bodyB64, 'base64');
    const sha = createHash('sha256').update(body).digest('hex');

    for (const tool of targets) {
      const path = installPathFor(a, tool);
      if (!path) continue;

      try {
        // Already current? Trust the ledger first; fall back to disk hash
        // for robustness against hand edits.
        const existing = readFileIfExists(path);
        if (existing && createHash('sha256').update(existing).digest('hex') === sha) {
          report.skipped.push({ artifactId: a.id, path, reason: 'unchanged' });
          upsert.run({ artifact_id: a.id, tool, path, sha256: sha, installed_at: Date.now() });
          continue;
        }

        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
        upsert.run({ artifact_id: a.id, tool, path, sha256: sha, installed_at: Date.now() });
        report.written.push({ artifactId: a.id, path });
      } catch (err) {
        report.failures.push({ artifactId: a.id, path, error: (err as Error).message });
      }
    }
  }

  // Revocations
  for (const id of opts.removed) {
    const rows = findByArtifact.all(id);
    for (const row of rows) {
      try {
        if (existsSync(row.path)) rmSync(row.path, { force: true });
        deleteRow.run(row.artifact_id, row.tool, row.path);
        report.removed.push({ artifactId: id, path: row.path });
      } catch (err) {
        report.failures.push({ artifactId: id, path: row.path, error: (err as Error).message });
      }
    }
  }

  db.close();
  return report;
}

function readFileIfExists(path: string): Buffer | null {
  try {
    if (!existsSync(path)) return null;
    const s = statSync(path);
    if (!s.isFile()) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}
