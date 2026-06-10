#!/usr/bin/env node
/**
 * CLI for chat-recall.
 */

import { config } from 'dotenv';
import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
import { execSync } from 'child_process';

import { getEmbedder, type EmbedderProvider } from '@chat-recall/engine/core/embedder.js';
import { createVectorStore } from '@chat-recall/engine/core/store/vector.js';
import { MemoryIndex } from '@chat-recall/engine/core/memory-index.js'; // static helpers (getDefaultIndexPath) only
import { createMetadataCache } from '@chat-recall/engine/core/store/caches.js';
import { getDataDir, getIdentityFilePath, getHooksDir, getIndexDir } from '@chat-recall/engine/core/paths.js';
import { createStore } from '@chat-recall/engine/core/store/index.js';
import { SourceRegistry } from '@chat-recall/engine/core/source-registry.js';
import { SessionSource } from '@chat-recall/engine/parsers/session-source.js';
import { PlanSource } from '@chat-recall/engine/parsers/plan-source.js';
import { TaskSource } from '@chat-recall/engine/parsers/task-source.js';
import { ClaudeMdSource } from '@chat-recall/engine/parsers/claude-md-source.js';
import { HistorySource } from '@chat-recall/engine/parsers/history-source.js';
import { PasteSource } from '@chat-recall/engine/parsers/paste-source.js';
import { GeminiSessionSource } from '@chat-recall/engine/parsers/gemini-source.js';
import { GeminiBrainSource } from '@chat-recall/engine/parsers/gemini-brain-source.js';
import { OpenCodeSource } from '@chat-recall/engine/parsers/opencode-source.js';
import { OpenCodeTodoSource } from '@chat-recall/engine/parsers/opencode-todo-source.js';
import { CodexSessionSource } from '@chat-recall/engine/parsers/codex-session-source.js';
import { DiarySource } from '@chat-recall/engine/parsers/diary-source.js';
import { SkillsSource } from '@chat-recall/engine/parsers/skills-source.js';
import { McpsSource } from '@chat-recall/engine/parsers/mcps-source.js';
import { SlashCommandsSource } from '@chat-recall/engine/parsers/slash-commands-source.js';
import { SubagentsSource } from '@chat-recall/engine/parsers/subagents-source.js';
import { HooksSource } from '@chat-recall/engine/parsers/hooks-source.js';
import { PluginsSource } from '@chat-recall/engine/parsers/plugins-source.js';
import { claudeBackend } from '@chat-recall/engine/core/backends/claude.js';
import { getBackendForId } from '@chat-recall/engine/core/tool-backend.js';
import '@chat-recall/engine/core/backends/index.js'; // side-effect: registers backends
import { classifyChunk } from '@chat-recall/engine/core/memory-classifier.js';
import { extractAndPopulateKG } from '@chat-recall/engine/core/entity-extractor.js';
import { createKnowledgeGraph } from '@chat-recall/engine/core/store/knowledge-graph.js';
import { buildProjectDossier } from '@chat-recall/engine/core/project-dossier.js';
import { resolveProjectId } from '@chat-recall/engine/core/project-resolver.js';
import type { SourceType } from '@chat-recall/engine/types/memory.js';

// Load .env configuration
config();

const program = new Command();

program
  .name('chat-recall')
  .description('Semantic search for Claude Code sessions - recall and resume past conversations')
  .version('0.1.0');

program
  .command('init')
  .description('Set up chat-recall: index all sources, detect AI tools, configure MCP server, install codeindex companion')
  .option('--vector', 'Enable vector search (requires Ollama or Gemini API key)')
  .option('--provider <provider>', 'Embedding provider for vector search (ollama or gemini)')
  .option('--skip-mcp', 'Skip MCP server configuration')
  .option('--with-codeindex', 'Force-download the codeindex binary during init. Default behavior is to detect an already-installed codeindex on PATH and register it as an MCP server.')
  .option('--skip-codeindex', 'Skip the codeindex companion entirely (no detection, no registration).')
  .action(async (options) => {
    try {
      console.log(chalk.bold('chat-recall init'));
      console.log();

      // Step 1: Detect available AI CLIs for summaries
      console.log(chalk.bold('1. Detecting AI tools...'));
      const clis: { name: string; cmd: string; available: boolean }[] = [
        { name: 'Gemini CLI', cmd: 'gemini', available: false },
        { name: 'Claude CLI', cmd: 'claude', available: false },
        { name: 'OpenCode', cmd: 'opencode', available: false },
        { name: 'Ollama', cmd: 'ollama', available: false },
      ];

      for (const cli of clis) {
        try {
          execSync(`which ${cli.cmd}`, { stdio: 'pipe' });
          cli.available = true;
        } catch { /* not found */ }
      }

      for (const cli of clis) {
        const icon = cli.available ? chalk.green('found') : chalk.dim('not found');
        console.log(`   ${cli.name}: ${icon}`);
      }

      const summaryCli = clis.find(c => c.available);
      if (summaryCli) {
        console.log(`   Summary generation: ${chalk.green(summaryCli.name)}`);
      } else {
        console.log(`   Summary generation: ${chalk.yellow('none (first prompt will be used as summary)')}`);
      }
      console.log();

      // Step 2: Detect embedder for vector search
      let embedder: Awaited<ReturnType<typeof getEmbedder>> | null = null;
      if (options.vector) {
        console.log(chalk.bold('2. Setting up vector search...'));
        const provider = (options.provider || process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider;
        try {
          embedder = getEmbedder(provider);
          // Test that it actually works
          await embedder.embedQuery('test');
          console.log(`   Vector search: ${chalk.green('enabled')} (${provider})`);
        } catch (err) {
          console.log(`   Vector search: ${chalk.yellow('failed')} — ${err}`);
          console.log(`   Continuing with text search only.`);
          embedder = null;
        }
      } else {
        console.log(chalk.bold('2. Search mode: FTS5 (full-text search)'));
        console.log(`   ${chalk.dim('Use --vector to enable semantic vector search')}`);
      }
      console.log();

      // Step 3: Index all sources
      console.log(chalk.bold('3. Indexing all sources...'));
      const memoryIndex = await createVectorStore(embedder);
      const store = await createStore();
      const registry = new SourceRegistry();
      registry.register(new SessionSource());
      registry.register(new PlanSource());
      registry.register(new TaskSource());
      registry.register(new ClaudeMdSource());
      registry.register(new HistorySource());
      registry.register(new PasteSource());
      registry.register(new GeminiSessionSource());
      registry.register(new GeminiBrainSource());
      registry.register(new OpenCodeSource());
      registry.register(new OpenCodeTodoSource());
      registry.register(new CodexSessionSource());
      registry.register(new DiarySource());
      registry.register(new SkillsSource());
      registry.register(new McpsSource());
      registry.register(new SlashCommandsSource());
      registry.register(new SubagentsSource());
      registry.register(new HooksSource());
      registry.register(new PluginsSource());

      const kg = await createKnowledgeGraph();
      let totalItems = 0, totalChunks = 0, totalErrors = 0;
      const typeCounts: Record<string, number> = {};

      for (const sourceType of registry.getRegisteredTypes()) {
        const sources = registry.getAll(sourceType);
        if (sources.length === 0) continue;
        let typeItems = 0;
        for (const source of sources) {
          for await (const item of source.discover()) {
            try {
              if (!(await memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime))) continue;
              await memoryIndex.deleteItem(item.sourceType, item.id);
              const chunks = await source.parse(item);
              for (const chunk of chunks) {
                const cls = classifyChunk(chunk.text);
                if (cls.memoryType !== 'general') {
                  chunk.chunkType = `${chunk.chunkType}:${cls.memoryType}:imp${cls.importance}`;
                }
                await extractAndPopulateKG(kg, chunk.text, {
                  projectPath: item.projectPath, sourceType: item.sourceType, sessionId: item.id,
                });
              }
              if (chunks.length > 0) {
                await memoryIndex.bufferChunks(chunks);
                totalChunks += chunks.length;
              }
              await store.setItem(item);
              const links = await source.extractLinks(item);
              if (links.length > 0) await store.addLinks(links);
              totalItems++;
              typeItems++;
            } catch { totalErrors++; }
          }
        }
        await memoryIndex.flushBuffer();
        if (typeItems > 0) typeCounts[sourceType] = typeItems;
      }
      await kg.close();
      await store.close();

      for (const [type, count] of Object.entries(typeCounts)) {
        console.log(`   ${type}: ${count} items`);
      }
      console.log(`   Total: ${totalItems} items, ${totalChunks} chunks`);
      if (totalErrors > 0) console.log(`   ${chalk.yellow(`Errors: ${totalErrors}`)}`);
      console.log();

      // Step 4: Configure MCP server
      if (!options.skipMcp) {
        console.log(chalk.bold('4. Configuring MCP server...'));
        const mcpJsonPath = join(homedir(), '.mcp.json');
        let mcpConfig: Record<string, unknown> = {};

        if (existsSync(mcpJsonPath)) {
          try {
            mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
          } catch {
            mcpConfig = {};
          }
        }

        const mcpServers = (mcpConfig.mcpServers || {}) as Record<string, unknown>;
        const projectRoot = join(import.meta.dirname, '..');

        if (mcpServers['chat-recall']) {
          console.log(`   MCP server: ${chalk.green('already configured')} in ${mcpJsonPath}`);
        } else {
          // Prefer the installed `chat-recall-mcp` bin (on PATH after `npm i -g`
          // or a packaged binary) so the config is portable. Only fall back to
          // the source-checkout path when running from an un-installed dev tree.
          let mcpBinOnPath = false;
          try { execSync('command -v chat-recall-mcp', { stdio: 'ignore' }); mcpBinOnPath = true; } catch { /* not installed */ }
          const launch = mcpBinOnPath
            ? { command: 'chat-recall-mcp' as const }
            : { command: 'node' as const, args: [join(projectRoot, 'dist', 'mcp.js')] };
          mcpServers['chat-recall'] = {
            ...launch,
            alwaysAllow: [
              'recall_search', 'recall_show', 'recall_index', 'recall_status',
              'recall_recent', 'recall_context', 'recall_summary', 'recall_suggest_resume',
              'recall_memory_search', 'recall_memory_status', 'recall_plans', 'recall_plan_show',
              'recall_tasks', 'recall_smart_resume', 'recall_project_context',
              'recall_project_dossier', 'recall_weekly_digest',
              'recall_kg_query', 'recall_kg_add', 'recall_kg_invalidate',
              'recall_kg_timeline', 'recall_kg_stats',
              'recall_diary_write', 'recall_diary_read',
              'recall_diff', 'recall_commits', 'recall_outcome', 'recall_markers',
              'recall_edits_timeline', 'recall_subagent_search', 'recall_files_touched',
              'recall_user_prompts', 'recall_decision_record', 'recall_analytics_summary',
              'recall_wake_up', 'recall_similar_sessions', 'recall_session_files',
              'recall_redundant_files', 'recall_set', 'recall_get', 'recall_kv_list',
              'recall_help',
            ],
          };
          mcpConfig.mcpServers = mcpServers;
          writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2));
          console.log(`   MCP server: ${chalk.green('configured')} in ${mcpJsonPath}`);
        }
      } else {
        console.log(chalk.bold('4. Skipping MCP configuration (--skip-mcp)'));
      }
      console.log();

      // Step 5: Codeindex companion. Three modes:
      //   1. --skip-codeindex      → do nothing
      //   2. (default)             → detect an already-installed codeindex on
      //                              PATH and register it as an MCP server
      //   3. --with-codeindex      → force-download the binary, then register
      //
      // Detect-and-register is the right default once the user has codeindex
      // installed somewhere (system PATH, ~/.local/bin/codeindex, etc.) — no
      // network call, no surprise. Force-download is for fresh setups.
      const skipCodeindex = options.skipCodeindex === true;
      const forceInstall = options.withCodeindex === true || process.env.CHAT_RECALL_WITH_CODEINDEX === '1';

      if (skipCodeindex) {
        console.log(chalk.bold('5. Skipping codeindex companion (--skip-codeindex)'));
      } else {
        const {
          checkCodeindexStatus,
          installCodeindex,
          registerCodeindexMcp,
          CODEINDEX_BIN_PATH,
        } = await import('@chat-recall/engine/core/companions.js');

        const detected = checkCodeindexStatus();

        if (detected.installed && !forceInstall) {
          console.log(chalk.bold('5. Detected codeindex companion'));
          console.log(`   ${chalk.green('codeindex')}: ${detected.path}`);
          if (!options.skipMcp) {
            const mcpJsonPath = join(homedir(), '.mcp.json');
            const reg = registerCodeindexMcp(mcpJsonPath, detected.path!);
            if (reg.added) console.log(`   ${chalk.green('codeindex MCP server registered')} in ${mcpJsonPath}`);
            else console.log(`   codeindex MCP server: ${chalk.green('already registered')}`);
          }
        } else if (forceInstall) {
          console.log(chalk.bold('5. Installing codeindex companion (--with-codeindex)...'));
          try {
            const result = await installCodeindex({ force: true });
            if (result.installed) {
              const sizeMb = result.size ? `${(result.size / 1024 / 1024).toFixed(1)} MB` : '?';
              console.log(`   ${chalk.green('codeindex installed')} (${sizeMb}) → ${result.path}`);
              if (!options.skipMcp) {
                const mcpJsonPath = join(homedir(), '.mcp.json');
                const reg = registerCodeindexMcp(mcpJsonPath, CODEINDEX_BIN_PATH);
                if (reg.added) console.log(`   ${chalk.green('codeindex MCP server registered')} in ${mcpJsonPath}`);
              }
            } else if (!result.prebuiltAvailable) {
              console.log(`   ${chalk.yellow('codeindex')}: ${result.unsupportedReason}`);
            }
          } catch (err) {
            const msg = String(err);
            console.log(`   ${chalk.yellow('codeindex install failed')}: ${msg}`);
            if (msg.includes('404')) {
              console.log(chalk.dim('   The codeindex release returned 404. If the repo is private,'));
              console.log(chalk.dim('   authenticate `gh` to it, or build from source.'));
            }
          }
        } else {
          console.log(chalk.bold('5. codeindex companion: not installed'));
          console.log(chalk.dim('   codeindex is a separate MCP server for code-level lookup —'));
          console.log(chalk.dim('   find_symbol, plan_change, get_change_impact, etc.'));
          console.log(chalk.dim('   To install: `chat-recall init --with-codeindex`'));
          console.log(chalk.dim('   Or grab the binary from https://github.com/munhq/codeindex'));
        }
      }
      console.log();

      // Done
      console.log(chalk.green.bold('Setup complete!'));
      console.log();
      console.log('chat-recall MCP tools (42): recall_search, recall_recent, recall_context,');
      console.log('  recall_summary, recall_show, recall_suggest_resume, recall_smart_resume,');
      console.log('  recall_project_context, recall_project_dossier, recall_weekly_digest,');
      console.log('  recall_status, recall_index, recall_memory_search, recall_memory_status,');
      console.log('  recall_plans, recall_plan_show, recall_tasks, recall_diff, recall_commits,');
      console.log('  recall_outcome, recall_markers, recall_edits_timeline, recall_help,');
      console.log('  recall_kg_query/add/invalidate/timeline/stats,');
      console.log('  recall_diary_write/read, recall_subagent_search, recall_files_touched,');
      console.log('  recall_user_prompts, recall_decision_record, recall_set/get/kv_list,');
      console.log('  recall_analytics_summary, recall_wake_up, recall_similar_sessions,');
      console.log('  recall_session_files, recall_redundant_files');
      // List codeindex's tools too if it's available — detected above.
      if (!skipCodeindex) {
        const { checkCodeindexStatus } = await import('@chat-recall/engine/core/companions.js');
        if (checkCodeindexStatus().installed) {
          console.log();
          console.log('codeindex MCP tools (16): status, search, find_symbol, find_word, get_outline,');
          console.log('  get_tree, get_imports, get_imported_by, find_callers, plan_change,');
          console.log('  get_hot_files, index_workspace, analyze, read_file, read_symbol,');
          console.log('  get_change_impact');
        }
      }
      console.log();
      if (!options.vector) {
        console.log(`${chalk.dim('Tip: Run with --vector to enable semantic search (needs Ollama or Gemini API key)')}`);
      }
    } catch (err) {
      console.error(chalk.red('Error:'), err);
      process.exit(1);
    }
  });

