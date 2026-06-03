/**
 * Plugins / Extensions memory source.
 *
 * Two AI tools have an "external add-on" surface with the same shape but
 * different names:
 *   - Claude  — ~/.claude/plugins/installed_plugins.json (manifest of installed plugins)
 *   - Gemini  — ~/.gemini/extensions/<name>/gemini-extension.json
 *
 * OpenCode has no first-class plugin surface today.
 *
 * Both kinds are surfaced as `source_type='plugin'` with extra.tool to
 * disambiguate. The Toolkit UI shows them in one tab so "I want this in
 * Claude too" is a one-click action.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
  SourceType,
} from '../types/memory.js';
import { geminiBackend as GEMINI } from '../core/backends/gemini.js';
import { codexBackend as CODEX } from '../core/backends/codex.js';
import { claudeBackend as CLAUDE } from '../core/backends/claude.js';
import { isSourceEnabled } from '../core/settings.js';

interface ClaudeInstalledPlugin {
  scope?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  gitCommitSha?: string;
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return null; }
}

export class PluginsSource implements MemorySource {
  readonly sourceType = 'plugin' as SourceType;

  async *discover(): AsyncGenerator<MemoryItem> {
    const home = homedir();

    // ── Claude — installed_plugins.json manifest ─────────────────────
    const claudePluginsManifest = CLAUDE.pluginsManifestPath();
    const claudeJson = isSourceEnabled('claude', 'plugins') ? readJson(claudePluginsManifest) : null;
    if (claudeJson?.plugins && typeof claudeJson.plugins === 'object') {
      let mtime = 0;
      try { mtime = statSync(claudePluginsManifest).mtimeMs; } catch { /* ignore */ }
      for (const [pluginRef, installs] of Object.entries(claudeJson.plugins)) {
        const arr = Array.isArray(installs) ? installs as ClaudeInstalledPlugin[] : [];
        const head = arr[0] || {};
        // pluginRef looks like "name@marketplace"
        const [name, marketplace] = pluginRef.split('@');
        yield {
          id: `claude_plugin_${name || pluginRef}`,
          sourceType: 'plugin',
          title: name || pluginRef,
          projectPath: '',
          filePath: claudePluginsManifest,
          mtime,
          contentPreview: `Claude plugin from ${marketplace || 'unknown'} · v${head.version || 'unknown'}`,
          extra: {
            tool: 'claude',
            pluginName: name || pluginRef,
            marketplace: marketplace || '',
            version: head.version || '',
            scope: head.scope || 'user',
            installPath: head.installPath || '',
            installedAt: head.installedAt || '',
            lastUpdated: head.lastUpdated || '',
            gitCommitSha: head.gitCommitSha || '',
          },
        };
      }
    }

    // ── Gemini — ~/.gemini/extensions/<name>/gemini-extension.json ───
    const gemRoot = GEMINI.extensionsDir();
    if (isSourceEnabled('gemini', 'extensions') && existsSync(gemRoot)) {
      let entries: string[];
      try { entries = readdirSync(gemRoot); } catch { entries = []; }
      for (const name of entries) {
        const dir = join(gemRoot, name);
        let st;
        try { st = statSync(dir); } catch { continue; }
        if (!st.isDirectory()) continue;

        const manifestPath = join(dir, 'gemini-extension.json');
        const manifest = readJson(manifestPath);
        if (!manifest || typeof manifest !== 'object') continue;

        let mtime = st.mtimeMs;
        try { mtime = statSync(manifestPath).mtimeMs; } catch { /* keep dir mtime */ }

        const mcpServers = manifest.mcpServers ? Object.keys(manifest.mcpServers) : [];
        yield {
          id: `${GEMINI.idPrefix}plugin_${manifest.name || name}`,
          sourceType: 'plugin',
          title: manifest.name || name,
          projectPath: '',
          filePath: manifestPath,
          mtime,
          contentPreview: (manifest.description || '').slice(0, 300),
          extra: {
            tool: 'gemini',
            pluginName: manifest.name || name,
            description: manifest.description || '',
            version: manifest.version || '',
            contextFileName: manifest.contextFileName || '',
            mcpServers,
            extensionDir: dir,
          },
        };
      }
    }

    // ── Codex plugin packs — ~/.codex/.tmp/plugins/plugins/<name>/ ───
    // Each pack carries a .codex-plugin/plugin.json manifest. Skills and
    // MCPs bundled inside a pack are picked up by SkillsSource / McpsSource
    // separately; here we surface the pack itself so the Toolkit Plugins
    // tab shows what's installed.
    const codexPluginsRoot = CODEX.pluginsDir();
    if (isSourceEnabled('codex', 'plugins') && existsSync(codexPluginsRoot)) {
      let entries: string[];
      try { entries = readdirSync(codexPluginsRoot); } catch { entries = []; }
      for (const name of entries) {
        const pluginDir = join(codexPluginsRoot, name);
        let st;
        try { st = statSync(pluginDir); } catch { continue; }
        if (!st.isDirectory()) continue;

        const appJson = readJson(join(pluginDir, '.codex-plugin', '.app.json'));
        const pluginJson = readJson(join(pluginDir, '.codex-plugin', 'plugin.json'));
        const manifest = pluginJson || appJson || {};

        // List bundled MCPs (look for .mcp.json files inside the pack).
        let mcpServers: string[] = [];
        const mcpJson = readJson(join(pluginDir, '.mcp.json'));
        if (mcpJson?.mcpServers) mcpServers = Object.keys(mcpJson.mcpServers);

        yield {
          id: `${CODEX.idPrefix}plugin_${manifest.name || name}`,
          sourceType: 'plugin',
          title: manifest.name || name,
          projectPath: '',
          filePath: join(pluginDir, '.codex-plugin'),
          mtime: st.mtimeMs,
          contentPreview: (manifest.description || '').slice(0, 300),
          extra: {
            tool: 'codex',
            pluginName: manifest.name || name,
            description: manifest.description || '',
            version: manifest.version || '',
            mcpServers,
            extensionDir: pluginDir,
          },
        };
      }
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    const extra = (item.extra || {}) as Record<string, unknown>;
    const lines: string[] = [`Plugin: ${item.title}`, `Tool: ${extra.tool || 'unknown'}`];
    if (extra.version) lines.push(`Version: ${extra.version}`);
    if (extra.description) lines.push(`Description: ${extra.description}`);
    if (extra.marketplace) lines.push(`Marketplace: ${extra.marketplace}`);
    if (Array.isArray(extra.mcpServers) && (extra.mcpServers as string[]).length) {
      lines.push(`Bundled MCPs: ${(extra.mcpServers as string[]).join(', ')}`);
    }

    return [{
      chunkId: `${item.id}_plugin`,
      itemId: item.id,
      sourceType: 'plugin',
      title: item.title,
      text: lines.join('\n'),
      chunkType: 'plugin',
      projectPath: item.projectPath,
      filePath: item.filePath,
      mtime: item.mtime,
    }];
  }

  async extractLinks(_item: MemoryItem): Promise<MemoryLink[]> {
    return [];
  }
}
