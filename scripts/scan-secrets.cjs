/**
 * Compare three secret detectors across all indexed sessions.
 *
 *   - gitleaks   (subprocess, regex+entropy, ~200 rules)
 *   - trufflehog (subprocess, regex+verification — verification disabled here)
 *   - secretlint (in-process Node, recommend preset)
 *
 * For each session we materialize the conversation text once, run all
 * three against it, and tally findings keyed by (session_id, tool,
 * rule_id). Stored in `secret_findings` so the UI can later read the
 * same data without re-running.
 *
 * No raw secrets are stored — every finding records the rule and a
 * MASKED preview (last 4 chars) only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const Database = require('/home/user/code/personal/chat-recall/node_modules/better-sqlite3');

const CACHE_DB = '/home/user/.chat-recall/cache.db';
const GITLEAKS = '/home/user/.local/bin/gitleaks';
const TRUFFLEHOG = '/home/user/.local/bin/trufflehog';

function mask(s) {
  if (!s) return '';
  if (s.length <= 4) return '*'.repeat(s.length);
  return '*'.repeat(s.length - 4) + s.slice(-4);
}

async function loadSecretlint() {
  const cfgPath = '/tmp/.secretlintrc.cr.json';
  fs.writeFileSync(cfgPath, JSON.stringify({
    rules: [{ id: '@secretlint/secretlint-rule-preset-recommend' }],
  }));
  const { createEngine } = await import('@secretlint/node');
  return createEngine({ configFilePath: cfgPath, formatter: 'json' });
}

function runGitleaks(filePath) {
  const reportPath = filePath + '.gitleaks.json';
  // gitleaks scans files only — point it at our temp file. `directory`
  // mode walks dirs; `dir` works on a single file too via --no-git.
  const r = spawnSync(GITLEAKS, ['dir', filePath, '--no-banner', '--report-format', 'json', '--report-path', reportPath, '--exit-code', '0'], {
    encoding: 'utf-8',
    timeout: 60_000,
  });
  if (r.status !== 0 && r.status !== 1) return { error: r.stderr?.slice(0, 200) || 'gitleaks failed', findings: [] };
  let findings = [];
  try {
    const txt = fs.readFileSync(reportPath, 'utf-8');
    findings = JSON.parse(txt) || [];
  } catch {}
  try { fs.unlinkSync(reportPath); } catch {}
  return {
    findings: findings.map(f => ({
      rule: f.RuleID || f.Description || 'unknown',
      line: f.StartLine || 0,
      preview: mask(f.Secret || f.Match || ''),
    })),
  };
}

function runTrufflehog(filePath) {
  // Verification is opt-in: pass --verify on the script CLI. When
  // enabled, trufflehog calls the issuing service for each match
  // and returns ONLY findings it could confirm are live.
  const verify = process.argv.includes('--verify');
  const args = verify
    ? ['filesystem', filePath, '--only-verified', '--json']
    : ['filesystem', filePath, '--no-verification', '--json'];
  const r = spawnSync(TRUFFLEHOG, args, {
    encoding: 'utf-8',
    timeout: verify ? 180_000 : 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && !r.stdout) return { error: r.stderr?.slice(0, 200) || 'trufflehog failed', findings: [] };
  const findings = [];
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      findings.push({
        rule: j.DetectorName || 'unknown',
        line: j.SourceMetadata?.Data?.Filesystem?.line || 0,
        preview: mask(j.Raw || ''),
      });
    } catch {}
  }
  return { findings };
}

async function runSecretlint(engine, filePath, content) {
  // executeOnContent returns { ok, output } where output is a string in
  // the configured formatter — we asked for `json`, so parse it.
  const result = await engine.executeOnContent({ content, filePath });
  const findings = [];
  let parsed;
  try { parsed = JSON.parse(result.output || '[]'); } catch { return { findings }; }
  for (const r of parsed || []) {
    for (const m of r.messages || []) {
      const start = m.range?.[0] || 0;
      const end = m.range?.[1] || 0;
      findings.push({
        rule: m.ruleId || m.message || 'unknown',
        line: m.loc?.start?.line || 0,
        preview: mask(content.slice(start, end)),
      });
    }
  }
  return { findings };
}

function getSessionContent(db, sessionId) {
  // Read the raw source file directly. The chunker that feeds FTS
  // strips most content into summaries — running detectors against
  // FTS chunks misses keys that live in raw user messages
  // (e.g. `export AWS_ACCESS_KEY_ID="..."`). For Claude/Codex/Gemini
  // the source is on disk; for OpenCode it lives in a SQLite blob,
  // and we materialize via `getOpenCodeConversation`.
  const row = db
    .prepare("SELECT file_path FROM memory_metadata WHERE id = ? AND source_type='session'")
    .get(sessionId);
  if (row?.file_path) {
    try { return fs.readFileSync(row.file_path, 'utf-8'); } catch { /* file gone */ }
  }
  // OpenCode (SQLite-backed) — pull message + part rows verbatim.
  if (sessionId.startsWith('opencode_')) {
    const ocPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    if (fs.existsSync(ocPath)) {
      try {
        const oc = new Database(ocPath, { readonly: true });
        const realId = sessionId.replace(/^opencode_/, '');
        const parts = oc.prepare("SELECT data FROM part WHERE session_id = ?").all(realId);
        oc.close();
        return parts.map(p => p.data).join('\n');
      } catch { /* fall through */ }
    }
  }
  return '';
}

