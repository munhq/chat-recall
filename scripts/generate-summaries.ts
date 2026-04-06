#!/usr/bin/env tsx
/**
 * Bulk generate summaries for all sessions that don't have them.
 * Uses Gemini CLI to generate high-quality summaries.
 */

import { config } from 'dotenv';
import { homedir } from 'os';
import { join } from 'path';
import { getAllSessions, parseSessionFile } from '../src/parsers/session.js';
import { MetadataCache } from '../src/core/metadata-cache.js';
import { SummaryGenerator } from '../src/core/summary-generator.js';

// Load .env
config({ path: join(process.cwd(), '.env') });

interface GenerateOptions {
  force?: boolean;
  limit?: number;
  provider?: 'gemini-cli' | 'claude' | 'ollama';
  showProgress?: boolean;
}

async function generateSummaries(options: GenerateOptions = {}) {
  const {
    force = false,
    limit = 0,
    provider = process.env.SUMMARY_PROVIDER as any || 'gemini-cli',
    showProgress = true,
  } = options;

  console.log('📝 Bulk Summary Generation');
  console.log(`   Provider: ${provider}`);
  console.log(`   Force: ${force ? 'yes' : 'no'}`);
  if (limit > 0) console.log(`   Limit: ${limit} sessions`);
  console.log();

  // Initialize cache and generator
  const cache = new MetadataCache();
  const generator = new SummaryGenerator({ provider });

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
    if (!force && !cache.needsUpdate(entry.sessionId, entry.fileMtime)) {
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
      cache.set({
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

  // Final stats
  console.log();
  console.log('✅ Summary Generation Complete!');
  console.log(`   Processed: ${processed}`);
  console.log(`   Generated: ${generated}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Errors: ${errors}`);

  const stats = cache.getStats();
  console.log();
  console.log('📊 Cache Stats:');
  console.log(`   Total Sessions: ${stats.totalSessions}`);
  console.log(`   By Source:`);
  for (const [source, count] of Object.entries(stats.bySources)) {
    console.log(`     - ${source}: ${count}`);
  }

  cache.close();
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
  } else if (arg === '--quiet' || arg === '-q') {
    options.showProgress = false;
  }
}

// Run
generateSummaries(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