program
  .command('index')
  .description('Index all Claude Code sessions for semantic search')
  .option('-f, --force', 'Force re-index all sessions', false)
  .option('-p, --provider <provider>', 'Embedding provider (ollama or gemini) - overrides EMBEDDING_PROVIDER env var')
  .action(async (options) => {
    try {
      // Use CLI flag if provided, otherwise read from .env, default to ollama (local)
      const provider = (options.provider || process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider;
      console.log(`Using embedding provider: ${chalk.bold(provider)}`);

      const embedder = getEmbedder(provider);
      // Use unified memory indexing for all source types
      const memoryIndex = await createVectorStore(embedder);
      const store = await createStore();
      const registry = new SourceRegistry();
      registry.register(new SessionSource());
      registry.register(new PlanSource());
      registry.register(new TaskSource());
      registry.register(new ClaudeMdSource());
      registry.register(new HistorySource());
      registry.register(new PasteSource());
      registry.register(new GeminiSessionSource());
      registry.register(new GeminiBrainSource());
      registry.register(new OpenCodeSource());
      registry.register(new OpenCodeTodoSource());
      registry.register(new CodexSessionSource());
      registry.register(new DiarySource());
      registry.register(new SkillsSource());
      registry.register(new McpsSource());
      registry.register(new SlashCommandsSource());
      registry.register(new SubagentsSource());
      registry.register(new HooksSource());
      registry.register(new PluginsSource());

      const kg = await createKnowledgeGraph();
      let totalItems = 0, totalSkipped = 0, totalChunks = 0, totalErrors = 0, totalKGTriples = 0;
      for (const sourceType of registry.getRegisteredTypes()) {
        const sources = registry.getAll(sourceType);
        if (sources.length === 0) continue;
        console.log(`Indexing ${sourceType}...`);
        for (const source of sources) {
        for await (const item of source.discover()) {
          try {
            if (!options.force && !(await memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime))) {
              totalSkipped++;
              continue;
            }
            await memoryIndex.deleteItem(item.sourceType, item.id);
            const chunks = await source.parse(item);
            for (const chunk of chunks) {
              const cls = classifyChunk(chunk.text);
              if (cls.memoryType !== 'general') {
                chunk.chunkType = `${chunk.chunkType}:${cls.memoryType}:imp${cls.importance}`;
              }
              totalKGTriples += await extractAndPopulateKG(kg, chunk.text, {
                projectPath: item.projectPath, sourceType: item.sourceType, sessionId: item.id,
              });
            }
            if (chunks.length > 0) {
              await memoryIndex.bufferChunks(chunks);
              totalChunks += chunks.length;
            }
            await store.setItem(item);
            const links = await source.extractLinks(item);
            if (links.length > 0) await store.addLinks(links);
            totalItems++;
          } catch { totalErrors++; }
        }
        }
        await memoryIndex.flushBuffer();
      }
      await kg.close();
      // optimize() removed from auto flows to prevent data corruption
      await store.close();

      console.log();
      console.log(chalk.green('Indexing complete!'));
      console.log(`  Items processed: ${totalItems}`);
      console.log(`  Items skipped (unchanged): ${totalSkipped}`);
      console.log(`  Total chunks indexed: ${totalChunks}`);
      console.log(`  KG triples extracted: ${totalKGTriples}`);

      if (totalErrors > 0) {
        console.log(chalk.yellow(`  Errors: ${totalErrors}`));
      }
    } catch (err) {
      console.error(chalk.red('Error:'), err);
      process.exit(1);
    }
  });

