#!/usr/bin/env tsx
/**
 * Bulk generate summaries for all sessions that don't have them.
 * Uses Gemini CLI to generate high-quality summaries.
 */

import { config } from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import Database from 'better-sqlite3';
import { opencodeBackend } from '@chat-recall/engine/core/backends/index.js';
import { getAllSessions, parseSessionFile } from '@chat-recall/engine/parsers/session.js';
import type { SessionContent } from '@chat-recall/engine/parsers/session.js';
import { createMetadataCache } from '@chat-recall/engine/core/store/caches.js';
import { createStore } from '@chat-recall/engine/core/store/index.js';
import { SummaryGenerator } from '@chat-recall/engine/core/summary-generator.js';
import { stripInjectedBanners } from '@chat-recall/engine/parsers/chunker.js';

// Load .env
config({ path: join(process.cwd(), '.env') });

interface GenerateOptions {
  force?: boolean;
  limit?: number;
  provider?: 'cli' | 'gemini-cli' | 'claude' | 'ollama';
  cliCommand?: string;
  showProgress?: boolean;
}

async function generateSummaries(options: GenerateOptions = {}) {
  const {
    force = false,
    limit = 0,
    provider = process.env.SUMMARY_PROVIDER as any || 'gemini-cli',
    cliCommand,
    showProgress = true,
  } = options;

  console.log('📝 Bulk Summary Generation');
  console.log(`   Provider: ${provider}`);
  if (provider === 'cli') {
    console.log(`   CLI cmd: ${cliCommand || process.env.SUMMARY_CLI_CMD || '(preset: ' + (process.env.SUMMARY_CLI_PRESET || 'unset') + ')'}`);
  }
  console.log(`   Force: ${force ? 'yes' : 'no'}`);
  if (limit > 0) console.log(`   Limit: ${limit} sessions`);
  console.log();

  // Initialize cache and generator
  const cache = await createMetadataCache();
  const generator = new SummaryGenerator({ provider, cliCommand });

  // Get all sessions
  const sessions = Array.from(getAllSessions());
  console.log(`Found ${sessions.length} total sessions`);

  let processed = 0;
  let generated = 0;
  let skipped = 0;
  let errors = 0;

  for (const [entry, filePath] of sessions) {
    if (limit > 0 && processed >= limit) {
      break;
    }

    processed++;

    // Check if we need to process this session
    if (!force && !(await cache.needsUpdate(entry.sessionId, entry.fileMtime))) {
      skipped++;
      if (showProgress && processed % 100 === 0) {
        console.log(`[${processed}/${sessions.length}] Skipped (cached): ${entry.sessionId.substring(0, 8)}...`);
      }
      continue;
    }

    try {
      // Parse session content
      const content = await parseSessionFile(filePath);

      // Determine summary and source
      let summary: string;
      let summarySource: 'original' | 'gemini' | 'claude' | 'ollama';

      // Check if session has meaningful content worth sending to Gemini
      const totalContent = (content.firstPrompt || '').length +
        content.userMessages.reduce((s, m) => s + m.text.length, 0);
      const hasContent = totalContent > 50 || content.userMessages.length >= 2;

      if (!force && content.summaries.length > 0) {
        // Use existing summary (only if not forcing)
        summary = content.summaries[0];
        summarySource = 'original';
        skipped++;
      } else if (!hasContent) {
        // Session is nearly empty - skip Gemini, use firstPrompt directly
        summary = content.firstPrompt?.trim() || 'No content';
        summarySource = 'original';
        skipped++;
      } else {
        // Generate new summary
        if (showProgress) {
          console.log(`[${processed}/${sessions.length}] Generating: ${entry.sessionId.substring(0, 8)}... (${entry.projectPath.replace(homedir(), '~')})`);
        }

        summary = await generator.generate(content);
        summarySource = provider === 'gemini-cli' ? 'gemini' : provider as any;
        generated++;

        if (showProgress) {
          console.log(`   ✅ "${summary.substring(0, 80)}..."`);
        }
      }

      // Save to cache
      await cache.set({
        sessionId: entry.sessionId,
        firstPrompt: content.firstPrompt || entry.firstPrompt,
        summary,
        summarySource,
        mtime: entry.fileMtime,
        indexedAt: Date.now(),
      });
    } catch (error) {
      errors++;
      console.error(`   ❌ Error processing ${entry.sessionId}:`, (error as Error).message);
    }

    // Progress update every 10 sessions
    if (showProgress && processed % 10 === 0) {
      console.log(`Progress: ${processed}/${sessions.length} (${generated} generated, ${skipped} skipped, ${errors} errors)`);
    }
  }

  // --------------------------------------------------------------
  //  Gemini + OpenCode sessions: iterate the unified memory index.
  //  Claude sessions were handled above via the filesystem parser.
  // --------------------------------------------------------------
  console.log();
  console.log('📚 Scanning non-Claude sessions (Gemini / OpenCode)…');
  const store = await createStore();
  let ncProcessed = 0, ncGenerated = 0, ncSkipped = 0, ncErrors = 0;
  try {
    const memItems = await store.listItems('session' as any, 50000, 0);
    for (const item of memItems) {
      if (limit > 0 && ncProcessed >= limit) break;
      let extra: Record<string, any> = {};
      try { extra = JSON.parse(item.extra_json || '{}'); } catch {}
      const tool = extra.tool;
      if (tool !== 'gemini' && tool !== 'opencode') continue;

      ncProcessed++;

      if (!force && !(await cache.needsUpdate(item.id, item.mtime))) {
        ncSkipped++;
        continue;
      }

      try {
        const content = buildNonClaudeSessionContent(tool, item.id, item.file_path, extra);
        if (!content) { ncSkipped++; continue; }

        const totalChars = (content.firstPrompt || '').length +
          content.userMessages.reduce((s, m) => s + m.text.length, 0);
        if (totalChars < 50 && content.userMessages.length < 2) {
          await cache.set({
            sessionId: item.id,
            firstPrompt: content.firstPrompt || item.content_preview || '',
            summary: content.firstPrompt?.trim() || item.title || 'No content',
            summarySource: 'original',
            mtime: item.mtime,
            indexedAt: Date.now(),
          });
          ncSkipped++;
          continue;
        }

        if (showProgress) {
          console.log(`[${ncProcessed}] ${tool} ${item.id.slice(0, 24)}…  (${item.project_path || 'no-project'})`);
        }
        const summary = await generator.generate(content);
        await cache.set({
          sessionId: item.id,
          firstPrompt: content.firstPrompt,
          summary,
          summarySource: (provider === 'gemini-cli' ? 'gemini' : provider) as any,
          mtime: item.mtime,
          indexedAt: Date.now(),
        });
        ncGenerated++;
        if (showProgress) console.log(`   ✅ "${summary.slice(0, 80)}…"`);
      } catch (error) {
        ncErrors++;
        console.error(`   ❌ ${item.id}:`, (error as Error).message);
      }
    }
  } finally {
    await store.close();
  }
  console.log(`   Non-Claude: processed=${ncProcessed} generated=${ncGenerated} skipped=${ncSkipped} errors=${ncErrors}`);

  // Final stats
  console.log();
  console.log('✅ Summary Generation Complete!');
  console.log(`   Processed: ${processed + ncProcessed}`);
  console.log(`   Generated: ${generated + ncGenerated}`);
  console.log(`   Skipped: ${skipped + ncSkipped}`);
  console.log(`   Errors: ${errors + ncErrors}`);

  const stats = await cache.getStats();
  console.log();
  console.log('📊 Cache Stats:');
  console.log(`   Total Sessions: ${stats.totalSessions}`);
  console.log(`   By Source:`);
  for (const [source, count] of Object.entries(stats.bySources)) {
    console.log(`     - ${source}: ${count}`);
  }

  await cache.close();
}

