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

import { getEmbedder, type EmbedderProvider } from './core/embedder.js';
import { MemoryIndex } from './core/memory-index.js';
import { MetadataCache } from './core/metadata-cache.js';
import { MemoryStore } from './core/memory-store.js';
import { SourceRegistry } from './core/source-registry.js';
import { SessionSource } from './parsers/session-source.js';
import { PlanSource } from './parsers/plan-source.js';
import { TaskSource } from './parsers/task-source.js';
import { ClaudeMdSource } from './parsers/claude-md-source.js';
import { HistorySource } from './parsers/history-source.js';
import { PasteSource } from './parsers/paste-source.js';
import { GeminiSessionSource } from './parsers/gemini-source.js';
import { GeminiBrainSource } from './parsers/gemini-brain-source.js';
import { OpenCodeSource } from './parsers/opencode-source.js';
import { OpenCodeTodoSource } from './parsers/opencode-todo-source.js';
import { DiarySource } from './parsers/diary-source.js';
import { classifyChunk } from './core/memory-classifier.js';
import { extractAndPopulateKG } from './core/entity-extractor.js';
import { KnowledgeGraph } from './core/knowledge-graph.js';
import type { SourceType } from './types/memory.js';

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
      const memoryIndex = new MemoryIndex(embedder);
      const store = new MemoryStore();
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
      registry.register(new DiarySource());

      const kg = new KnowledgeGraph();
      let totalItems = 0, totalChunks = 0, totalErrors = 0;
      const typeCounts: Record<string, number> = {};

      for (const sourceType of registry.getRegisteredTypes()) {
        const sources = registry.getAll(sourceType);
        if (sources.length === 0) continue;
        let typeItems = 0;
        for (const source of sources) {
          for await (const item of source.discover()) {
            try {
              if (!memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime)) continue;
              await memoryIndex.deleteItem(item.sourceType, item.id);
              const chunks = await source.parse(item);
              for (const chunk of chunks) {
                const cls = classifyChunk(chunk.text);
                if (cls.memoryType !== 'general') {
                  chunk.chunkType = `${chunk.chunkType}:${cls.memoryType}:imp${cls.importance}`;
                }
                extractAndPopulateKG(kg, chunk.text, {
                  projectPath: item.projectPath, sourceType: item.sourceType, sessionId: item.id,
                });
              }
              if (chunks.length > 0) {
                await memoryIndex.bufferChunks(chunks);
                totalChunks += chunks.length;
              }
              store.setItem(item);
              const links = await source.extractLinks(item);
              if (links.length > 0) store.addLinks(links);
              totalItems++;
              typeItems++;
            } catch { totalErrors++; }
          }
        }
        await memoryIndex.flushBuffer();
        if (typeItems > 0) typeCounts[sourceType] = typeItems;
      }
      kg.close();
      store.close();

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
          mcpServers['chat-recall'] = {
            command: 'node',
            args: [join(projectRoot, 'dist', 'mcp.js')],
            alwaysAllow: [
              'recall_search', 'recall_show', 'recall_index', 'recall_status',
              'recall_recent', 'recall_context', 'recall_summary', 'recall_suggest_resume',
              'recall_memory_search', 'recall_memory_status', 'recall_plans', 'recall_tasks',
              'recall_smart_resume', 'recall_project_context', 'recall_weekly_digest',
              'recall_kg_query', 'recall_kg_add', 'recall_kg_invalidate',
              'recall_kg_timeline', 'recall_kg_stats',
              'recall_diary_write', 'recall_diary_read',
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
        } = await import('./core/companions.js');

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
          console.log(chalk.dim('   Or grab the binary from https://github.com/hotmun/codeindex'));
        }
      }
      console.log();

      // Done
      console.log(chalk.green.bold('Setup complete!'));
      console.log();
      console.log('chat-recall MCP tools (34): recall_search, recall_recent, recall_context,');
      console.log('  recall_summary, recall_show, recall_suggest_resume, recall_smart_resume,');
      console.log('  recall_project_context, recall_weekly_digest, recall_status, recall_index,');
      console.log('  recall_memory_search, recall_memory_status, recall_plans, recall_plan_show,');
      console.log('  recall_tasks, recall_kg_query/add/invalidate/timeline/stats,');
      console.log('  recall_diary_write/read, recall_subagent_search, recall_files_touched,');
      console.log('  recall_user_prompts, recall_decision_record, recall_set/get/kv_list,');
      console.log('  recall_analytics_summary, recall_wake_up, recall_similar_sessions,');
      console.log('  recall_session_files');
      // List codeindex's tools too if it's available — detected above.
      if (!skipCodeindex) {
        const { checkCodeindexStatus } = await import('./core/companions.js');
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
      const memoryIndex = new MemoryIndex(embedder);
      const store = new MemoryStore();
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
      registry.register(new DiarySource());

      const kg = new KnowledgeGraph();
      let totalItems = 0, totalSkipped = 0, totalChunks = 0, totalErrors = 0, totalKGTriples = 0;
      for (const sourceType of registry.getRegisteredTypes()) {
        const sources = registry.getAll(sourceType);
        if (sources.length === 0) continue;
        console.log(`Indexing ${sourceType}...`);
        for (const source of sources) {
        for await (const item of source.discover()) {
          try {
            if (!options.force && !memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime)) {
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
              totalKGTriples += extractAndPopulateKG(kg, chunk.text, {
                projectPath: item.projectPath, sourceType: item.sourceType, sessionId: item.id,
              });
            }
            if (chunks.length > 0) {
              await memoryIndex.bufferChunks(chunks);
              totalChunks += chunks.length;
            }
            store.setItem(item);
            const links = await source.extractLinks(item);
            if (links.length > 0) store.addLinks(links);
            totalItems++;
          } catch { totalErrors++; }
        }
        }
        await memoryIndex.flushBuffer();
      }
      kg.close();
      // optimize() removed from auto flows to prevent data corruption
      store.close();

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

      const memoryIndex = new MemoryIndex(embedder);
      const memResults = await memoryIndex.search(query, {
        topK: options.noRank ? topK : topK * 4,
        sourceTypes: ['session'],
        projectFilter: options.project,
      });
      // Transform to legacy format
      const cache = new MetadataCache();
      const results = memResults.map(r => {
        const cached = cache.get(r.itemId);
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
      cache.close();
      
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
    const indexPath = MemoryIndex.DEFAULT_INDEX_PATH;

    if (!existsSync(indexPath)) {
      console.log(chalk.yellow('Index not found.'));
      console.log(`Expected at: ${indexPath}`);
      console.log('\nRun', chalk.bold('node dist/cli.js index'), 'to build the index.');
      process.exit(0);
    }

    try {
      const dummyEmbedder = { embed: async () => [], embedQuery: async () => [], dimension: 768 };
      const memoryIndex = new MemoryIndex(dummyEmbedder as any);
      const stats = await memoryIndex.getStats();
      const store = new MemoryStore();
      const linkCount = store.getLinkCount();
      const ftsCount = store.getFTSCount();
      store.close();

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
      const { MemoryIndex } = await import('./core/memory-index.js');
      const embedder = {
        embed: async () => [],
        embedQuery: async () => [],
        dimension: 768,
      };
      const index = new MemoryIndex(embedder as any);

      console.log(chalk.bold('Optimizing LanceDB index...'));
      console.log('This compacts data files and removes old versions/transactions.');
      console.log();

      const stats = await index.optimize();
      console.log(chalk.green('Done!'));
      console.log(`  Compacted fragments: ${stats.compactedFragments}`);
      console.log(`  Pruned old versions: ${stats.prunedFiles}`);
      console.log();
      console.log('Run', chalk.bold('du -sh ~/.claude/chat-recall-index/'), 'to check the new size.');
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
    // Find the session file
    const claudeDir = join(homedir(), '.claude', 'projects');
    let sessionFile: string | null = null;
    
    try {
      const entries = readdirSync(claudeDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = join(claudeDir, entry.name, `${sessionId}.jsonl`);
        if (existsSync(candidate)) {
          sessionFile = candidate;
          break;
        }
      }
    } catch {
      console.error(chalk.red('Session not found:'), sessionId);
      process.exit(1);
    }
    
    if (!sessionFile) {
      console.error(chalk.red('Session not found:'), sessionId);
      process.exit(1);
    }
    
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

      const memoryIndex = new MemoryIndex(embedder);
      const memoryStore = new MemoryStore();

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
      registry.register(new DiarySource());

      const requestedTypes: SourceType[] = options.types
        ? options.types.split(',') as SourceType[]
        : registry.getRegisteredTypes();

      console.log(`Indexing: ${requestedTypes.join(', ')}`);
      if (options.force) console.log('Force mode: re-indexing everything');
      console.log();

      const kgLegacy = new KnowledgeGraph();
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
              if (!options.force && !memoryIndex.needsUpdate(item.sourceType, item.id, item.mtime)) {
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
                extractAndPopulateKG(kgLegacy, chunk.text, {
                  projectPath: item.projectPath, sourceType: item.sourceType, sessionId: item.id,
                });
              }

              if (chunks.length > 0) {
                const added = await memoryIndex.addChunks(chunks);
                totalChunks += added;
              }

              memoryStore.setItem(item);

              const links = await source.extractLinks(item);
              if (links.length > 0) {
                memoryStore.addLinks(links);
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

      kgLegacy.close();
      memoryStore.close();
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
      const memoryIndex = new MemoryIndex(embedder);

      const topK = parseInt(options.top, 10);
      const sourceTypes = options.types
        ? options.types.split(',') as SourceType[]
        : undefined;

      const results = await memoryIndex.search(query, {
        topK,
        sourceTypes,
        projectFilter: options.project,
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

      const memoryIndex = new MemoryIndex(dummyEmbedder);
      const memoryStore = new MemoryStore();

      const indexStats = await memoryIndex.getStats();
      const storeStats = memoryStore.getStats();
      const linkCount = memoryStore.getLinkCount();

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

      memoryStore.close();
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
      const memoryStore = new MemoryStore();
      const links = memoryStore.getAllLinks(sourceType as SourceType, itemId);

      if (links.length === 0) {
        console.log(chalk.yellow('No links found.'));
        memoryStore.close();
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

      memoryStore.close();
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
      const { join } = await import('path');
      const { homedir } = await import('os');
      const { readdirSync, existsSync, readFileSync } = await import('fs');

      // Identity (optional, static)
      const identityFile = join(homedir(), '.claude', 'chat-recall-identity.txt');
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
        const store = new MemoryStore();
        const impChunks = store.searchFTS('decision preference milestone', { topK: 30 });
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
        store.close();
      } catch { /* FTS not available */ }

      // Knowledge graph snapshot — current facts only
      try {
        const kgWake = new KnowledgeGraph();
        const kgStats = kgWake.stats();
        if (kgStats.current_facts > 0) {
          const timeline = kgWake.timeline(undefined, 20);
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
        kgWake.close();
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
      const store = new MemoryStore();
      try {
        const items = store.listItems('session' as SourceType, 1, 0);
        const total = store.listItems('session' as SourceType, 5000, 0).length;
        note(items.length > 0, 'SQLite + FTS5 index', `${total} sessions indexed`);
      } finally { store.close(); }
    } catch (err) {
      note(false, 'SQLite + FTS5 index', `error: ${err}`);
    }

    // Knowledge graph
    try {
      const kg = new KnowledgeGraph();
      try {
        const stats = kg.stats();
        note(stats.entities > 0, 'Knowledge graph', `${stats.entities} entities, ${stats.current_facts} current facts`);
      } finally { kg.close(); }
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

    // Hooks
    const hooksJson = join(homedir(), '.claude', 'hooks.json');
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
      const { checkCodeindexStatus } = await import('./core/companions.js');
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
    const { checkCodeindexStatus } = await import('./core/companions.js');
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
  .description('Install codeindex (downloads from hotmun/codeindex GitHub release)')
  .option('--force', 'Re-download even if already installed')
  .action(async (opts: { force?: boolean }) => {
    const { installCodeindex, registerCodeindexMcp, CODEINDEX_BIN_PATH } = await import('./core/companions.js');
    try {
      const result = await installCodeindex({ force: opts.force });
      if (!result.prebuiltAvailable && !result.installed) {
        console.log(chalk.yellow(`codeindex: ${result.unsupportedReason}`));
        console.log(chalk.dim('  Build from source: https://github.com/hotmun/codeindex#install'));
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
        console.error(chalk.dim('  to hotmun/codeindex, or build from source: https://github.com/hotmun/codeindex'));
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
    const { uninstallCodeindex, unregisterCodeindexMcp } = await import('./core/companions.js');
    const r = uninstallCodeindex();
    if (r.removed) console.log(chalk.green(`✓ Removed ${r.path}`));
    else console.log(chalk.dim(`  Nothing to remove at ${r.path}`));
    const mcpJsonPath = join(homedir(), '.mcp.json');
    const u = unregisterCodeindexMcp(mcpJsonPath);
    if (u.removed) console.log(chalk.dim(`  Unregistered MCP server from ${mcpJsonPath}`));
  });

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

    const hooksDir = join(homedir(), '.claude', 'chat-recall-hooks');
    const installedSaveHook = join(hooksDir, 'chat_recall_save_hook.sh');
    const installedResumeHook = join(hooksDir, 'chat_recall_resume_hook.sh');
    const hooksJson = join(homedir(), '.claude', 'hooks.json');

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

program.parse();