program
  .command('search <query>')
  .description('Search for relevant sessions by semantic similarity')
  .option('-n, --top <number>', 'Number of results to show', '5')
  .option('-p, --project <path>', 'Filter by project path (substring match)')
  .option('--provider <provider>', 'Embedding provider (ollama or gemini) - overrides EMBEDDING_PROVIDER env var')
  .option('--no-rank', 'Skip Claude ranking (faster, but less accurate)')
  .action(async (query, options) => {
    try {
      // Use CLI flag if provided, otherwise read from .env, default to ollama (local)
      const provider = (options.provider || process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider;
      let embedder: Awaited<ReturnType<typeof getEmbedder>> | null;
      try {
        embedder = getEmbedder(provider);
      } catch {
        embedder = null;
      }
      const topK = parseInt(options.top, 10);

      const memoryIndex = await createVectorStore(embedder);
      const memResults = await memoryIndex.search(query, {
        topK: options.noRank ? topK : topK * 4,
        sourceTypes: ['session'],
        projectIdFilter: options.project,
      });
      // Transform to legacy format
      const cache = await createMetadataCache();
      const cachedList = await Promise.all(memResults.map(r => cache.get(r.itemId)));
      const results = memResults.map((r, i) => {
        const cached = cachedList[i];
        return {
          sessionId: r.itemId, score: r.score,
          chunkType: r.matchedChunks[0]?.chunkType || 'unknown',
          text: r.matchedChunks[0]?.text || r.title,
          projectPath: r.projectPath,
          created: '', modified: '',
          firstPrompt: cached?.firstPrompt || r.title,
          summary: cached?.summary,
          matchedChunks: r.matchedChunks,
        };
      });
      await cache.close();
      
      if (results.length === 0) {
        console.log(chalk.yellow('No matching sessions found.'));
        process.exit(0);
      }
      
      // Truncate if needed
      const displayResults = results.slice(0, topK);

      console.log();
      console.log(`${chalk.bold('Results for:')} "${query}"`);
      console.log();

      for (let i = 0; i < displayResults.length; i++) {
        const result = displayResults[i];

        // Truncate project path
        let projectPath = result.projectPath;
        if (projectPath.length > 50) {
          projectPath = '...' + projectPath.slice(-47);
        }

        // Title from first prompt
        let title = result.firstPrompt.replace(/\n/g, ' ').trim();
        if (title.length > 80) {
          title = title.slice(0, 80) + '...';
        }

        const scorePct = Math.round(result.score * 100);

        console.log(`${chalk.bold.cyan(`#${i + 1}`)} ${title}`);
        console.log(`   ${chalk.dim('Project:')} ${projectPath}`);
        console.log(`   ${chalk.dim('Created:')} ${result.created.slice(0, 10)}  ${chalk.dim('Score:')} ${scorePct}/100`);

        // Show summary if available
        if (result.summary) {
          let summary = result.summary.replace(/\n/g, ' ').trim();
          if (summary.length > 200) {
            summary = summary.slice(0, 200) + '...';
          }
          console.log(`   ${chalk.yellow('Summary:')} ${summary}`);
        }

        // Show key context from matched chunks
        if (result.matchedChunks && result.matchedChunks.length > 0) {
          for (const chunk of result.matchedChunks.slice(0, 1)) {
            if (chunk.chunkType !== 'summary' && chunk.chunkType !== 'first_prompt') {
              const label = chunk.chunkType === 'assistant' ? 'Discussed' :
                           chunk.chunkType === 'user_context' ? 'Asked about' :
                           chunk.chunkType === 'tool_result' ? 'Tool result' :
                           'Context';
              let text = chunk.text.replace(/\n/g, ' ').trim();
              if (text.length > 150) {
                text = text.slice(0, 150) + '...';
              }
              console.log(`   ${chalk.magenta(label + ':')} ${text}`);
            }
          }
        }

        console.log(`   ${chalk.green('Resume:')} claude --resume ${result.sessionId}`);
        console.log();
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Index not found')) {
        console.error(chalk.red('Error:'), err.message);
        console.log('\nRun', chalk.bold('chat-recall index'), 'first to build the index.');
      } else {
        console.error(chalk.red('Error:'), err);
      }
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show index status and statistics')
  .action(async () => {
    const indexPath = MemoryIndex.getDefaultIndexPath();

    if (!existsSync(indexPath)) {
      console.log(chalk.yellow('Index not found.'));
      console.log(`Expected at: ${indexPath}`);
      console.log('\nRun', chalk.bold('chat-recall index'), 'to build the index.');
      process.exit(0);
    }

    try {
      const dummyEmbedder = { embed: async () => [], embedQuery: async () => [], dimension: 768 };
      const memoryIndex = await createVectorStore(dummyEmbedder as any);
      const stats = await memoryIndex.getStats();
      const store = await createStore();
      const linkCount = await store.getLinkCount();
      const ftsCount = await store.getFTSCount();
      await store.close();

      console.log(chalk.bold('Chat-Recall Index Status'));
      console.log();
      console.log(`Index path: ${stats.indexPath}`);
      console.log(`Total items: ${stats.totalItems}`);
      console.log(`Vector chunks: ${stats.totalChunks}`);
      console.log(`FTS5 chunks: ${ftsCount}`);
      console.log(`Total links: ${linkCount}`);

      if (Object.keys(stats.bySourceType).length > 0) {
        console.log();
        console.log(chalk.bold('By source type:'));
        for (const [type, data] of Object.entries(stats.bySourceType)) {
          console.log(`  ${type}: ${data.items} items, ${data.chunks} chunks`);
        }
      }
    } catch (err) {
      console.error(chalk.red('Error:'), err);
      process.exit(1);
    }
  });

program
  .command('optimize')
  .description('Compact and optimize the LanceDB index to reclaim disk space')
  .action(async () => {
    try {
      const { MemoryIndex } = await import('@chat-recall/engine/core/memory-index.js');
      const embedder = {
        embed: async () => [],
        embedQuery: async () => [],
        dimension: 768,
      };
      const index = await createVectorStore(embedder as any);

      console.log(chalk.bold('Optimizing LanceDB index...'));
      console.log('This compacts data files and removes old versions/transactions.');
      console.log();

      const stats = await index.optimize({ lockKind: 'cli' });
      if (stats.skipped) {
        if (stats.skipped === 'busy') {
          console.log(chalk.yellow('Skipped: index is locked by another process.'));
          console.log(chalk.dim('  The auto-indexer or another `chat-recall optimize` is running.'));
          console.log(chalk.dim('  Try again in a minute, or stop the daemon: systemctl --user stop chat-recall-indexer'));
        } else {
          console.log(chalk.dim('Skipped: no LanceDB table found (vector index not initialized).'));
        }
        process.exit(1);
      }
      console.log(chalk.green('Done!'));
      console.log(`  Compacted fragments: ${stats.compactedFragments}`);
      console.log(`  Pruned old versions: ${stats.prunedFiles}`);
      console.log();
      console.log('Run', chalk.bold(`du -sh ${getIndexDir()}`), 'to check the new size.');
    } catch (err) {
      console.error(chalk.red('Error:'), err);
      process.exit(1);
    }
  });

program
  .command('show <session_id>')
  .description('Show conversation content from a session')
  .option('-l, --line <number>', 'Show context around this line number')
  .option('-m, --messages <number>', 'Number of messages to show', '10')
  .option('-f, --full', 'Show full conversation (all messages)', false)
  .action(async (sessionId, options) => {
    // Find the session via the backend registry — this works for Claude
    // raw uuids and for prefixed ids ('gemini_<uuid>', 'opencode_<id>',
    // 'codex_<id>') alike.
    const backend = getBackendForId(sessionId);
    const located = backend?.findSession(sessionId);
    if (!backend || !located) {
      console.error(chalk.red('Session not found:'), sessionId);
      process.exit(1);
    }
    if (located.format !== 'jsonl') {
      console.error(chalk.red('CLI `show` only renders JSONL transcripts.'));
      console.error(chalk.dim(`This session uses '${located.format}' format. Use the MCP server's recall_show instead.`));
      process.exit(1);
    }
    const sessionFile: string = located.path;

    console.log(chalk.bold('Session:'), sessionId);
    console.log(chalk.dim('File:'), sessionFile);
    console.log();
    
    interface Message {
      line: number;
      role: 'user' | 'assistant' | 'summary';
      text: string;
    }
    
    // Parse messages
    const messagesList: Message[] = [];
    const lines = readFileSync(sessionFile, 'utf-8').split('\n');
    
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];
      if (!line.trim()) continue;
      
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const msgType = obj.type as string;
        
        if (msgType === 'user') {
          const msg = obj.message as Record<string, unknown>;
          if (msg && typeof msg === 'object') {
            const content = msg.content;
            let text = '';
            
            if (typeof content === 'string') {
              text = content;
            } else if (Array.isArray(content)) {
              const textParts: string[] = [];
              for (const item of content) {
                if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text') {
                  textParts.push((item as Record<string, unknown>).text as string || '');
                }
              }
              text = textParts.join('\n');
            }
            
            if (text && !text.includes('<system-reminder>')) {
              messagesList.push({
                line: lineNum + 1,
                role: 'user',
                text,
              });
            }
          }
        } else if (msgType === 'assistant') {
          const msg = obj.message as Record<string, unknown>;
          if (msg && typeof msg === 'object') {
            const content = msg.content;
            if (Array.isArray(content)) {
              for (const item of content) {
                if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text') {
                  let text = (item as Record<string, unknown>).text as string || '';
                  if (text) {
                    // Remove code blocks for cleaner display
                    text = text.replace(/```[\s\S]*?```/g, '[code block]');
                    messagesList.push({
                      line: lineNum + 1,
                      role: 'assistant',
                      text,
                    });
                    break;
                  }
                }
              }
            } else if (typeof content === 'string') {
              messagesList.push({
                line: lineNum + 1,
                role: 'assistant',
                text: content,
              });
            }
          }
        } else if (msgType === 'summary') {
          const summary = obj.summary as string;
          if (summary) {
            messagesList.push({
              line: lineNum + 1,
              role: 'summary',
              text: summary,
            });
          }
        }
      } catch {
        continue;
      }
    }
    
    if (messagesList.length === 0) {
      console.log(chalk.yellow('No messages found in session.'));
      process.exit(0);
    }
    
    // Filter messages based on options
    let displayMessages = messagesList;
    const maxMessages = parseInt(options.messages, 10);
    const aroundLine = options.line ? parseInt(options.line, 10) : null;
    
    if (aroundLine) {
      const window = Math.floor(maxMessages / 2);
      const filtered = messagesList.filter(msg => Math.abs(msg.line - aroundLine) <= window * 10);
      if (filtered.length > 0) {
        displayMessages = filtered.slice(0, maxMessages);
      } else {
        displayMessages = messagesList.filter(msg => msg.line <= aroundLine + 50).slice(-maxMessages);
      }
    } else if (!options.full) {
      displayMessages = messagesList.slice(0, maxMessages);
    }
    
    // Display messages
    for (const msg of displayMessages) {
      let text = msg.text;
      if (!options.full && text.length > 1000) {
        text = text.slice(0, 1000) + '...';
      }
      
      if (msg.role === 'user') {
        console.log(`${chalk.bold.blue('User')} ${chalk.dim(`(line ${msg.line})`)}`);
      } else if (msg.role === 'assistant') {
        console.log(`${chalk.bold.green('Claude')} ${chalk.dim(`(line ${msg.line})`)}`);
      } else if (msg.role === 'summary') {
        console.log(chalk.bold.yellow('Summary'));
      }
      
      console.log(text);
      console.log();
    }
    
    console.log(chalk.dim(`Showing ${displayMessages.length} messages. Use --full for complete conversation.`));
    console.log(chalk.dim(`Resume: claude --resume ${sessionId}`));
  });

