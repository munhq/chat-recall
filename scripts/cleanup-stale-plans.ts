import { getCacheDbPath } from '../src/core/paths.js';
#!/usr/bin/env tsx
/**
 * Remove stale plan entries from the database.
 */

import { createStore } from '../src/core/store/index.js';
import { claudeBackend } from '../src/core/backends/index.js';
import { readdirSync } from 'fs';
import { basename } from 'path';

const dbPath = getCacheDbPath();
console.log(`Using database: ${dbPath}`);
const store = await createStore({ sqlitePath: dbPath });
const plansDir = claudeBackend.plansDir();

// Get all plan files on disk
const diskPlans = new Set(
  readdirSync(plansDir)
    .filter(f => f.endsWith('.md'))
    .map(f => basename(f, '.md'))
);

console.log(`Plans on disk: ${diskPlans.size}`);

// Get all indexed plans
const indexedPlans = await store.listItems('plan', 1000, 0);
console.log(`Plans in index: ${indexedPlans.length}`);

// Find and delete stale entries
let deleted = 0;
for (const item of indexedPlans) {
  if (!diskPlans.has(item.id)) {
    console.log(`Deleting stale: ${item.id}`);
    await store.deleteItem(item.id, 'plan');  // Note: corrected parameter order
    deleted++;
  }
}

console.log(`\nDeleted ${deleted} stale entries`);
console.log(`Remaining: ${indexedPlans.length - deleted}`);

// Verify deletion
const afterCount = (await store.listItems('plan', 1000, 0)).length;
console.log(`Verified count after deletion: ${afterCount}`);

await store.close();
