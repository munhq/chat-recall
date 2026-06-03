/**
 * One-shot cleanup: delete findings whose underlying matched text is
 * a UUID (Claude/Codex JSONL emits one per turn — they trip
 * Dockerhub/NpmToken/generic-shape detectors). The scanner now
 * filters these at scan time, but the existing rows pre-date that
 * fix.
 *
 * For each finding:
 *   1. Read the raw JSONL line at finding.line
 *   2. Find the preview's last-4 chars in the line
 *   3. If those 4 chars are the tail of a UUID-shaped token, drop it
 */

const fs = require('fs');
const Database = require('/home/user/code/personal/chat-recall/node_modules/better-sqlite3');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const db = new Database('/home/user/.chat-recall/cache.db');

const findings = db.prepare(`
  SELECT sf.id, sf.session_id, sf.line, sf.preview, sf.detector, sf.rule, m.file_path
  FROM secret_findings sf
  LEFT JOIN memory_metadata m ON m.id = sf.session_id AND m.source_type='session'
  WHERE m.file_path IS NOT NULL AND m.file_path <> ''
`).all();

console.log(`scanning ${findings.length} findings for UUID-shape false positives...`);

const fileCache = new Map();
function readLine(filePath, lineNum) {
  if (!fileCache.has(filePath)) {
    try { fileCache.set(filePath, fs.readFileSync(filePath, 'utf-8').split('\n')); }
    catch { fileCache.set(filePath, null); }
  }
  const lines = fileCache.get(filePath);
  if (!lines) return null;
  return lines[lineNum - 1] || null;
}

const toDelete = [];
let checked = 0, kept = 0;
for (const f of findings) {
  checked++;
  const line = readLine(f.file_path, f.line);
  if (!line) continue;
  const tail = (f.preview || '').slice(-4);
  if (!tail || tail.length < 4) continue;

  // Find every UUID in the line; check if any ends with the preview tail.
  const uuids = line.match(UUID_RE) || [];
  const matchesUuid = uuids.some(u => u.toLowerCase().endsWith(tail.toLowerCase()));
  if (matchesUuid) {
    toDelete.push(f.id);
  } else {
    kept++;
  }
}

console.log(`  checked: ${checked}`);
console.log(`  UUID false positives: ${toDelete.length}`);
console.log(`  real findings kept: ${kept}`);

if (toDelete.length > 0) {
  const stmt = db.prepare('DELETE FROM secret_findings WHERE id = ?');
  const tx = db.transaction(() => { for (const id of toDelete) stmt.run(id); });
  tx();
  console.log('  deleted.');
}

// Now show the new top-rules picture.
console.log('\nrules by distinct keys (post-dedup):');
const rows = db.prepare(`
  SELECT detector, rule,
         COUNT(DISTINCT preview) AS uniq,
         COUNT(*) AS total,
         COUNT(DISTINCT session_id) AS sessions
  FROM secret_findings
  GROUP BY detector, rule
  ORDER BY uniq DESC LIMIT 15
`).all();
for (const r of rows) {
  console.log(`  ${r.detector.padEnd(11)} ${r.rule.slice(0, 40).padEnd(40)} unique=${String(r.uniq).padStart(4)}  total=${String(r.total).padStart(5)}  sessions=${r.sessions}`);
}