// --- Memory command group ---
const memory = program
  .command('memory')
  .description('Unified memory system - index and search across all data sources');

memory
  .command('index')
  .description('Index all memory sources (plans, tasks, CLAUDE.md, history, paste, sessions)')
  .option('-f, --force', 'Force re-index all items', false)
  .option('-t, --types <types>', 'Comma-separated source types to index (e.g. plan,task)')
  .option('-p, --provider <provider>', 'Embedding provider (ollama or gemini)')
  .action(async (options) => {
    try {
      const provider = (options.provider || process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider;
      let embedder: Awaited<ReturnType<typeof getEmbedder>> | null;
      try {
        embedder = getEmbedder(provider);
        console.log(`Using embedding provider: ${chalk.bold(provider)}`);
      } catch {
        embedder = null;
        console.log(`Using search: ${chalk.bold('FTS5 (full-text)')}`);
      }

      const memoryIndex = await createVectorStore(embedder);
      const memoryStore = await createStore();

      const registry = new SourceRegistry();
      registry.register(new SessionSource());
      registry.register(new PlanSource());
      registry.register(new TaskSource());
      registry.register(new ClaudeMdSource());
      registry.register(new HistorySource());
      registry.register(new PasteSource());
      registry.register(new GeminiSessionSource());
      registry.register(new GeminiBrainSource());
      registry.register(new OpenCodeSource());
      registry.register(new OpenCodeTodoSource());
      registry.register(new CodexSessionSource());
      registry.register(new DiarySource());
      registry.register(new SkillsSource());
      registry.register(new McpsSource());
      registry.register(new SlashCommandsSource());
      registry.register(new SubagentsSource());
      registry.register(new HooksSource());
      registry.register(new PluginsSource());

      const requestedTypes: SourceType[] = options.types
        ? options.types.split(',') as SourceType[]
        : registry.getRegisteredTypes();

      console.log(`Indexing: ${requestedTypes.join(', ')}`);
      if (options.force) console.log('Force mode: re-indexing everything');
      console.log();

      const kgLegacy = await createKnowledgeGraph();
      let totalItems = 0;
      let totalChunks = 0;
      let totalLinks = 0;
      let totalSkipped = 0;
      let totalErrors = 0;

      for (const sourceType of requestedTypes) {
        const source = registry.get(sourceType);
        if (!source) continue;

        console.log(chalk.bold(`--- ${sourceType} ---`));
        let typeItems = 0;

        try {
          for await (const item of source.discover()) {
            try {
              if (!options.force && !(await memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime))) {
                totalSkipped++;
                continue;
              }

              await memoryIndex.deleteItem(item.sourceType, item.id);
              const chunks = await source.parse(item);
              for (const chunk of chunks) {
                const cls = classifyChunk(chunk.text);
                if (cls.memoryType !== 'general') {
                  chunk.chunkType = `${chunk.chunkType}:${cls.memoryType}:imp${cls.importance}`;
                }
                await extractAndPopulateKG(kgLegacy, chunk.text, {
                  projectPath: item.projectPath, sourceType: item.sourceType, sessionId: item.id,
                });
              }

              if (chunks.length > 0) {
                const added = await memoryIndex.addChunks(chunks);
                totalChunks += added;
              }

              await memoryStore.setItem(item);

              const links = await source.extractLinks(item);
              if (links.length > 0) {
                await memoryStore.addLinks(links);
                totalLinks += links.length;
              }

              typeItems++;
              totalItems++;

              let titlePreview = item.title;
              if (titlePreview.length > 60) titlePreview = titlePreview.slice(0, 57) + '...';
              console.log(`  ${titlePreview} (${chunks.length} chunks)`);
            } catch (err) {
              totalErrors++;
              console.error(chalk.yellow(`  Error: ${item.id}: ${err}`));
            }
          }
        } catch (err) {
          totalErrors++;
          console.error(chalk.red(`  Discovery error: ${err}`));
        }

        console.log(chalk.dim(`  => ${typeItems} items`));
        console.log();
      }

      console.log(chalk.green('Memory indexing complete!'));
      console.log(`  Items: ${totalItems} processed, ${totalSkipped} skipped`);
      console.log(`  Chunks: ${totalChunks}`);
      console.log(`  Links: ${totalLinks}`);
      if (totalErrors > 0) console.log(chalk.yellow(`  Errors: ${totalErrors}`));

      await kgLegacy.close();
      await memoryStore.close();
    } catch (err) {
      console.error(chalk.red('Error:'), err);
      process.exit(1);
    }
  });

