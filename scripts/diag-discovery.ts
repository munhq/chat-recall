import { getAllSessions } from '../src/parsers/session.js';

const seen = new Map<string, string>();
let total = 0;
for (const [entry] of getAllSessions()) {
  total++;
  if (entry.projectPath.includes('acme-infrastructure-407') || entry.fullPath.includes('acme-infrastructure-407')) {
    seen.set(entry.sessionId, entry.projectPath);
  }
}
console.log('total sessions yielded:', total);
console.log('PR-407 sessions yielded:', seen.size);
const arr = [...seen.entries()].slice(0, 5);
for (const [id, p] of arr) console.log(' ', id.slice(0, 8), p);
