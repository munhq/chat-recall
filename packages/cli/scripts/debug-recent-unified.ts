#!/usr/bin/env tsx
import { getRecentSessions } from '@chat-recall/engine/core/context.js';

const all = getRecentSessions(undefined, 200);
const byTool: Record<string, number> = {};
for (const s of all) {
  const t = s.tool || 'claude';
  byTool[t] = (byTool[t] || 0) + 1;
}
console.log('getRecentSessions returned', all.length, 'sessions');
console.log('by tool:', byTool);
console.log('first 3 non-claude:');
for (const s of all.filter((x) => x.tool && x.tool !== 'claude').slice(0, 3)) {
  console.log(' ', s.tool, s.sessionId, '|', s.projectPath, '|', s.firstPrompt.slice(0, 60));
}