/**
 * Build a minimal SessionContent for a Gemini or OpenCode session by
 * re-reading the raw source (JSON file / SQLite DB). We only populate
 * the fields SummaryGenerator.buildContext actually reads: firstPrompt,
 * userMessages, assistantMessages, toolsUsed.
 */
function buildNonClaudeSessionContent(
  tool: string,
  itemId: string,
  filePath: string,
  extra: Record<string, any>
): SessionContent | null {
  const empty = (): SessionContent => ({
    sessionPath: filePath,
    summaries: [],
    userMessages: [],
    assistantMessages: [],
    toolResults: [],
    toolsUsed: new Set<string>(),
    firstPrompt: '',
    metadata: {} as any,
  });

  if (tool === 'gemini') {
    if (!existsSync(filePath)) return null;
    let raw: any;
    try { raw = JSON.parse(readFileSync(filePath, 'utf-8')); } catch { return null; }
    const messages: any[] = raw.messages || [];
    const getText = (m: any): string => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.map((p: any) => p.text || '').join('\n');
      return '';
    };
    const c = empty();
    for (const m of messages) {
      const text = stripInjectedBanners(getText(m)).trim();
      if (text.length < 10) continue;
      if (m.type === 'user') {
        c.userMessages.push({ text, lineNumber: 0, contentType: 'user' as any });
        if (!c.firstPrompt) c.firstPrompt = text.slice(0, 1000);
      } else if (m.type === 'gemini') {
        c.assistantMessages.push({ text, lineNumber: 0, contentType: 'assistant' as any });
      }
      for (const tc of m.toolCalls || []) {
        const name = tc.name || tc.displayName;
        if (name) c.toolsUsed.add(name);
      }
    }
    return c;
  }

  if (tool === 'opencode') {
    const sessionDbId = opencodeBackend.toRawId(itemId);
    const dbPath = filePath && existsSync(filePath) ? filePath : opencodeBackend.dbPath();
    if (!existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    try {
      const parts = db
        .prepare(
          `SELECT p.data, m.data AS msg_data FROM part p
             JOIN message m ON p.message_id = m.id
            WHERE p.session_id = ?
              AND (p.data LIKE '%"type":"text"%' OR p.data LIKE '%"type":"tool"%')
            ORDER BY p.time_created ASC`
        )
        .all(sessionDbId) as Array<{ data: string; msg_data: string }>;
      const c = empty();
      for (const row of parts) {
        let pd: any, md: any;
        try { pd = JSON.parse(row.data); md = JSON.parse(row.msg_data); } catch { continue; }
        if (pd.type === 'tool') {
          if (pd.tool) c.toolsUsed.add(pd.tool);
          continue;
        }
        const text = stripInjectedBanners(pd.text || '').trim();
        if (text.length < 10) continue;
        if (md.role === 'user') {
          c.userMessages.push({ text, lineNumber: 0, contentType: 'user' as any });
          if (!c.firstPrompt) c.firstPrompt = text.slice(0, 1000);
        } else {
          c.assistantMessages.push({ text, lineNumber: 0, contentType: 'assistant' as any });
        }
      }
      for (const t of extra.toolsUsed || []) c.toolsUsed.add(t);
      return c;
    } finally {
      db.close();
    }
  }

  return null;
}

// Parse command-line args
const args = process.argv.slice(2);
const options: GenerateOptions = {
  showProgress: true,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--force' || arg === '-f') {
    options.force = true;
  } else if (arg === '--limit' || arg === '-l') {
    options.limit = parseInt(args[++i], 10);
  } else if (arg === '--provider' || arg === '-p') {
    options.provider = args[++i] as any;
  } else if (arg === '--cli-cmd') {
    options.cliCommand = args[++i];
    options.provider = 'cli';
  } else if (arg === '--preset') {
    // `--preset opencode` → sets SUMMARY_CLI_PRESET + provider='cli'
    process.env.SUMMARY_CLI_PRESET = args[++i];
    options.provider = 'cli';
  } else if (arg === '--quiet' || arg === '-q') {
    options.showProgress = false;
  }
}

// Run
generateSummaries(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
