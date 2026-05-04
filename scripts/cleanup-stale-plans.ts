import { getCacheDbPath } from '../src/core/paths.js';
#!/usr/bin/env tsx
/**
 * Remove stale plan entries from the database.
 */

import { MemoryStore } from '../src/core/memory-store.js';
import { readdirSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

const dbPath = getCacheDbPath();
console.log(`Using database: ${dbPath}`);
const store = new MemoryStore(dbPath);
const plansDir = join(homedir(), '.claude', 'plans');

// Get all plan files on disk
const diskPlans = new Set(
  readdirSync(plansDir)
    .filter(f => f.endsWith('.md'))
    .map(f => basename(f, '.md'))
);

console.log(`Plans on disk: ${diskPlans.size}`);

// Get all indexed plans
const indexedPlans = store.listItems('plan', 1000, 0);
console.log(`Plans in index: ${indexedPlans.length}`);

// Find and delete stale entries
let deleted = 0;
for (const item of indexedPlans) {
  if (!diskPlans.has(item.id)) {
    console.log(`Deleting stale: ${item.id}`);
    store.deleteItem(item.id, 'plan');  // Note: corrected parameter order
    deleted++;
  }
}

console.log(`\nDeleted ${deleted} stale entries`);
console.log(`Remaining: ${indexedPlans.length - deleted}`);

// Verify deletion
const afterCount = store.listItems('plan', 1000, 0).length;
console.log(`Verified count after deletion: ${afterCount}`);

store.close();
