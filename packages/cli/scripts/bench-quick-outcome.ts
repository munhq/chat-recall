/**
 * Bench harness for the outcome classification + cache pipeline.
 *
 * Measures:
 *   1. Cold quick classifier (no cache)
 *   2. Warm cache hit (mtime+size match)
 *   3. mtime touched, hash matches (touch case)
 *   4. Real append (hash differs, reclassify)
 *   5. Bulk getMany (the batch endpoint's hot path)
 *
 * Run: `npx tsx scripts/bench-quick-outcome.ts`
 */

import { mkdtempSync, rmSync, writeFileSync, utimesSync, appendFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { quickOutcomeStatus } from '@chat-recall/engine/core/quick-outcome.js';
import { OutcomeCache, fingerprintFile, isFresh } from '@chat-recall/engine/core/outcome-cache.js';
import { claudeBackend } from '@chat-recall/engine/core/backends/index.js';

function bench(label: string, iters: number, fn: () => void): void {
  for (let i = 0; i < Math.min(iters, 3); i++) fn(); // warm V8
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const t1 = performance.now();
  const total = t1 - t0;
  console.log(`${label.padEnd(48)} ${total.toFixed(1).padStart(8)}ms total · ${(total / iters).toFixed(3).padStart(7)}ms/iter`);
}

async function main(): Promise<void> {
  const dir = join(claudeBackend.projectsDir(), '-home-user-code-personal-chat-recall');
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  console.log(`Real sessions found: ${files.length}\n`);

  console.log('=== Quick classifier (no cache) ===');
  bench('quickOutcomeStatus on every session', 1, () => {
    for (const f of files) quickOutcomeStatus(join(dir, f), f.replace('.jsonl', ''));
  });

  console.log('\n=== Cache round-trip (synthetic) ===');
  const tmp = mkdtempSync(join(tmpdir(), 'cr-bench-'));
  const dbPath = join(tmp, 'cache.db');
  const cache = new OutcomeCache(dbPath);

  const synthFile = join(tmp, 'synth.jsonl');
  writeFileSync(synthFile, '{"type":"user","message":{"content":"hi"}}\n'.repeat(50));
  const stat = statSync(synthFile);

  cache.put({
    sessionId: 'synth-1',
    tool: 'claude',
    status: 'completed',
    reason: 'synthetic',
    fileMtime: stat.mtimeMs,
    fileSize: stat.size,
    contentHash: fingerprintFile(synthFile),
    fileCount: 0, linesAdded: 0, linesRemoved: 0, commits: 0,
    isFull: false,
    classifiedAt: Date.now(),
    lastScannedOffset: stat.size,
  });

  bench('cache.get (single id)', 10000, () => { cache.get('synth-1'); });
  bench('isFresh fast-path (mtime+size match)', 100000, () => {
    isFresh(cache.get('synth-1'), stat.mtimeMs, stat.size);
  });
  bench('fingerprintFile (hash last 4KB)', 1000, () => { fingerprintFile(synthFile); });

  console.log('\n=== Touch case (mtime moves, content same) ===');
  utimesSync(synthFile, Date.now() / 1000 - 5, Date.now() / 1000 - 5);
  const stat2 = statSync(synthFile);
  bench('isFresh hash-path on touch (still fresh)', 1000, () => {
    isFresh(cache.get('synth-1'), stat2.mtimeMs, stat2.size, fingerprintFile(synthFile));
  });

  console.log('\n=== Real append (hash differs, reclassify) ===');
  appendFileSync(synthFile, '{"type":"user","message":{"content":"new"}}\n');
  const stat3 = statSync(synthFile);
  bench('full reclassify path (cache miss)', 1000, () => {
    const h = fingerprintFile(synthFile);
    if (!isFresh(cache.get('synth-1'), stat3.mtimeMs, stat3.size, h)) {
      const q = quickOutcomeStatus(synthFile, 'synth-1');
      cache.put({
        sessionId: 'synth-1', tool: 'claude', status: q.status, reason: q.reason,
        fileMtime: stat3.mtimeMs, fileSize: stat3.size, contentHash: h,
        fileCount: 0, linesAdded: 0, linesRemoved: 0, commits: 0,
        isFull: false, classifiedAt: Date.now(), lastScannedOffset: stat3.size,
      });
    }
  });

  console.log('\n=== Bulk lookup (batch endpoint hot path) ===');
  for (let i = 0; i < 200; i++) {
    cache.put({
      sessionId: `bulk-${i}`,
      tool: 'claude', status: 'completed', reason: '',
      fileMtime: i, fileSize: i, contentHash: '', fileCount: 0,
      linesAdded: 0, linesRemoved: 0, commits: 0, isFull: false,
      classifiedAt: Date.now(), lastScannedOffset: 0,
    });
  }
  const ids = Array.from({ length: 200 }, (_, i) => `bulk-${i}`);
  bench('cache.getMany(200 ids) — batch SQL fetch', 100, () => { cache.getMany(ids); });

  cache.close();
  rmSync(tmp, { recursive: true, force: true });
}

main().catch(err => { console.error(err); process.exit(1); });