memory
  .command('search <query>')
  .description('Search across all memory types')
  .option('-n, --top <number>', 'Number of results', '10')
  .option('-t, --types <types>', 'Filter by source types (comma-separated)')
  .option('-p, --project <path>', 'Filter by project path')
  .option('--provider <provider>', 'Embedding provider')
  .action(async (query, options) => {
    try {
      const provider = (options.provider || process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider;
      let embedder: Awaited<ReturnType<typeof getEmbedder>> | null;
      try {
        embedder = getEmbedder(provider);
      } catch {
        embedder = null;
      }
      const memoryIndex = await createVectorStore(embedder);

      const topK = parseInt(options.top, 10);
      const sourceTypes = options.types
        ? options.types.split(',') as SourceType[]
        : undefined;

      const results = await memoryIndex.search(query, {
        topK,
        sourceTypes,
        projectIdFilter: options.project,
      });

      if (results.length === 0) {
        console.log(chalk.yellow('No matching results found.'));
        process.exit(0);
      }

      console.log();
      console.log(`${chalk.bold('Memory search:')} "${query}"`);
      console.log();

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const scorePct = Math.round(r.score * 100);

        const typeColor = ({
          session: chalk.blue,
          plan: chalk.green,
          task: chalk.yellow,
          claude_md: chalk.magenta,
          history: chalk.cyan,
          paste: chalk.gray,
          diary: chalk.redBright,
        } as Record<string, typeof chalk.white>)[r.sourceType] || chalk.white;

        const typeBadge = typeColor(`[${r.sourceType}]`);

        let title = r.title.replace(/\n/g, ' ').trim();
        if (title.length > 70) title = title.slice(0, 67) + '...';

        console.log(`${chalk.bold.cyan(`#${i + 1}`)} ${typeBadge} ${title}`);

        if (r.projectPath) {
          let pp = r.projectPath;
          if (pp.length > 50) pp = '...' + pp.slice(-47);
          console.log(`   ${chalk.dim('Project:')} ${pp}`);
        }

        console.log(`   ${chalk.dim('Score:')} ${scorePct}/100  ${chalk.dim('Type:')} ${r.chunkType}`);

        // Show preview text
        let preview = r.text.replace(/\n/g, ' ').trim();
        if (preview.length > 150) preview = preview.slice(0, 147) + '...';
        console.log(`   ${preview}`);

        if (r.sourceType === 'session') {
          console.log(`   ${chalk.green('Resume:')} claude --resume ${r.itemId}`);
        }

        console.log();
      }
    } catch (err) {
      console.error(chalk.red('Error:'), err);
      process.exit(1);
    }
  });

memory
  .command('status')
  .description('Show memory index statistics across all source types')
  .action(async () => {
    try {
      const dummyEmbedder = {
        embed: async () => [] as number[][],
        embedQuery: async () => [] as number[],
        dimension: 768,
      };

      const memoryIndex = await createVectorStore(dummyEmbedder);
      const memoryStore = await createStore();

      const indexStats = await memoryIndex.getStats();
      const storeStats = await memoryStore.getStats();
      const linkCount = await memoryStore.getLinkCount();

      console.log(chalk.bold('Memory System Status'));
      console.log();
      console.log(`Index path: ${indexStats.indexPath}`);
      console.log(`Total items: ${indexStats.totalItems}`);
      console.log(`Total chunks: ${indexStats.totalChunks}`);
      console.log(`Total links: ${linkCount}`);
      console.log();

      if (Object.keys(indexStats.bySourceType).length > 0) {
        console.log(chalk.bold('Vector index by source type:'));
        for (const [type, data] of Object.entries(indexStats.bySourceType)) {
          console.log(`  ${type}: ${data.items} items, ${data.chunks} chunks`);
        }
        console.log();
      }

      if (Object.keys(storeStats).length > 0) {
        console.log(chalk.bold('Metadata store by source type:'));
        for (const [type, count] of Object.entries(storeStats)) {
          console.log(`  ${type}: ${count} items`);
        }
      }

      await memoryStore.close();
    } catch (err) {
      console.error(chalk.red('Error:'), err);
      process.exit(1);
    }
  });

memory
  .command('links <source_type> <item_id>')
  .description('Show relationships for a memory item')
  .action(async (sourceType: string, itemId: string) => {
    try {
      const memoryStore = await createStore();
      const links = await memoryStore.getAllLinks(sourceType as SourceType, itemId);

      if (links.length === 0) {
        console.log(chalk.yellow('No links found.'));
        await memoryStore.close();
        return;
      }

      console.log(chalk.bold(`Links for ${sourceType}:${itemId}`));
      console.log();

      for (const link of links) {
        const direction = link.source_id === itemId ? '->' : '<-';
        const otherType = link.source_id === itemId ? link.target_type : link.source_type;
        const otherId = link.source_id === itemId ? link.target_id : link.source_id;
        const confidence = Math.round(link.confidence * 100);

        console.log(`  ${direction} ${chalk.bold(otherType)}:${otherId.slice(0, 20)} [${link.link_type}] (${confidence}%)`);
      }

      await memoryStore.close();
    } catch (err) {
      console.error(chalk.red('Error:'), err);
      process.exit(1);
    }
  });

memory
  .command('wake-up')
  .description('Generate wake-up context (high-importance facts + knowledge graph snapshot) for an AI session')
  .option('-s, --session <id>', 'Session ID to focus on')
  .action(async (_options: { session?: string }) => {
    try {
      const { readdirSync, existsSync, readFileSync } = await import('fs');

      // Identity (optional, static)
      const identityFile = getIdentityFilePath();
      let identity = 'AI coding assistant';
      if (existsSync(identityFile)) {
        identity = readFileSync(identityFile, 'utf-8').trim();
      }

      const lines = [
        chalk.bold('# Wake-Up Context'),
        chalk.bold('──────────────────'),
        '',
        chalk.bold('## Identity'),
        identity,
        '',
      ];

      // High-importance facts from FTS5 index (memory classifier output)
      try {
        const store = await createStore();
        const impChunks = await store.searchFTS('decision preference milestone', { topK: 30 });
        const highImp = impChunks
          .filter(r => r.chunkType.includes(':imp4') || r.chunkType.includes(':imp5'))
          .slice(0, 10);

        if (highImp.length > 0) {
          lines.push(chalk.bold('## High-Importance Facts'));
          for (const chunk of highImp) {
            const typeMatch = chunk.chunkType.match(/:(\w+):imp/);
            const memType = typeMatch ? typeMatch[1] : 'fact';
            const text = chunk.text.replace(/\n/g, ' ').trim().slice(0, 150);
            lines.push(`  [${memType}] ${text}`);
          }
          lines.push('');
        }
        await store.close();
      } catch { /* FTS not available */ }

      // Knowledge graph snapshot — current facts only
      try {
        const kgWake = await createKnowledgeGraph();
        const kgStats = await kgWake.stats();
        if (kgStats.current_facts > 0) {
          const timeline = await kgWake.timeline(undefined, 20);
          const currentFacts = timeline.filter(e => e.current);
          if (currentFacts.length > 0) {
            lines.push(chalk.bold('## Knowledge Graph'));
            lines.push(chalk.dim(`${kgStats.entities} entities, ${kgStats.current_facts} current facts`));
            for (const fact of currentFacts.slice(0, 15)) {
              lines.push(`  ${fact.subject} → ${fact.predicate} → ${fact.object}`);
            }
            lines.push('');
          }
        }
        await kgWake.close();
      } catch { /* KG not available */ }

      console.log(lines.join('\n'));
    } catch (err) {
      console.error(chalk.red('Error:'), err);
      process.exit(1);
    }
  });

/**
 * `chat-recall doctor` — single-command health check.
 *
 * Tells the user, at a glance, whether each subsystem is OK. Useful for support
 * questions ("is my install working?") and for the launch demo where we can
 * show a green-row screenshot before doing anything else.
 */
program
  .command('doctor')
  .description('Quick health check across index, embedder, hooks, MCP server, and codeindex')
  .action(async () => {
    const { existsSync, readFileSync, statSync } = await import('fs');
    const { execSync } = await import('child_process');

    type Row = { ok: boolean; label: string; detail?: string };
    const rows: Row[] = [];
    const note = (ok: boolean, label: string, detail?: string) => rows.push({ ok, label, detail });

    // Index
    try {
      const store = await createStore();
      try {
        const items = await store.listItems('session' as SourceType, 1, 0);
        const total = (await store.listItems('session' as SourceType, 5000, 0)).length;
        note(items.length > 0, 'SQLite + FTS5 index', `${total} sessions indexed`);
      } finally { await store.close(); }
    } catch (err) {
      note(false, 'SQLite + FTS5 index', `error: ${err}`);
    }

    // Knowledge graph
    try {
      const kg = await createKnowledgeGraph();
      try {
        const stats = await kg.stats();
        note(stats.entities > 0, 'Knowledge graph', `${stats.entities} entities, ${stats.current_facts} current facts`);
      } finally { await kg.close(); }
    } catch (err) {
      note(false, 'Knowledge graph', `error: ${err}`);
    }

    // Embedder (vector search)
    const embProvider = (process.env.EMBEDDING_PROVIDER || 'ollama') as EmbedderProvider;
    try {
      const embedder = getEmbedder(embProvider);
      try {
        const v = await embedder.embedQuery('healthcheck');
        note(Array.isArray(v) && v.length > 0, `Embedder (${embProvider})`, `dim=${v.length}`);
      } catch (err) {
        note(false, `Embedder (${embProvider})`, `unreachable: ${(err as Error).message}`);
      }
    } catch (err) {
      note(false, `Embedder (${embProvider})`, `not configured: ${(err as Error).message}`);
    }

    // Hooks (Claude-specific)
    const hooksJson = claudeBackend.hooksFile();
    if (!existsSync(hooksJson)) {
      note(false, 'Claude Code hooks', `no ${hooksJson} — run \`chat-recall install-hooks\``);
    } else {
      try {
        const cfg = JSON.parse(readFileSync(hooksJson, 'utf-8'));
        const all = ['Stop', 'PreCompact', 'UserPromptSubmit'];
        const hits: string[] = [];
        for (const ev of all) {
          const arr = Array.isArray(cfg.hooks?.[ev]) ? cfg.hooks[ev] : [];
          if (arr.some((h: any) => (h.hooks?.[0]?.command || '').includes('chat_recall'))) hits.push(ev);
        }
        note(hits.length > 0, 'Claude Code hooks', `installed for: ${hits.join(', ') || 'none — run install-hooks'}`);
      } catch {
        note(false, 'Claude Code hooks', `${hooksJson} unparseable`);
      }
    }

    // MCP server registration
    const mcpJsonPath = join(homedir(), '.mcp.json');
    if (!existsSync(mcpJsonPath)) {
      note(false, 'MCP server registration', `no ${mcpJsonPath} — run \`chat-recall init\``);
    } else {
      try {
        const cfg = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
        const has = !!cfg.mcpServers?.['chat-recall'];
        note(has, 'chat-recall MCP server', has ? `registered in ${mcpJsonPath}` : 'not registered — run `chat-recall init`');
      } catch {
        note(false, 'chat-recall MCP server', `${mcpJsonPath} unparseable`);
      }
    }

    // Codeindex companion
    try {
      const { checkCodeindexStatus } = await import('@chat-recall/engine/core/companions.js');
      const ci = checkCodeindexStatus();
      if (ci.installed) {
        note(true, 'codeindex companion', `${ci.path}${ci.size ? ` · ${(ci.size / 1024 / 1024).toFixed(1)} MB` : ''}`);
      } else {
        note(false, 'codeindex companion', 'not installed (optional — needed for code-level lookup)');
      }
    } catch (err) {
      note(false, 'codeindex companion', `error: ${err}`);
    }

    // Auto-indexer process detection (best effort — looks for the daemon)
    let autoIndexerRunning = false;
    try {
      const out = execSync('pgrep -fc "auto-indexer/indexer" 2>/dev/null || true', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      autoIndexerRunning = parseInt(out, 10) > 0;
    } catch { /* tolerate */ }
    note(autoIndexerRunning, 'Auto-indexer daemon', autoIndexerRunning ? 'running' : 'not running (run `npm run auto-indexer` to enable live indexing)');

    // Render
    console.log(chalk.bold('\nchat-recall doctor\n'));
    for (const r of rows) {
      const icon = r.ok ? chalk.green('✓') : chalk.yellow('•');
      console.log(`  ${icon} ${r.label.padEnd(28)} ${chalk.dim(r.detail || '')}`);
    }
    const failures = rows.filter(r => !r.ok).length;
    console.log();
    if (failures === 0) {
      console.log(chalk.green('All systems green.'));
    } else {
      console.log(chalk.dim(`${failures} item${failures === 1 ? '' : 's'} need attention. None are fatal — chat-recall still works.`));
    }
  });

// Companion-tools subcommands. Currently `codeindex` is the only companion.
// Default is "install when running chat-recall init"; this group lets users
// inspect/manage it after the fact.
const companions = program
  .command('companions')
  .description('Manage companion tools (codeindex)');

companions
  .command('status')
  .description('Show whether codeindex is installed and what it provides')
  .action(async () => {
    const { checkCodeindexStatus } = await import('@chat-recall/engine/core/companions.js');
    const s = checkCodeindexStatus();
    console.log(chalk.bold('codeindex status'));
    if (s.installed) {
      console.log(`  ${chalk.green('✓ installed')}`);
      if (s.path) console.log(`  path:        ${s.path}`);
      if (s.size) console.log(`  size:        ${(s.size / 1024 / 1024).toFixed(1)} MB`);
      if (s.version) console.log(`  version:     ${s.version}`);
    } else {
      console.log(`  ${chalk.yellow('not installed')}`);
      if (!s.prebuiltAvailable) {
        console.log(`  ${chalk.dim(s.unsupportedReason || 'no prebuilt binary for this platform')}`);
      } else {
        console.log(`  ${chalk.dim(`run \`chat-recall companions install\` to fetch ${s.artifactName}`)}`);
      }
    }
    console.log();
    console.log(chalk.dim('codeindex provides code-level lookup as a separate MCP server:'));
    console.log(chalk.dim('  find_symbol, find_callers, get_imports, plan_change,'));
    console.log(chalk.dim('  get_change_impact, analyze (security/dead_code/coupling/cycles/...)'));
  });

companions
  .command('install')
  .description('Install codeindex (downloads from munhq/codeindex GitHub release)')
  .option('--force', 'Re-download even if already installed')
  .action(async (opts: { force?: boolean }) => {
    const { installCodeindex, registerCodeindexMcp, CODEINDEX_BIN_PATH } = await import('@chat-recall/engine/core/companions.js');
    try {
      const result = await installCodeindex({ force: opts.force });
      if (!result.prebuiltAvailable && !result.installed) {
        console.log(chalk.yellow(`codeindex: ${result.unsupportedReason}`));
        console.log(chalk.dim('  Build from source: https://github.com/munhq/codeindex#install'));
        return;
      }
      if (result.installed) {
        const sizeMb = result.size ? `${(result.size / 1024 / 1024).toFixed(1)} MB` : '?';
        console.log(chalk.green(`✓ codeindex installed (${sizeMb}) → ${result.path}`));
        const mcpJsonPath = join(homedir(), '.mcp.json');
        const reg = registerCodeindexMcp(mcpJsonPath, CODEINDEX_BIN_PATH);
        if (reg.added) console.log(chalk.dim(`  Registered as MCP server in ${mcpJsonPath}`));
        else console.log(chalk.dim(`  Already registered as MCP server`));
      }
    } catch (err) {
      const msg = String(err);
      console.error(chalk.red(`codeindex install failed: ${msg}`));
      if (msg.includes('404')) {
        console.error(chalk.dim('  The codeindex release is currently private. Either authenticate `gh`'));
        console.error(chalk.dim('  to munhq/codeindex, or build from source: https://github.com/munhq/codeindex'));
      } else {
        console.error(chalk.dim('  This does not block chat-recall — it just disables code-level lookup.'));
      }
      process.exit(1);
    }
  });

companions
  .command('uninstall')
  .description('Remove the codeindex binary chat-recall installed (does not touch your other tools)')
  .action(async () => {
    const { uninstallCodeindex, unregisterCodeindexMcp } = await import('@chat-recall/engine/core/companions.js');
    const r = uninstallCodeindex();
    if (r.removed) console.log(chalk.green(`✓ Removed ${r.path}`));
    else console.log(chalk.dim(`  Nothing to remove at ${r.path}`));
    const mcpJsonPath = join(homedir(), '.mcp.json');
    const u = unregisterCodeindexMcp(mcpJsonPath);
    if (u.removed) console.log(chalk.dim(`  Unregistered MCP server from ${mcpJsonPath}`));
  });

// ── Team toolkit sync ───────────────────────────────────────────────────
//
// All commands talk to the team-server over HTTP. Config (server URL,
// team id, token env var name) lives in settings.team.*; the bearer
// token itself lives in the env var named by settings.team.tokenRef so
// tokens never land in shell history or settings.json.
const team = program
  .command('team')
  .description('Sync team toolkit (skills, CLAUDE.md, MCPs, agents, commands)');

/** Common error funnel — converts typed client errors to a clean CLI exit. */
async function runTeam(label: string, fn: () => Promise<void>): Promise<void> {
  const { TeamConfigError, TeamAuthError, TeamHttpError } = await import('@chat-recall/engine/core/team-client.js');
  try { await fn(); }
  catch (err) {
    if (err instanceof TeamConfigError) {
      console.error(chalk.red(`${label}: ${err.message}`));
    } else if (err instanceof TeamAuthError) {
      console.error(chalk.red(`${label}: auth failed — ${err.message}`));
      console.error(chalk.dim('  Check the env var named in settings.team.tokenRef holds a valid Keycloak access token.'));
    } else if (err instanceof TeamHttpError) {
      console.error(chalk.red(`${label}: ${err.message}`));
    } else {
      throw err;
    }
    process.exit(1);
  }
}

team
  .command('whoami')
  .description('Show the user + team memberships the server sees for your token')
  .action(async () => runTeam('team whoami', async () => {
    const { teamMe } = await import('@chat-recall/engine/core/team-client.js');
    const me = await teamMe();
    console.log(chalk.bold(me.user.email) + chalk.dim(`  (${me.user.id})`));
    if (me.memberships.length === 0) {
      console.log(chalk.dim('  no team memberships yet — run `chat-recall team create <name>` or `team join <token>`'));
      return;
    }
    for (const m of me.memberships) {
      const role = m.role === 'owner' ? chalk.yellow(m.role) : chalk.dim(m.role);
      console.log(`  ${chalk.cyan(m.teamName)}  ${role}  ${chalk.dim(m.plan)}  ${chalk.dim(m.teamId)}`);
    }
  }));

team
  .command('create <name>')
  .description('Create a new team. You become the owner. Stores teamId in settings.')
  .action(async (name: string) => runTeam('team create', async () => {
    const { teamCreate } = await import('@chat-recall/engine/core/team-client.js');
    const t = await teamCreate(name);
    console.log(chalk.green(`✓ Team created: ${chalk.bold(t.name)}`));
    console.log(chalk.dim(`  id: ${t.id}`));
    console.log(chalk.dim(`  Now generate an invite: chat-recall team invite`));
  }));

team
  .command('invite')
  .description('Generate a single-use invite token for your team (owner-only)')
  .option('--email <hint>', 'Display hint (e.g. teammate@company.com); not validated')
  .action(async (opts: { email?: string }) => runTeam('team invite', async () => {
    const { teamInvite } = await import('@chat-recall/engine/core/team-client.js');
    const r = await teamInvite(opts.email);
    console.log(chalk.bold('Invite token (copy now — shown once):'));
    console.log('  ' + chalk.cyan(r.inviteToken));
    console.log(chalk.dim(`  expires: ${r.expiresAt}`));
    console.log();
    console.log(chalk.dim('Recipient runs:  chat-recall team join <token>'));
  }));

team
  .command('join <invite-token>')
  .description('Accept a team invite. Stores team id locally.')
  .action(async (inviteToken: string) => runTeam('team join', async () => {
    const { teamJoin } = await import('@chat-recall/engine/core/team-client.js');
    const t = await teamJoin(inviteToken);
    console.log(chalk.green(`✓ Joined team: ${chalk.bold(t.name)}`));
    console.log(chalk.dim(`  id: ${t.id}`));
    console.log(chalk.dim('  Run `chat-recall team pull` to fetch the team library.'));
  }));

team
  .command('pull')
  .description('Pull artifacts changed since the last pull and write them into your local ~/.claude/, ~/.gemini/, ~/.codex/ dirs')
  .option('--dry-run', "Fetch but don't write to disk (preview only)")
  .action(async (opts: { dryRun?: boolean }) => runTeam('team pull', async () => {
    const { teamPull } = await import('@chat-recall/engine/core/team-client.js');
    const r = await teamPull();
    if (r.pulled.length === 0 && r.removed.length === 0) {
      console.log(chalk.dim('Up to date.'));
      return;
    }
    for (const a of r.pulled) {
      console.log(`  ${chalk.green('+')} ${chalk.cyan(a.type + '/' + a.name)} v${a.version} ${chalk.dim('(' + a.tool + ')')}`);
    }
    for (const id of r.removed) {
      console.log(`  ${chalk.red('-')} ${chalk.dim(id + ' (revoked)')}`);
    }
    if (opts.dryRun) {
      console.log(chalk.dim(`Watermark: ${r.serverNow}  (dry-run — nothing written)`));
      return;
    }
    const { mergePullResult } = await import('@chat-recall/engine/core/team-merge.js');
    const m = mergePullResult({ pulled: r.pulled, removed: r.removed });
    console.log();
    if (m.written.length)  console.log(chalk.green(`✓ Wrote ${m.written.length} file${m.written.length === 1 ? '' : 's'}`));
    if (m.skipped.length)  console.log(chalk.dim(`  Skipped ${m.skipped.length} (unchanged or no target tool)`));
    if (m.removed.length)  console.log(chalk.yellow(`  Removed ${m.removed.length} revoked file${m.removed.length === 1 ? '' : 's'}`));
    for (const f of m.failures) {
      console.log(chalk.red(`  ! ${f.path}: ${f.error}`));
    }
    console.log(chalk.dim(`Watermark: ${r.serverNow}`));
  }));

team
  .command('publish <type> <name> <file>')
  .description('Publish a local file as an artifact (skill|command|agent|mcp|plan|plugin|instructions|hook)')
  .option('--tool <tool>', 'Target tool: claude|gemini|opencode|codex|cross_tool', 'cross_tool')
  .option('--pinned-to <glob>', 'Limit which projects pull this artifact')
  .action(async (type: string, name: string, file: string, opts: { tool: string; pinnedTo?: string }) => runTeam('team publish', async () => {
    const validTypes = ['skill','command','agent','mcp','plan','plugin','instructions','hook'] as const;
    if (!(validTypes as readonly string[]).includes(type)) {
      console.error(chalk.red(`Invalid type: ${type}. Must be one of: ${validTypes.join(', ')}`));
      process.exit(1);
    }
    const validTools = ['claude','gemini','opencode','codex','cross_tool'] as const;
    if (!(validTools as readonly string[]).includes(opts.tool)) {
      console.error(chalk.red(`Invalid tool: ${opts.tool}. Must be one of: ${validTools.join(', ')}`));
      process.exit(1);
    }
    const { readFileSync } = await import('fs');
    const body = readFileSync(file);
    const { teamPublish } = await import('@chat-recall/engine/core/team-client.js');
    const a = await teamPublish({
      type: type as any, tool: opts.tool as any, name, body, pinnedTo: opts.pinnedTo,
    });
    console.log(chalk.green(`✓ Published ${chalk.bold(type + '/' + name)} v${a.version}`));
    console.log(chalk.dim(`  id: ${a.id}`));
    console.log(chalk.dim(`  sha256: ${a.sha256}`));
  }));

team
  .command('list')
  .description('List artifacts in the team library (metadata only, no bodies)')
  .action(async () => runTeam('team list', async () => {
    const { teamList } = await import('@chat-recall/engine/core/team-client.js');
    const items = await teamList();
    if (items.length === 0) {
      console.log(chalk.dim('Library is empty. Try `chat-recall team publish <type> <name> <file>`.'));
      return;
    }
    for (const a of items) {
      const pinned = a.pinnedTo ? chalk.dim(` pinned=${a.pinnedTo}`) : '';
      console.log(`  ${chalk.cyan(a.type + '/' + a.name)} v${a.version} ${chalk.dim('(' + a.tool + ', ' + a.bytes + ' bytes)')}${pinned}`);
    }
  }));

team
  .command('revoke <artifact-id>')
  .alias('unpublish')
  .description('Revoke an artifact from the team library (owner-only)')
  .action(async (artifactId: string) => runTeam('team revoke', async () => {
    const { teamRevoke } = await import('@chat-recall/engine/core/team-client.js');
    const r = await teamRevoke(artifactId);
    console.log(chalk.green(`✓ Revoked ${chalk.bold(r.type + '/' + r.name)} (${r.id})`));
  }));

team
  .command('leave')
  .description('Clear local team config (does not delete pulled artifacts; does not remove your server-side membership)')
  .action(async () => runTeam('team leave', async () => {
    const { teamLeave } = await import('@chat-recall/engine/core/team-client.js');
    await teamLeave();
    console.log(chalk.green('✓ Local team config cleared.'));
    console.log(chalk.dim('  Server-side membership unchanged. Owner must remove you to fully leave.'));
  }));

// ── Vault: encrypted multi-device chat backup ──────────────────────────
//
// E2EE: passphrase → Argon2id → master key (32 bytes), used to
// XChaCha20-Poly1305 encrypt each chat session as a blob. Server holds
// ciphertext + integrity hash; cannot decrypt. Multi-device parity
// requires the same passphrase on each device.
const vault = program
  .command('vault')
  .description('Encrypted multi-device chat backup (E2EE — server cannot decrypt)');

async function runVault(label: string, fn: () => Promise<void>): Promise<void> {
  const { VaultConfigError, VaultAuthError, VaultHttpError } = await import('@chat-recall/engine/core/vault-client.js');
  try { await fn(); }
  catch (err) {
    if (err instanceof VaultConfigError)      console.error(chalk.red(`${label}: ${err.message}`));
    else if (err instanceof VaultAuthError)   console.error(chalk.red(`${label}: auth failed — ${err.message}`));
    else if (err instanceof VaultHttpError)   console.error(chalk.red(`${label}: ${err.message}`));
    else throw err;
    process.exit(1);
  }
}

/** Read passphrase from CLI prompt, env, or `--passphrase` flag. */
async function resolvePassphrase(opts: { passphrase?: string; envVar?: string }): Promise<string> {
  if (opts.passphrase) return opts.passphrase;
  if (opts.envVar) {
    const v = process.env[opts.envVar];
    if (v) return v;
    console.error(chalk.red(`Env var ${opts.envVar} is not set.`));
    process.exit(1);
  }
  // Interactive prompt (silent) — uses readline-sync style by reading stdin
  // with echoing off. Done with built-in node so no extra dep.
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise<string>((resolve) => {
    process.stdout.write('Vault passphrase: ');
    // @ts-expect-error — _writeToOutput is internal but the only way to silence echoing.
    rl._writeToOutput = (s: string) => { if (s.startsWith('\n')) process.stdout.write(s); };
    rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

vault
  .command('enable')
  .description('Set up the Vault on this device. Generates a per-user salt; derives the master key from your passphrase.')
  .option('--passphrase <s>', 'Passphrase (insecure — prefer interactive or --passphrase-env)')
  .option('--passphrase-env <name>', 'Read passphrase from this env var')
  .option('--existing-salt <hex>', 'Reuse a salt from another device (64 hex chars)')
  .action(async (opts: { passphrase?: string; passphraseEnv?: string; existingSalt?: string }) => runVault('vault enable', async () => {
    const passphrase = await resolvePassphrase({ passphrase: opts.passphrase, envVar: opts.passphraseEnv });
    const { vaultEnable } = await import('@chat-recall/engine/core/vault-client.js');
    const r = vaultEnable(passphrase, { existingSaltHex: opts.existingSalt });
    console.log(chalk.green('✓ Vault enabled on this device.'));
    console.log(chalk.dim(`  keyId: ${r.keyId}`));
    console.log(chalk.dim(`  salt:  ${r.saltHex}`));
    console.log();
    console.log(chalk.yellow('To set up another device, run there:'));
    console.log(`  chat-recall vault enable --existing-salt ${r.saltHex}`);
    console.log(chalk.yellow('Then enter the SAME passphrase. Lose the passphrase = lose chat history. There is no recovery.'));
  }));

vault
  .command('sync')
  .description('Walk local chat sources, encrypt new/changed sessions, upload ciphertext to the server')
  .option('--passphrase <s>', 'Passphrase (insecure — prefer interactive or --passphrase-env)')
  .option('--passphrase-env <name>', 'Read passphrase from this env var')
  .action(async (opts: { passphrase?: string; passphraseEnv?: string }) => runVault('vault sync', async () => {
    const passphrase = await resolvePassphrase({ passphrase: opts.passphrase, envVar: opts.passphraseEnv });
    const { vaultSync } = await import('@chat-recall/engine/core/vault-client.js');
    const r = await vaultSync(passphrase);
    if (r.uploaded.length === 0 && r.skipped.length === 0 && r.failures.length === 0) {
      console.log(chalk.dim('No chat sources found.'));
      return;
    }
    if (r.uploaded.length) console.log(chalk.green(`✓ Uploaded ${r.uploaded.length} session${r.uploaded.length === 1 ? '' : 's'}`));
    if (r.skipped.length)  console.log(chalk.dim(`  Skipped ${r.skipped.length} (unchanged or denylisted)`));
    for (const f of r.failures) {
      console.log(chalk.red(`  ! ${f.tool}/${f.sessionId}: ${f.error}`));
    }
  }));

vault
  .command('restore')
  .description('Pull encrypted blobs from the server, decrypt locally, write them where chat-recall can index them')
  .option('--passphrase <s>', 'Passphrase (insecure — prefer interactive or --passphrase-env)')
  .option('--passphrase-env <name>', 'Read passphrase from this env var')
  .option('--since <ms>', 'Only restore blobs uploaded after this ms-epoch (default 0 = all)')
  .action(async (opts: { passphrase?: string; passphraseEnv?: string; since?: string }) => runVault('vault restore', async () => {
    const passphrase = await resolvePassphrase({ passphrase: opts.passphrase, envVar: opts.passphraseEnv });
    const { vaultRestore } = await import('@chat-recall/engine/core/vault-client.js');
    const r = await vaultRestore(passphrase, { since: opts.since ? Number(opts.since) : undefined });
    if (r.restored.length === 0 && r.skipped.length === 0 && r.failures.length === 0) {
      console.log(chalk.dim('No blobs to restore.'));
      return;
    }
    if (r.restored.length) console.log(chalk.green(`✓ Restored ${r.restored.length} session${r.restored.length === 1 ? '' : 's'}`));
    if (r.skipped.length)  console.log(chalk.dim(`  Skipped ${r.skipped.length} (unchanged or different key)`));
    for (const f of r.failures) {
      console.log(chalk.red(`  ! ${f.tool}/${f.sessionId}: ${f.error}`));
    }
  }));

vault
  .command('status')
  .description('Show whether the Vault is enabled, salt fingerprint, last sync time')
  .action(async () => runVault('vault status', async () => {
    const { vaultStatus } = await import('@chat-recall/engine/core/vault-client.js');
    const s = vaultStatus();
    if (!s.enabled) {
      console.log(chalk.dim('Vault: disabled. Run `chat-recall vault enable`.'));
      return;
    }
    console.log(chalk.green('Vault: enabled'));
    console.log(chalk.dim(`  keyId:        ${s.keyId ?? '(unknown — re-enable)'}`));
    console.log(chalk.dim(`  salt:         ${s.saltHex ? s.saltHex.slice(0, 16) + '…' : '(missing)'}`));
    console.log(chalk.dim(`  lastSyncAt:   ${s.lastSyncAt ? new Date(s.lastSyncAt).toISOString() : 'never'}`));
    console.log(chalk.dim(`  syncTools:    ${s.syncTools.join(', ')}`));
    console.log(chalk.dim(`  excludeProj:  ${s.excludeProjects.length ? s.excludeProjects.join(', ') : '(none)'}`));
  }));

program
  .command('install-hooks')
  .description('Install Claude Code hooks (Stop + PreCompact + UserPromptSubmit)')
  .option('--uninstall', 'Remove hooks instead of installing them')
  .option('--no-resume-hint', "Don't install the UserPromptSubmit resume-hint hook")
  .action(async (opts: { uninstall?: boolean; resumeHint?: boolean }) => {
    const { mkdirSync, copyFileSync, chmodSync, existsSync, readFileSync, writeFileSync, statSync } = await import('fs');
    const { fileURLToPath } = await import('url');

    // Locate the bundled hook scripts. When installed via npm the files live
    // at <pkg>/hooks/*.sh; in development they sit next to src/.
    const here = fileURLToPath(new URL('.', import.meta.url));
    const findHook = (name: string) => {
      const candidates = [
        join(here, '..', 'hooks', name),
        join(here, '..', '..', 'hooks', name),
      ];
      return candidates.find(p => existsSync(p));
    };
    const sourceSaveHook = findHook('chat_recall_save_hook.sh');
    const sourceResumeHook = findHook('chat_recall_resume_hook.sh');
    if (!sourceSaveHook) {
      console.error(chalk.red('Could not locate chat_recall_save_hook.sh in the package.'));
      process.exit(1);
    }

    const hooksDir = getHooksDir();
    const installedSaveHook = join(hooksDir, 'chat_recall_save_hook.sh');
    const installedResumeHook = join(hooksDir, 'chat_recall_resume_hook.sh');
    const hooksJson = claudeBackend.hooksFile();

    // Read existing hooks.json or start fresh.
    let config: any = {};
    if (existsSync(hooksJson)) {
      try {
        config = JSON.parse(readFileSync(hooksJson, 'utf-8'));
      } catch (err) {
        console.error(chalk.red(`Could not parse ${hooksJson}: ${err}`));
        console.error(chalk.dim('Fix the file or move it aside before re-running.'));
        process.exit(1);
      }
    }
    if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};

    // Identify our entries by command path. Two scripts now: save + resume.
    const matchesOurs = (h: any) => {
      const cmd = h?.hooks?.[0]?.command;
      return typeof cmd === 'string' && (
        cmd.includes('chat_recall_save_hook.sh') ||
        cmd.includes('chat_recall_resume_hook.sh')
      );
    };

    if (opts.uninstall) {
      let removed = 0;
      for (const event of ['Stop', 'PreCompact', 'UserPromptSubmit']) {
        const arr = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
        const filtered = arr.filter((h: any) => !matchesOurs(h));
        removed += arr.length - filtered.length;
        if (filtered.length) config.hooks[event] = filtered;
        else delete config.hooks[event];
      }
      writeFileSync(hooksJson, JSON.stringify(config, null, 2) + '\n');
      console.log(chalk.green(`✓ Removed ${removed} chat-recall hook entr${removed === 1 ? 'y' : 'ies'} from ${hooksJson}`));
      console.log(chalk.dim(`  (Hook scripts left in ${hooksDir} — delete manually if you want.)`));
      return;
    }

    // Install: copy scripts and merge entries idempotently.
    mkdirSync(hooksDir, { recursive: true });
    copyFileSync(sourceSaveHook, installedSaveHook);
    chmodSync(installedSaveHook, 0o755);

    const installResume = opts.resumeHint !== false && !!sourceResumeHook;
    if (installResume) {
      copyFileSync(sourceResumeHook!, installedResumeHook);
      chmodSync(installedResumeHook, 0o755);
    }

    const stopEntry = { matcher: '', hooks: [{ type: 'command', command: installedSaveHook }] };
    const precompactEntry = { matcher: '', hooks: [{ type: 'command', command: `${installedSaveHook} --precompact` }] };
    const resumeEntry = { matcher: '', hooks: [{ type: 'command', command: installedResumeHook }] };

    const events: Array<[string, any]> = [
      ['Stop', stopEntry],
      ['PreCompact', precompactEntry],
    ];
    if (installResume) events.push(['UserPromptSubmit', resumeEntry]);

    // Always strip our prior UserPromptSubmit entry too — even when reinstalling
    // without the resume hint, so we don't leave orphan registrations behind.
    for (const event of ['Stop', 'PreCompact', 'UserPromptSubmit']) {
      const arr = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
      const without = arr.filter((h: any) => !matchesOurs(h));
      const wanted = events.find(([e]) => e === event);
      if (wanted) without.push(wanted[1]);
      if (without.length) config.hooks[event] = without;
      else delete config.hooks[event];
    }

    writeFileSync(hooksJson, JSON.stringify(config, null, 2) + '\n');
    const saveSz = statSync(installedSaveHook).size;
    console.log(chalk.green(`✓ Installed chat-recall save hook (${saveSz} bytes)`));
    if (installResume) {
      const resumeSz = statSync(installedResumeHook).size;
      console.log(chalk.green(`✓ Installed chat-recall resume-hint hook (${resumeSz} bytes)`));
    }
    console.log(chalk.dim(`  scripts:   ${hooksDir}`));
    console.log(chalk.dim(`  config:    ${hooksJson}`));
    console.log(chalk.dim(`  events:    Stop, PreCompact${installResume ? ', UserPromptSubmit' : ''}`));
    console.log();
    console.log(chalk.dim('Run `chat-recall install-hooks --uninstall` to remove later.'));
    if (!installResume) {
      console.log(chalk.dim('(--no-resume-hint passed — UserPromptSubmit hook skipped)'));
    }
  });

program
  .command('dossier <project>')
  .description('Generate a project dossier (overview/architecture/decisions/etc) as markdown')
  .option('--sessions <n>', 'Max sessions to enumerate', '10')
  .option('--tasks <n>', 'Max open tasks to list', '20')
  .option('--plans <n>', 'Max plans to list', '20')
  .option('--out <file>', 'Write report to this file instead of stdout')
  .action(async (project, options) => {
    const md = await buildProjectDossier(project, {
      recentSessionLimit: Number(options.sessions) || 10,
      taskLimit: Number(options.tasks) || 20,
      planLimit: Number(options.plans) || 20,
    });
    if (options.out) {
      writeFileSync(options.out, md);
      console.log(chalk.green(`Wrote dossier to ${options.out} (${md.length} chars)`));
    } else {
      console.log(md);
    }
  });

program
  .command('project-id <path>')
  .description('Show the resolved project_id for a path (debug helper)')
  .action((path) => {
    const r = resolveProjectId(path);
    console.log(JSON.stringify(r, null, 2));
  });

program
  .command('login <server-url>')
  .description('Log in via Keycloak (device flow) and mint a sync device token → ~/.chat-recall/credentials.json (0600)')
  .option('--token <token>', 'Self-host: skip OIDC and save this device token directly')
  .option('--issuer <url>', 'OIDC issuer (default: munhq realm)')
  .option('--client-id <id>', 'OIDC client id (default: chat-recall-web)')
  .option('--team <slug>', 'Team to mint the device token for (default: your only team)')
  .option('--device-id <id>', 'Device id for this machine (default: hostname)')
  .action(async (serverUrl: string, opts: { token?: string; issuer?: string; clientId?: string; team?: string; deviceId?: string }) => {
    const { saveCredentials } = await import('./sync-client.js');
    const base = serverUrl.replace(/\/+$/, '');

    // Self-host escape hatch: token supplied directly, no OIDC.
    if (opts.token) {
      saveCredentials({ serverUrl, token: opts.token });
      console.log(chalk.green('✓ Logged in.') + chalk.dim(`  server: ${serverUrl}`));
      return;
    }

    try {
      const { deviceLogin } = await import('./device-auth.js');
      const tokens = await deviceLogin({ issuer: opts.issuer, clientId: opts.clientId }, (p) => {
        console.log();
        console.log(chalk.bold('To log in, open:'));
        console.log('  ' + chalk.cyan(p.url));
        console.log(chalk.dim(`  (if prompted, enter code: ${chalk.bold(p.userCode)} at ${p.verificationUri})`));
        console.log(chalk.dim('Waiting for approval…'));
      });

      const authHdr = { authorization: `Bearer ${tokens.accessToken}`, 'content-type': 'application/json' };

      // Which team? Use --team, else the user's sole team; bail with guidance otherwise.
      const me = await fetch(`${base}/api/me`, { headers: authHdr }).then((r) => r.json() as Promise<{ teams: { team_slug: string; name: string }[] }>);
      const teams = me.teams || [];
      let slug = opts.team;
      if (!slug) {
        if (teams.length === 1) slug = teams[0].team_slug;
        else if (teams.length === 0) { console.error(chalk.red('No team yet. Create one:') + ' chat-recall team create <name>, then re-run login.'); process.exit(1); }
        else { console.error(chalk.red('You belong to multiple teams — pass --team <slug>:')); teams.forEach((t) => console.error(`  ${t.team_slug}  ${chalk.dim(t.name)}`)); process.exit(1); }
      }

      // Mint a per-device sync token for that team.
      const deviceId = opts.deviceId || (await import('node:os')).hostname();
      const mint = await fetch(`${base}/api/teams/${encodeURIComponent(slug!)}/tokens`, {
        method: 'POST', headers: authHdr, body: JSON.stringify({ device_id: deviceId }),
      });
      if (!mint.ok) throw new Error(`token mint failed: HTTP ${mint.status} ${await mint.text().catch(() => '')}`);
      const { token } = (await mint.json()) as { token: string };

      saveCredentials({ serverUrl, token });
      console.log(chalk.green(`✓ Logged in to ${chalk.bold(slug!)}`) + chalk.dim(`  (device: ${deviceId})  server: ${serverUrl}`));
      console.log(chalk.dim('Run `chat-recall sync` to push redacted conversations.'));
    } catch (err) {
      console.error(chalk.red('login failed:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('sync')
  .description('Push redacted conversations to the configured server (secrets always masked)')
  .option('--since-hours <n>', 'Only sync sessions modified in the last N hours')
  .option('--limit <n>', 'Max sessions to sync')
  .option('--paths-cleartext', 'Send project paths in cleartext (self-host only; default hashes them)')
  .action(async (opts: { sinceHours?: string; limit?: string; pathsCleartext?: boolean }) => {
    const { syncSessions } = await import('./sync-client.js');
    const sinceMs = opts.sinceHours ? Date.now() - Number(opts.sinceHours) * 3_600_000 : undefined;
    try {
      const r = await syncSessions({
        sinceMs,
        cleartextPaths: !!opts.pathsCleartext,
        limit: opts.limit ? Number(opts.limit) : undefined,
      });
      console.log(chalk.green(`✓ Synced ${r.uploaded} session(s)`) + chalk.dim(` — ${r.skipped} skipped, ${r.redactions} secrets redacted`));
    } catch (err) {
      console.error(chalk.red('sync failed:'), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse();