async function main() {
  const argv = process.argv.slice(2);
  const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : 10;

  const db = new Database(CACHE_DB);
  // Schema for findings — no raw secrets, only masked previews.
  // Unique on (session, detector, rule, line) so re-scans don't pile
  // duplicates (chunker replays / repeated lines previously caused the
  // same finding to be inserted ~3x).
  db.exec(`
    CREATE TABLE IF NOT EXISTS secret_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      detector TEXT NOT NULL,
      rule TEXT NOT NULL,
      line INTEGER,
      preview TEXT,
      scanned_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_secret_findings_session ON secret_findings(session_id);
    CREATE INDEX IF NOT EXISTS idx_secret_findings_detector ON secret_findings(detector);
    CREATE INDEX IF NOT EXISTS idx_secret_findings_rule ON secret_findings(rule);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_secret_findings_unique
      ON secret_findings(session_id, detector, rule, line);
  `);

  const sessions = db.prepare(`SELECT id FROM memory_metadata WHERE source_type='session' ORDER BY mtime DESC LIMIT ?`).all(limit);
  console.log(`scanning ${sessions.length} sessions across 3 detectors...`);

  const engine = await loadSecretlint();
  const insert = db.prepare(`INSERT OR IGNORE INTO secret_findings (session_id, detector, rule, line, preview, scanned_at) VALUES (?, ?, ?, ?, ?, ?)`);
  // Wipe prior runs so totals don't double-count.
  db.prepare('DELETE FROM secret_findings').run();

  const tally = { gitleaks: 0, trufflehog: 0, secretlint: 0 };
  const ruleTally = { gitleaks: {}, trufflehog: {}, secretlint: {} };
  const sessionsWithHits = { gitleaks: new Set(), trufflehog: new Set(), secretlint: new Set() };
  const t0 = Date.now();

  for (const sess of sessions) {
    const content = getSessionContent(db, sess.id);
    if (!content) continue;
    const tmp = path.join(os.tmpdir(), `cr-scan-${sess.id.slice(0, 8)}-${process.pid}.txt`);
    fs.writeFileSync(tmp, content);
    try {
      const [gl, th, sl] = await Promise.all([
        Promise.resolve(runGitleaks(tmp)),
        Promise.resolve(runTrufflehog(tmp)),
        runSecretlint(engine, tmp, content),
      ]);
      const now = Date.now();
      for (const f of gl.findings) {
        insert.run(sess.id, 'gitleaks', f.rule, f.line, f.preview, now);
        tally.gitleaks++;
        ruleTally.gitleaks[f.rule] = (ruleTally.gitleaks[f.rule] || 0) + 1;
        sessionsWithHits.gitleaks.add(sess.id);
      }
      for (const f of th.findings) {
        insert.run(sess.id, 'trufflehog', f.rule, f.line, f.preview, now);
        tally.trufflehog++;
        ruleTally.trufflehog[f.rule] = (ruleTally.trufflehog[f.rule] || 0) + 1;
        sessionsWithHits.trufflehog.add(sess.id);
      }
      for (const f of sl.findings) {
        insert.run(sess.id, 'secretlint', f.rule, f.line, f.preview, now);
        tally.secretlint++;
        ruleTally.secretlint[f.rule] = (ruleTally.secretlint[f.rule] || 0) + 1;
        sessionsWithHits.secretlint.add(sess.id);
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nscanned ${sessions.length} sessions in ${elapsed}s\n`);
  console.log(`Total findings:`);
  console.log(`  gitleaks   ${tally.gitleaks}  across ${sessionsWithHits.gitleaks.size} sessions`);
  console.log(`  trufflehog ${tally.trufflehog}  across ${sessionsWithHits.trufflehog.size} sessions`);
  console.log(`  secretlint ${tally.secretlint}  across ${sessionsWithHits.secretlint.size} sessions`);

  console.log(`\nTop rules per detector:`);
  for (const det of ['gitleaks', 'trufflehog', 'secretlint']) {
    const sorted = Object.entries(ruleTally[det]).sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(`  ${det}:`);
    for (const [r, n] of sorted) console.log(`    ${String(n).padStart(5)}  ${r}`);
  }

  // Overlap analysis: how many sessions are flagged by 2 or 3 detectors?
  const onlyG = [...sessionsWithHits.gitleaks].filter(s => !sessionsWithHits.trufflehog.has(s) && !sessionsWithHits.secretlint.has(s));
  const onlyT = [...sessionsWithHits.trufflehog].filter(s => !sessionsWithHits.gitleaks.has(s) && !sessionsWithHits.secretlint.has(s));
  const onlyS = [...sessionsWithHits.secretlint].filter(s => !sessionsWithHits.gitleaks.has(s) && !sessionsWithHits.trufflehog.has(s));
  const all3 = [...sessionsWithHits.gitleaks].filter(s => sessionsWithHits.trufflehog.has(s) && sessionsWithHits.secretlint.has(s));
  console.log(`\nOverlap (sessions):`);
  console.log(`  flagged by all 3:        ${all3.length}`);
  console.log(`  only gitleaks:           ${onlyG.length}`);
  console.log(`  only trufflehog:         ${onlyT.length}`);
  console.log(`  only secretlint:         ${onlyS.length}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
